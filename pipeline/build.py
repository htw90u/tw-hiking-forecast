"""Build the static data bundle for the web app.

Usage:
    python -m pipeline.build --out site/data [--cache .cache] [--archive archive]
                             [--only stations,grids,...] [--history-days 15]

All sources are CWA open data files from the official public S3 mirror.
"""
from .bootstrap import ensure_requirements

ensure_requirements()

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import sys  # noqa: E402
import traceback  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from . import aloft, forecast, geo, grids, gusts, hydro, wrf as wrfmodel, hazards, lightning, peaks, qpf, qpfacc, qpfweb, rainacc, satellite, shakemap, stations, wind  # noqa: E402
from .fetch import Fetcher, FetchError  # noqa: E402
from .log import Log, TZ, now  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TOPO = ROOT / "site" / "geo" / "towns-10t.json"
# CWA's typhoon wind / 24 h rain / total rain tables carry a copyright notice
# forbidding redistribution without written permission, so they are only built
# when explicitly enabled (--typhoon-tables or TYPHOON_TABLES=1), e.g. for
# private use or after permission has been granted (see docs/TODO.md).
TYPHOON_TABLES_LINK = "https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_NEWS.html"
TASKS = ["stations", "history", "rainacc", "grids", "radar", "qpf", "spots", "peaks", "towns", "gusts", "aloft", "wind", "quakes", "lightning", "wrf", "hydro", "typhoon", "warnings", "satellite"]


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


class Builder:
    def __init__(self, args, log: Log):
        self.args = args
        self.log = log
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.f = Fetcher(Path(args.cache) / "s3", log)
        self.manifest = {"built": now().isoformat(), "tz": TZ.key, "layers": {}, "status": {}}
        # Optional site-wide Thunderforest key for the OpenCycleMap basemap (repository variable
        # THUNDERFOREST_KEY); Thunderforest keys are meant to be used in public web pages.
        tf_key = os.environ.get("THUNDERFOREST_KEY", "").strip()
        if tf_key:
            self.manifest["config"] = {"thunderforestKey": tf_key}
        old = self.out / "manifest.json"
        if old.exists():
            try:
                prev = json.loads(old.read_text(encoding="utf-8"))
                self.manifest["layers"] = prev.get("layers", {})
            except ValueError:
                pass
        self.current_stations = None

    # ------------------------------------------------------------- tasks
    def task_stations(self):
        auto = stations.parse_stations(self.f.get_json("Observation/O-A0001-001.json"), "auto")
        manned = stations.parse_stations(self.f.get_json("Observation/O-A0003-001.json"), "manned")
        rain = stations.parse_stations(self.f.get_json("Observation/O-A0002-001.json"), "rain")
        merged = stations.merge_current(auto, manned, rain)
        self.current_stations = (auto, manned, rain)
        t = max((s.get("t") or "" for s in auto + manned), default=None)
        write_json(self.out / "stations.json", {"time": t, "stations": merged})
        self.manifest["layers"]["stations"] = {"time": t, "count": len(merged)}
        return f"{len(merged)} stations (auto {len(auto)}, manned {len(manned)}, rain {len(rain)})"

    def seed_archive(self, root: Path):
        """Restore monthly archives from the deployed site when the local copy is missing."""
        url = (self.args.archive_seed_url or "").rstrip("/")
        if not url or any(root.glob("????-??.csv.gz")):
            return
        import urllib.request
        try:
            with urllib.request.urlopen(f"{url}/data/manifest.json", timeout=60) as r:
                months = json.loads(r.read().decode("utf-8"))["layers"]["history"]["months"]
        except Exception as e:  # noqa: BLE001
            self.log.warn(f"archive seed: cannot read {url}/data/manifest.json ({e})")
            return
        root.mkdir(parents=True, exist_ok=True)
        for m in months:
            try:
                with urllib.request.urlopen(f"{url}/data/archive/{m}.csv.gz", timeout=120) as r:
                    (root / f"{m}.csv.gz").write_bytes(r.read())
                self.log.info(f"archive seed: restored {m} from {url}")
            except Exception as e:  # noqa: BLE001
                self.log.warn(f"archive seed {m}: {e}")

    def task_history(self):
        self.seed_archive(Path(self.args.archive))
        arc = stations.Archive(Path(self.args.archive))
        cur = now()
        arc.load_recent(cur, days=self.args.hist_days_out + 2)
        cutoff = (cur - timedelta(days=self.args.history_days)).astimezone(TZ)
        listing = self.f.list("history/Observation/")
        wanted = []
        for key, _, _ in listing:
            name = key.rsplit("/", 1)[-1]
            m = re.match(r"(\d{12})\.QPESUMS_(AUTO_STATION|GAUGE)\.10M\.xml$", name)
            if not m or key in arc.processed:
                continue
            # History file names are UTC; gauges are 10-minutely, keep on-the-hour only.
            stamp = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            if stamp.minute != 0 or stamp < cutoff:
                continue
            wanted.append((key, m.group(2)))
        self.log.info(f"history: {len(wanted)} new hourly snapshots to ingest")
        added = 0
        for i in range(0, len(wanted), 24):
            chunk = wanted[i:i + 24]
            files = self.f.get_many([k for k, _ in chunk])
            for key, kind in chunk:
                p = files.get(key)
                if isinstance(p, Exception) or p is None:
                    self.log.warn(f"history {key}: {p}")
                    continue
                try:
                    doc = stations.load_doc(p)
                    recs = stations.parse_stations(doc, "rain" if kind == "GAUGE" else "auto")
                except Exception as e:  # noqa: BLE001
                    self.log.warn(f"history parse {key}: {e}")
                    continue
                arc.add(recs, source=key)
                added += 1
                p.unlink(missing_ok=True)  # raw history snapshots are not needed again
                Path(str(p) + ".etag").unlink(missing_ok=True)
        if self.current_stations:
            for recs in self.current_stations:
                arc.add(recs)
        arc.save()
        self.archive = arc
        n = arc.export_station_files(self.out / "hist", cur, days=self.args.hist_days_out)
        months = arc.months()
        adir = self.out / "archive"
        adir.mkdir(parents=True, exist_ok=True)
        for m in months:
            shutil.copy2(arc.root / f"{m}.csv.gz", adir / f"{m}.csv.gz")
        self.manifest["layers"]["history"] = {"time": cur.isoformat(), "stations": n, "months": months,
                                               "days": self.args.hist_days_out}
        return f"ingested {added} snapshots, {n} station series, months {months}"

    def task_rainacc(self):
        """Accumulated rainfall over 3 h .. 7 days interpolated from rain gauges."""
        if not self.current_stations:
            self.task_stations()
        auto, manned, rain = self.current_stations
        topo = geo.load_topo(TOPO)
        g = qpf.GRID
        land = geo.land_mask(topo, g["lon0"], g["lat0"], g["res"], g["nx"], g["ny"])
        t = max((s.get("t") or "" for s in rain), default=None)
        periods = [{"id": "day", "label": "今日", "meta": "grids/rainday.json"}]
        done = []
        for pid, field, label, hours in rainacc.PERIODS:
            if field:
                pts = [(s["lon"], s["lat"], s[field]) for s in rain if s.get(field) is not None]
            else:
                arc = getattr(self, "archive", None)
                if arc is None:
                    self.log.warn("rainacc 7d: history archive not loaded, skipped")
                    continue
                tot = rainacc.archive_totals(arc.rows, now(), hours)
                loc = {s["id"]: (s["lon"], s["lat"]) for s in rain}
                pts = [(*loc[sid], v) for sid, v in tot.items() if sid in loc]
            if len(pts) < 50:
                self.log.warn(f"rainacc {pid}: only {len(pts)} gauges, skipped")
                continue
            lons, lats, vals = zip(*pts)
            arr = rainacc.idw_grid(lons, lats, vals, land)
            name = f"acc_{pid}"
            grids.write_layer(self.out / "grids", name, {"data": arr, "lon0": g["lon0"], "lat0": g["lat0"], "res": g["res"]},
                              0.1, 0.0, {"label": f"{label}累積雨量（雨量站內插）", "unit": "mm", "time": t,
                                         "gauges": len(pts), "hours": hours, "src": "O-A0002-001"})
            periods.append({"id": pid, "label": label, "meta": f"grids/{name}.json"})
            done.append(f"{pid}({len(pts)})")
        self.manifest["layers"]["rainacc"] = {"time": t, "periods": periods}
        return "periods " + ", ".join(done)

    def task_grids(self):
        done = []
        for name, key, reader, nodata, vmin, scale, offset, label, unit in grids.PRODUCTS:
            try:
                g, t = grids.build_product(self.f.get_json(key), reader, nodata, vmin)
                grids.write_layer(self.out / "grids", name, g, scale, offset,
                                         {"label": label, "unit": unit, "time": t, "src": key.split("/")[-1][:-5]})
                self.manifest["layers"][name] = {"time": t, "meta": f"grids/{name}.json"}
                done.append(f"{name}@{t[11:16] if t else '?'}")
            except Exception as e:  # noqa: BLE001
                self.log.fail(f"grid {name}: {e}")
        return ", ".join(done)

    def task_radar(self):
        """Last hour of radar mosaics (10-minute frames) for animation."""
        listing = [k for k, _, _ in self.f.list("history/Observation/") if k.endswith("compref_mosaic.xml")]
        listing.sort()
        keys = listing[-self.args.radar_frames:]
        frames = []
        files = self.f.get_many(keys, workers=4)
        for key in keys:
            p = files.get(key)
            if isinstance(p, Exception) or p is None:
                self.log.warn(f"radar frame {key}: {p}")
                continue
            doc = stations.load_doc(p)
            ds = doc["cwaopendata"]["dataset"]
            pset = ds["datasetInfo"]["parameterSet"]
            vals = grids.parse_values(ds["contents"]["content"])
            g = grids.make_grid(vals, int(pset["GridDimensionX"]), int(pset["GridDimensionY"]),
                                float(pset["StartPointLongitude"]), float(pset["StartPointLatitude"]),
                                float(pset["GridResolution"]), (-99, -999))
            g = grids.crop(g)
            t = pset["DateTime"]
            name = "radar_" + re.sub(r"\D", "", t)[:12]
            grids.write_layer(self.out / "grids", name, g, 0.1, -100.0,
                              {"label": "雷達回波", "unit": "dBZ", "time": t, "src": "O-A0059-001"})
            frames.append({"time": t, "meta": f"grids/{name}.json"})
        # drop stale frame files
        keep = {Path(fr["meta"]).stem for fr in frames}
        for p in (self.out / "grids").glob("radar_*.*"):
            if p.stem not in keep:
                p.unlink()
        self.manifest["layers"]["radarFrames"] = {"frames": frames}
        return f"{len(frames)} frames"

    def task_qpf(self):
        pts = qpf.boundary_points(TOPO)
        topo = geo.load_topo(TOPO)
        g = qpf.GRID
        land = geo.land_mask(topo, g["lon0"], g["lat0"], g["res"], g["nx"], g["ny"])
        insets = qpf.prepare_insets(topo)
        periods = []
        main_cls, inset_cls, starts, issued = [], {}, [], None
        for i, ds_id in enumerate(qpf.QPF_IDS):
            meta = self.f.get_json(f"Forecast/{ds_id}.json")["cwaopendata"]
            png = self.f.get(f"Forecast/{ds_id}.png").read_bytes()
            r = qpf.process(png, pts, land, insets)
            if r["refit"]:
                self.log.warn(f"QPF {ds_id}: layout changed, re-fitted transform {np.round(r['fit'], 2).tolist()}")
            start = qpf.period_start(meta["Sent"]) + timedelta(hours=12 * i)
            main_cls.append(r["grid"])
            starts.append(start)
            issued = meta["Sent"]
            for iname, ires in r["insets"].items():
                if "grid" in ires:
                    inset_cls.setdefault(iname, []).append(ires["grid"])
            name = f"qpf{i + 1}"
            grid = {"data": r["grid"].astype(np.float32), "lon0": g["lon0"], "lat0": g["lat0"], "res": g["res"]}
            grid["data"][grid["data"] == 0] = np.nan
            classes = [{"lo": 0, "hi": 0.5}] + [{"lo": lo, "hi": hi} for lo, hi in qpf.CLASS_BOUNDS]
            common = {"unit": "mm/12h", "kind": "class", "classes": classes,
                      "start": start.isoformat(), "end": (start + timedelta(hours=12)).isoformat(), "issued": meta["Sent"],
                      "src": ds_id}
            # Outlying islands (drawn in the inset boxes) are written as separate
            # high-resolution grids placed at their real coordinates.
            parts = []
            for iname, ires in r["insets"].items():
                if "error" in ires:
                    self.log.warn(f"QPF {ds_id}: {ires['error']}")
                    continue
                if ires["refit"]:
                    self.log.warn(f"QPF {ds_id}: inset {iname} re-fitted {np.round(ires['fit'], 2).tolist()}")
                ig = insets[iname]["grid"]
                igrid = {"data": ires["grid"].astype(np.float32), "lon0": ig["lon0"], "lat0": ig["lat0"], "res": ig["res"]}
                igrid["data"][igrid["data"] == 0] = np.nan
                pname = f"{name}_{iname}"
                grids.write_layer(self.out / "grids", pname, igrid, 1, 0, {
                    **common, "label": qpf.INSETS[iname]["label"], "fitCost": round(ires["cost"], 3)})
                parts.append(f"grids/{pname}.json")
            grids.write_layer(self.out / "grids", name, grid, 1, 0, {
                **common, "parts": parts,
                "label": f"定量降水預報({'I II III IV'.split()[i]})",
                "cwaColors": [[255, 255, 255]] + [list(c) for c in r["legend"]],
                "title": f"grids/{name}_title.png", "fitCost": round(r["cost"], 1),
            })
            (self.out / "grids" / f"{name}_title.png").write_bytes(r["title_png"])
            periods.append({"meta": f"grids/{name}.json", "start": start.isoformat()})
        self.manifest["layers"]["qpf"] = {"time": periods[0]["start"] if periods else None, "periods": periods}
        acc = self.write_qpf_totals(main_cls, inset_cls, insets, starts, issued)
        n6, src6 = self.write_qpf6_web(pts, land, insets)
        if not n6:
            n6, src6 = self.write_qpf6(), "F-C0041"
        return f"{len(periods)} periods (+{len(qpf.INSETS)} island insets each); totals {acc}; 6h periods {n6} ({src6})"

    def write_qpf6_web(self, pts, land, insets):
        """Daily 6-hour QPF images from the CWA website (times read from the image header)."""
        g = qpf.GRID
        web = Fetcher(Path(self.args.cache) / "cwaweb", self.log, base=qpfweb.WEB_BASE)
        learned_dir = Path(self.args.cache) / "qpf_digits"
        tpl = qpfweb.load_templates(learned_dir)
        cur = now()
        decoded = []
        try:
            for i, key in enumerate(qpfweb.IMAGES_6H):
                png = web.get(key).read_bytes()
                rgba = qpfweb.read_png(png)
                res = qpfweb.decode(rgba, cur, 6, tpl)
                if not qpfweb.confident(res):
                    raise ValueError(f"{key}: header not recognised (err {res['err']:.3f}, margin {res['margin']:.3f})")
                decoded.append((key, png, res))
        except Exception as e:  # noqa: BLE001
            self.log.warn(f"QPF 6h (website): {e}; falling back to open data")
            return 0, None
        issue0, start0 = decoded[0][2]["issue"], decoded[0][2]["start"]
        for k, (key, _, res) in enumerate(decoded):
            if res["issue"] != issue0 or res["start"] != start0 + timedelta(hours=6 * k):
                self.log.warn(f"QPF 6h (website): inconsistent periods at {key}; falling back to open data")
                return 0, None
        if decoded[-1][2]["end"] < cur:
            self.log.warn("QPF 6h (website): images are out of date; falling back to open data")
            return 0, None
        for _, _, res in decoded[:1]:
            new = qpfweb.learn_unknown_digits(res, 6, learned_dir, tpl)
            if new:
                self.log.info(f"QPF 6h: learned digit templates {new}")
        periods = []
        classes = [{"lo": 0, "hi": 0.5}] + [{"lo": lo, "hi": hi} for lo, hi in qpf.CLASS_BOUNDS]
        for k, (key, png, res) in enumerate(decoded):
            r = qpf.process(png, pts, land, insets)
            name = f"qpf6_{k + 1}"
            common = {"unit": "mm/6h", "kind": "class", "classes": classes, "start": res["start"].isoformat(),
                      "end": res["end"].isoformat(), "issued": res["issue"].isoformat(), "license": "cwa-web",
                      "src": "全球資訊網 定量降水預報（逐6小時）", "url": f"{qpfweb.WEB_BASE}/V8/C/P/QPF.html"}
            parts = []
            for iname, ires in r["insets"].items():
                if "grid" not in ires:
                    continue
                ig = insets[iname]["grid"]
                arr = ires["grid"].astype(np.float32)
                arr[arr == 0] = np.nan
                grids.write_layer(self.out / "grids", f"{name}_{iname}", {"data": arr, "lon0": ig["lon0"], "lat0": ig["lat0"],
                                                                         "res": ig["res"]}, 1, 0,
                                  {**common, "label": qpf.INSETS[iname]["label"]})
                parts.append(f"grids/{name}_{iname}.json")
            arr = r["grid"].astype(np.float32)
            arr[arr == 0] = np.nan
            grids.write_layer(self.out / "grids", name, {"data": arr, "lon0": g["lon0"], "lat0": g["lat0"], "res": g["res"]},
                              1, 0, {**common, "parts": parts, "label": f"6小時定量降水預報（第{k + 1}段）",
                                     "title": f"grids/{name}_title.png", "fitCost": round(r["cost"], 1)})
            (self.out / "grids" / f"{name}_title.png").write_bytes(r["title_png"])
            periods.append({"meta": f"grids/{name}.json", "start": res["start"].isoformat(), "end": res["end"].isoformat()})
        for old in (self.out / "grids").glob("qpf6_*"):
            m = re.match(r"qpf6_(\d+)", old.name)
            if m and int(m.group(1)) > len(periods):
                old.unlink()
        self.manifest["layers"]["qpf6"] = {"available": True, "periods": periods, "source": "cwa-web",
                                           "issued": issue0.isoformat()}
        return len(periods), "website"

    def write_qpf_totals(self, main_cls, inset_cls, insets, starts, issued) -> list:
        """24 h / 48 h totals derived by adding CWA's 12-hour QPF periods."""
        g = qpf.GRID
        out = []
        for hours in (24, 48):
            n = hours // 12
            if len(main_cls) < n:
                continue
            name = f"qpfacc{hours}"
            srcs = qpf.QPF_IDS[:n]

            def write(suffix, arr, base, label, extra):
                data = np.where(np.isinf(arr), np.nan, arr).astype(np.float32)
                grids.write_layer(self.out / "grids", f"{name}{suffix}", {"data": data, **base}, 0.1, 0.0, {
                    "label": label, "unit": "mm", "start": starts[0].isoformat(),
                    "end": (starts[0] + timedelta(hours=hours)).isoformat(), "issued": issued,
                    "derived": True, "sources": srcs, "src": "、".join(srcs), **extra})

            sets = {"": [], "_lo": [], "_hi": []}
            for iname, cls_list in inset_cls.items():
                if len(cls_list) < n:
                    continue
                ig = insets[iname]["grid"]
                lo, hi, mid = qpfacc.sum_classes(cls_list[:n])
                base = {"lon0": ig["lon0"], "lat0": ig["lat0"], "res": ig["res"]}
                for suffix, arr in (("", mid), ("_lo", lo), ("_hi", hi)):
                    write(f"{suffix}_{iname}", arr, base, qpf.INSETS[iname]["label"], {})
                    sets[suffix].append(f"grids/{name}{suffix}_{iname}.json")
            lo, hi, mid = qpfacc.sum_classes(main_cls[:n])
            base = {"lon0": g["lon0"], "lat0": g["lat0"], "res": g["res"]}
            write("_lo", lo, base, f"未來{hours}小時累積降水下限", {"parts": sets["_lo"]})
            write("_hi", hi, base, f"未來{hours}小時累積降水上限", {"parts": sets["_hi"], "openAbove": 300})
            write("", mid, base, f"未來{hours}小時累積降水預報（加總）", {
                "parts": sets[""], "range": {"lo": f"grids/{name}_lo.json", "hi": f"grids/{name}_hi.json"},
                "method": "各12小時時段級距中值相加（≥300 mm 級距以 300 計）；範圍為級距下限與上限之和"})
            out.append(hours)
        self.manifest["layers"]["qpfacc"] = {"periods": [
            {"hours": h, "meta": f"grids/qpfacc{h}.json"} for h in out], "issued": issued}
        return out

    def write_qpf6(self) -> int:
        """6-hour QPF grids (F-C0041), published only during land typhoon warnings."""
        periods = []
        cur = now()
        for i in range(1, 9):
            ds_id = f"F-C0041-00{i}"
            try:
                g6 = qpfacc.parse_qpf6(self.f.get_json(f"Forecast/{ds_id}.json"))
            except Exception as e:  # noqa: BLE001
                self.log.warn(f"QPF 6h {ds_id}: {e}")
                continue
            # Stale files stay on the server after a warning ends: keep only current issues.
            if not g6["end"] or datetime.fromisoformat(g6["end"]) < cur or \
                    datetime.fromisoformat(g6["issue"]) < cur - timedelta(hours=18):
                continue
            name = f"qpf6_{i}"
            grids.write_layer(self.out / "grids", name, g6, 0.1, 0.0, {
                "label": f"6小時定量降水預報（颱風警報期間，第{i}段）", "unit": "mm/6h",
                "start": g6["start"], "end": g6["end"], "issued": g6["issue"], "src": ds_id})
            periods.append({"meta": f"grids/{name}.json", "start": g6["start"], "end": g6["end"]})
        keep = {f"qpf6_{p['meta'].split('_')[-1].split('.')[0]}" for p in periods}
        for old in (self.out / "grids").glob("qpf6_*.*"):
            if old.stem not in keep:
                old.unlink()
        self.manifest["layers"]["qpf6"] = {"available": bool(periods), "periods": periods,
                                           "note": "氣象署開放資料僅於陸上颱風警報期間提供6小時定量降水格點預報"}
        return len(periods)

    def task_spots(self):
        r = forecast.build_spots(self.f.get_json, self.out, self.log)
        self.manifest["layers"]["spots"] = {"time": max((v or "" for v in r["issue"].values()), default=None),
                                            "count": r["count"]}
        return f"{r['count']} spots"

    def task_peaks(self):
        n, fresh = peaks.build(self.out, self.log, now(), force=self.args.refresh_peaks)
        self.manifest["layers"]["peaks"] = {"count": n, "source": "OpenStreetMap", "license": "ODbL-1.0"}
        return f"{n} OSM peaks ({'downloaded' if fresh else 'cached, refreshed weekly'})"

    def task_towns(self):
        r = forecast.build_towns(self.f.get_json, self.out, self.log)
        self.manifest["layers"]["towns"] = {"time": r["issue"], "count": r["count"]}
        return f"{r['count']} townships"

    def task_gusts(self):
        r = gusts.build(self.out, self.log, now())
        self.manifest["layers"]["gusts"] = {"time": r["time"], "points": r["points"], "source": "Open-Meteo", "license": "CC BY 4.0"}
        return f"{r['points']} points ({'downloaded' if r['fresh'] else 'cached, refreshed hourly'})"

    def task_wrf(self):
        r = wrfmodel.build(self.out, self.log, lambda key: self.f._request(f"{self.f.base}/{key}")[2], now())
        self.manifest["layers"]["wrf"] = {"time": r["init"], "steps": r["steps"]}
        return f"model run {r['init']}, {r['steps']} steps ({'downloaded' if r['fresh'] else 'unchanged'})"

    def task_hydro(self):
        r = hydro.build(self.out, self.log, now())
        self.manifest["layers"]["hydro"] = {"time": now().isoformat(), "debris": r["debris"], "rivers": r["rivers"], "reservoirs": r["reservoirs"]}
        if r["errors"]:
            raise RuntimeError("; ".join(r["errors"]))
        return f"{r['debris']} debris-flow alerts, {r['rivers']} river stations, {r['reservoirs']} reservoirs"

    def task_aloft(self):
        r = aloft.build(self.out, self.log, now())
        self.manifest["layers"]["aloft"] = {"time": r["time"], "points": r["points"], "source": "Open-Meteo", "license": "CC BY 4.0"}
        return f"{r['points']} mountains ({'downloaded' if r['fresh'] else 'cached, refreshed hourly'})"

    def task_wind(self):
        r = wind.build(self.out)
        self.manifest["layers"]["wind"] = {"time": r["issue"], "start": r["start"], "end": r["end"], "steps": r["times"]}
        return f"{r['towns']} townships, {r['mountains']} mountains x {r['times']} steps; gusts {'yes' if r['gusts'] else 'no'}"

    def task_lightning(self):
        r = lightning.parse_kmz(self.f.get("Observation/O-A0039-001.kmz").read_bytes())
        write_json(self.out / "lightning.json", r)
        self.manifest["layers"]["lightning"] = {"time": r["end"], "start": r["start"], "count": r["count"]}
        return f"{r['count']} strikes {r['start']} ~ {r['end']}"

    def task_quakes(self):
        big = hazards.read_quake_zip(self.f.get("Earthquake/E-A0015-001.zip"), "significant")
        small = hazards.read_quake_zip(self.f.get("Earthquake/E-A0016-001.zip"), "local")
        qs = hazards.merge_quakes(big, small)
        shake_msg = self.attach_shakemap(qs)
        write_json(self.out / "quakes.json", {"quakes": qs})
        self.manifest["layers"]["quakes"] = {"time": qs[0]["time"] if qs else None, "count": len(qs)}
        return f"{len(qs)} reports, latest {qs[0]['time'] if qs else '-'}; shakemap: {shake_msg}"

    def attach_shakemap(self, qs) -> str:
        """Georeference the latest significant-earthquake shakemap and link it to its report."""
        try:
            meta = self.f.get_json("Earthquake/E-A0015-003.json")["cwaopendata"]
            stamp = shakemap.identifier_stamp(meta)
            q = next((q for q in qs if q.get("time") and re.sub(r"\D", "", q["time"])[:12] == stamp), None)
            if q is None:
                return f"no report matches {stamp}"
            topo = geo.load_topo(TOPO)
            g = qpf.GRID
            land = geo.land_mask(topo, g["lon0"], g["lat0"], g["res"], g["nx"], g["ny"])
            r = shakemap.process(self.f.get("Earthquake/E-A0015-003.png").read_bytes(), topo, land)
            if r["refit"]:
                self.log.warn(f"shakemap layout changed, re-fitted {np.round(r['fit'], 2).tolist()}")
            arr = r["grid"].astype(np.float32)
            arr[arr == 0] = np.nan
            name = f"shake_{stamp}"
            for old in (self.out / "grids").glob("shake_*.*"):
                if not old.name.startswith(name):
                    old.unlink()
            classes = [{"lo": i, "hi": i + 1, "label": lv} for i, lv in enumerate(shakemap.LEVELS)]
            grids.write_layer(self.out / "grids", name, {"data": arr, "lon0": g["lon0"], "lat0": g["lat0"], "res": g["res"]},
                              1, 0, {"label": "等震度圖", "unit": "", "kind": "class", "classes": classes, "time": q["time"],
                                     "cwaColors": [list(c) for c in r["legend"]], "src": "E-A0015-003",
                                     "fitCost": round(r["cost"], 2)})
            q["shake"] = f"grids/{name}.json"
            return f"{stamp} (fit cost {r['cost']:.2f})"
        except Exception as e:  # noqa: BLE001
            self.log.warn(f"shakemap: {e}")
            return "failed"

    def task_typhoon(self):
        tcs = hazards.parse_cyclones(self.f.get_json("Warning/W-C0034-005.json"))
        texts = hazards.parse_warning_texts(self.f.get_json("Warning/W-C0033-002.json"))
        ty_texts = [t for t in texts if t.get("ph") and "颱風" in t["ph"]]
        cur = now()
        # A cyclone is "active" when its latest forecast was issued within 24 hours.
        active = []
        for tc in tcs:
            ft = tc["fcst"][0]["t"] if tc["fcst"] else (tc["past"][-1]["t"] if tc["past"] else None)
            if ft and datetime.fromisoformat(ft) > cur - timedelta(hours=24):
                active.append(tc)
        tables = {}
        if ty_texts and self.args.typhoon_tables:
            for key, name, parser in (("wind", "WindTable.xml", hazards.parse_wind_table),
                                      ("rain24", "24hPrecipTable.xml", hazards.parse_precip_table),
                                      ("rainTotal", "AllPrecipTable.xml", hazards.parse_precip_table)):
                try:
                    tbl = parser(self.f.get(f"Forecast/{name}").read_bytes())
                    issue = tbl.get("issue")
                    if issue and datetime.fromisoformat(issue) > cur - timedelta(hours=36):
                        tables[key] = tbl
                except Exception as e:  # noqa: BLE001
                    self.log.warn(f"typhoon table {name}: {e}")
        doc = {"active": bool(active and ty_texts), "cyclones": active, "warnings": ty_texts, "tables": tables,
               "tablesRestricted": not self.args.typhoon_tables, "tablesLink": TYPHOON_TABLES_LINK}
        write_json(self.out / "typhoon.json", doc)
        self.manifest["layers"]["typhoon"] = {"time": ty_texts[0]["issue"] if ty_texts else None,
                                              "active": doc["active"]}
        names = ", ".join(f"{t['cname']}({t['name']})" for t in active) or "none"
        tbl_msg = sorted(tables) if self.args.typhoon_tables else "disabled (copyright notice)"
        return f"active={doc['active']} cyclones: {names}; tables: {tbl_msg}"

    def task_warnings(self):
        counties = hazards.parse_county_warnings(self.f.get_json("Warning/W-C0033-001.json"))
        texts = hazards.parse_warning_texts(self.f.get_json("Warning/W-C0033-002.json"))
        write_json(self.out / "warnings.json", {"counties": counties, "bulletins": texts})
        n = sum(1 for c in counties if c["hazards"])
        self.manifest["layers"]["warnings"] = {"time": texts[0]["issue"] if texts else None, "counties": n}
        return f"{len(texts)} bulletins, {n} counties with hazards"

    def task_satellite(self):
        """Himawari IR / visible as numeric grids (smooth rendering, own colour scales)."""
        layers = {}
        for key, ds_id, conv, scale, offset, label, unit in (
                ("ir", "O-B0056-001", satellite.ir_celsius, 0.1, -120.0, "紅外線雲頂溫度（亮度溫度）", "°C"),
                ("vis", "O-B0055-001", satellite.vis_albedo, 0.001, 0.0, "可見光反照率", "")):
            try:
                meta = self.f.get_json(f"Observation/{ds_id}.json")["cwaopendata"]["dataset"]
                t = meta.get("ObsTime", {}).get("Datetime") or meta.get("DateTime")
                raw, geo_ = satellite.read_geotiff(self.f.get(f"Observation/{ds_id}.gtif.zip").read_bytes())
                arr = satellite.resample(conv(raw), geo_)   # convert first: invalid raw values become NaN, then bilinear
                g = satellite.GRID
                grids.write_layer(self.out / "grids", f"sat_{key}", {"data": arr, "lon0": g["lon0"], "lat0": g["lat0"],
                                                                      "res": g["res"]}, scale, offset,
                                  {"label": label, "unit": unit, "time": t, "src": ds_id})
                layers[key] = {"meta": f"grids/sat_{key}.json", "time": t}
            except Exception as e:  # noqa: BLE001
                self.log.warn(f"satellite {ds_id}: {e}")
        imgs = self.satellite_images()
        self.manifest["layers"]["satellite"] = {"time": (layers.get("ir") or {}).get("time") or (imgs[0]["time"] if imgs else None),
                                                "grids": layers, "images": imgs}
        return f"numeric {sorted(layers)}; fallback images {len(imgs)}"

    def satellite_images(self):
        """Pre-rendered CWA satellite JPEGs (fallback when the numeric data fails)."""
        out = []
        for ds_id, label in (("O-C0042-004", "紅外線(黑白)"), ("O-C0042-008", "可見光"), ("O-C0042-006", "紅外線(色調強化)")):
            meta = self.f.get_json(f"Observation/{ds_id}.json")["cwaopendata"]["dataset"]
            lon = [float(x) for x in meta["GeoInfo"]["LongitudeRange"].split("-")]
            lat = [float(x) for x in meta["GeoInfo"]["LatitudeRange"].split("-")]
            img = Image.open(self.f.get(f"Observation/{ds_id}.jpg")).convert("RGB")
            merc = to_mercator(img, lat[0], lat[1])
            name = f"sat_{ds_id[-3:]}"
            sdir = self.out / "sat"
            sdir.mkdir(parents=True, exist_ok=True)
            merc.save(sdir / f"{name}.jpg", "JPEG", quality=82, optimize=True)
            out.append({"id": name, "label": label, "img": f"sat/{name}.jpg", "bounds": [lon[0], lat[0], lon[1], lat[1]],
                        "time": meta["ObsTime"]["Datetime"], "src": ds_id})
        write_json(self.out / "sat" / "index.json", out)
        return out

    # ------------------------------------------------------------- driver
    def run(self, only):
        for name in TASKS:
            if only and name not in only:
                continue
            t0 = now()
            try:
                msg = getattr(self, f"task_{name}")()
                secs = (now() - t0).total_seconds()
                self.log.ok(f"{name}: {msg} ({secs:.1f}s)")
                self.manifest["status"][name] = {"ok": True, "at": now().isoformat()}
            except (FetchError, Exception) as e:  # noqa: BLE001
                self.log.fail(f"{name}: {e}")
                self.log.info(traceback.format_exc().rstrip())
                self.manifest["status"][name] = {"ok": False, "at": now().isoformat(), "error": str(e)[:300]}
        write_json(self.out / "manifest.json", self.manifest)
        self.log.info(f"downloads: {self.f.downloaded} new, {self.f.reused} unchanged (ETag)")


def to_mercator(img: Image.Image, lat_s: float, lat_n: float) -> Image.Image:
    """Re-project an equirectangular image (rows linear in latitude) to Web Mercator rows."""
    w, h = img.size
    y = lambda la: math.log(math.tan(math.pi / 4 + math.radians(la) / 2))  # noqa: E731
    ys, yn = y(lat_s), y(lat_n)
    rows = np.arange(h) + 0.5
    merc = yn - rows / h * (yn - ys)
    lat = np.degrees(2 * np.arctan(np.exp(merc)) - np.pi / 2)
    src_rows = np.clip(((lat_n - lat) / (lat_n - lat_s) * h).astype(int), 0, h - 1)
    a = np.asarray(img)
    return Image.fromarray(a[src_rows])


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build CWA data bundle for the hiking weather web app")
    ap.add_argument("--out", default=str(ROOT / "site" / "data"))
    ap.add_argument("--cache", default=str(ROOT / ".cache"))
    ap.add_argument("--archive", default=str(ROOT / "archive"))
    ap.add_argument("--logs", default=str(ROOT / "logs"))
    ap.add_argument("--only", default="", help="comma separated subset of: " + ",".join(TASKS))
    ap.add_argument("--history-days", type=int, default=15, help="how far back to ingest S3 history snapshots")
    ap.add_argument("--hist-days-out", type=int, default=31, help="days of hourly history per station file")
    ap.add_argument("--radar-frames", type=int, default=7)
    ap.add_argument("--refresh-peaks", action="store_true", help="download OSM peaks even if the weekly copy is fresh")
    ap.add_argument("--archive-seed-url", default="",
                    help="deployed site URL used to restore data/archive/*.csv.gz when the local archive is empty")
    ap.add_argument("--typhoon-tables", action="store_true",
                    default=os.environ.get("TYPHOON_TABLES", "") in ("1", "true", "yes"),
                    help="include CWA typhoon wind/rain tables (copyrighted; only for private use or with permission)")
    args = ap.parse_args(argv)
    only = [x.strip() for x in args.only.split(",") if x.strip()]
    bad = [x for x in only if x not in TASKS]
    if bad:
        ap.error(f"unknown task(s): {bad}")
    log = Log("build", Path(args.logs))
    log.info(f"output {args.out}; log file {log.path}")
    Builder(args, log).run(only)
    if log.failures:
        log.fail(f"build finished with {len(log.failures)} failure(s)")
    else:
        log.ok("build SUCCESS")
    log.close()
    return 1 if log.failures else 0


if __name__ == "__main__":
    sys.exit(main())
