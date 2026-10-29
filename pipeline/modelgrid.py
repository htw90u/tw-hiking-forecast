"""Global weather models on the public open-data mirrors -> East Asia map grids (6-hour rain, 10 m wind).

Models (all 0.25 degree, no key):
  ecmwf  ECMWF IFS   s3://ecmwf-forecasts   <date>/<hh>z/ifs/0p25/oper/            (CC BY 4.0)
  aifs   ECMWF AIFS  s3://ecmwf-forecasts   <date>/<hh>z/aifs-single/0p25/oper/    (CC BY 4.0, machine-learning model)
  gfs    NOAA GFS    s3://noaa-gfs-bdp-pds  gfs.<date>/<hh>/atmos/                  (public domain)

Only the three fields that are needed are downloaded, by byte range, using each file's index (a few hundred KB per field and step).
Per model and run the output is
  grids/mm_<model>_rain_<hhh>.png/json  rain of the 6 hours ending at forecast hour <hhh> (mm), same 16-bit PNG as the other grids
  mm_<model>_wind.json                  10 m wind components (m/s x 10, integers) at every step on a small grid around Taiwan
"""
import json
import os
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from . import grids

TZ = ZoneInfo("Asia/Taipei")
VERSION = 2                                   # bump when the output changes: the same run is then processed again
STEPS = list(range(6, 241, 6))                # 6-hour rain windows ending at +6 ... +240 h
RAIN_REGION = {"lon": (112.0, 130.0), "lat": (16.0, 34.0)}
WIND_REGION = {"lon": (116.0, 126.0), "lat": (20.0, 28.0)}
RAIN_SCALE = 0.1
TEMP_SCALE, TEMP_OFFSET = 0.1, -60.0               # 2 m temperature, deg C
MSL_SCALE, MSL_OFFSET = 0.1, 900.0                # mean sea level pressure, hPa
UA = "tw-hiking-forecast/1.0 (+https://github.com/htw90u/tw-hiking-forecast)"

MODELS = {
    "ecmwf": {"label": "ECMWF IFS", "cycles": (0, 12), "base": "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
              "license": "ECMWF open data, CC BY 4.0"},
    "aifs": {"label": "ECMWF AIFS", "cycles": (0, 6, 12, 18), "base": "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
             "license": "ECMWF open data, CC BY 4.0"},
    "gfs": {"label": "NOAA GFS", "cycles": (0, 6, 12, 18), "base": "https://noaa-gfs-bdp-pds.s3.amazonaws.com",
            "license": "NOAA, public domain"},
}


def file_url(model: str, init: datetime, step: int) -> str:
    """URL of the data file of one model run and forecast hour (the index sits next to it)."""
    base, d, hh = MODELS[model]["base"], init.strftime("%Y%m%d"), init.strftime("%H")
    if model == "gfs":
        return f"{base}/gfs.{d}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{step:03d}"
    sub = "ifs" if model == "ecmwf" else "aifs-single"
    return f"{base}/{d}/{hh}z/{sub}/0p25/oper/{d}{hh}0000-{step}h-oper-fc.grib2"


def index_url(model: str, init: datetime, step: int) -> str:
    u = file_url(model, init, step)
    return u + ".idx" if model == "gfs" else u[: -len("grib2")] + "index"


def parse_ecmwf_index(text: str) -> dict:
    """{param: (offset, length)} of the surface fields we use from an ECMWF open-data index (one JSON object per line)."""
    out = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if e.get("levtype") == "sfc" and e.get("param") in ("tp", "10u", "10v", "2t", "msl"):
            out[e["param"]] = (int(e["_offset"]), int(e["_length"]))
    return out


def parse_gfs_index(text: str, step: int) -> dict:
    """{param: (offset, length)} from a GFS .idx. The rain wanted is the 6-hour window ending at this step: 'a-b hour acc fcst' with b - a = 6."""
    rows = []
    for line in text.splitlines():
        p = line.split(":")
        if len(p) >= 6:
            rows.append((int(p[1]), p[3], p[4], p[5]))
    out = {}
    for i, (off, name, level, what) in enumerate(rows):
        end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
        length = None if end is None else end - off + 1
        if name == "UGRD" and level == "10 m above ground":
            out["10u"] = (off, length)
        elif name == "VGRD" and level == "10 m above ground":
            out["10v"] = (off, length)
        elif name == "TMP" and level == "2 m above ground":
            out["2t"] = (off, length)
        elif name == "PRMSL" and level == "mean sea level":
            out["msl"] = (off, length)
        elif name == "APCP" and level == "surface" and "acc" in what:
            try:
                a, b = what.split()[0].split("-")
                if int(b) == step and int(b) - int(a) == 6:
                    out["tp"] = (off, length)
            except ValueError:
                pass
    return out


def window_rain(model: str, tp_now, tp_before):
    """6-hour rain (mm) from the model's own accumulation. ECMWF fields run from the start of the run (difference of two steps);
    GFS delivers the 6-hour window directly. IFS gives metres, AIFS kg/m2 (= mm); `tp_*` are already in mm."""
    if model == "gfs" or tp_before is None:
        return np.maximum(tp_now, 0.0)
    return np.maximum(tp_now - tp_before, 0.0)


def latest_init(model: str, now: datetime, exists) -> datetime | None:
    """Most recent run whose last needed step is already published (`exists(url)` -> bool)."""
    cycles = MODELS[model]["cycles"]
    t = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for back in range(0, 36, 1):
        c = t - timedelta(hours=back)
        if c.hour not in cycles:
            continue
        if exists(index_url(model, c, STEPS[-1])):
            return c
    return None


def http_get(url: str, rng: tuple | None = None, retries: int = 6, timeout: int = 90) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if rng:
        off, length = rng
        req.add_header("Range", f"bytes={off}-{'' if length is None else off + length - 1}")
    err = None
    for k in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(2 ** (k + 1))   # 2, 4, 8, 16, 32 s: the open-data buckets answer 503 when asked too fast
    raise RuntimeError(f"{url}: {err}")


def url_exists(url: str) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def read_fields(blobs: dict, open_grib=None):
    """{param: (values array (mm / m/s), lats, lons)} from the downloaded GRIB messages."""
    if open_grib is None:
        import pygrib
        open_grib = pygrib.open
    out = {}
    for param, data in blobs.items():
        fd, tmp = tempfile.mkstemp(suffix=".grib2")
        try:
            with os.fdopen(fd, "wb") as fp:
                fp.write(data)
            g = open_grib(tmp)
            m = g.read(1)[0]
            lat, lon = m.latlons()
            vals = np.ma.filled(m.values, np.nan).astype(np.float64)
            units = str(getattr(m, "units", "")).strip()
            if param == "tp" and units in ("m", "m of water equivalent"):
                vals = vals * 1000.0
            elif param == "2t" and units in ("K", "k"):
                vals = vals - 273.15
            elif param == "msl" and units in ("Pa", "pa"):
                vals = vals / 100.0
            out[param] = (vals, lat[:, 0], lon[0, :])
            g.close()
        finally:
            os.unlink(tmp)
    return out


def _region(lats, lons, region):
    la = (lats >= region["lat"][0] - 1e-6) & (lats <= region["lat"][1] + 1e-6)
    lo = (lons >= region["lon"][0] - 1e-6) & (lons <= region["lon"][1] + 1e-6)
    return np.where(la)[0], np.where(lo)[0]


def crop_grid(vals, lats, lons, region) -> dict:
    """Grid dict for grids.write_layer (row 0 = south) from a global array."""
    rows, cols = _region(lats, lons, region)
    a = vals[np.ix_(rows, cols)]
    la, lo = lats[rows], lons[cols]
    if la[0] > la[-1]:
        a, la = a[::-1], la[::-1]
    return {"data": a, "lon0": float(lo.min()), "lat0": float(la.min()), "res": float(abs(lo[1] - lo[0]))}


def pack_wind(u, v, lats, lons, region) -> tuple:
    """(u ints, v ints, grid info) of the wind field around Taiwan, m/s x 10, rows from the south (lat0 = southern row)."""
    rows, cols = _region(lats, lons, region)
    uu, vv = u[np.ix_(rows, cols)], v[np.ix_(rows, cols)]
    la = lats[rows]
    if la[0] > la[-1]:                       # the files list the north first: store the south row first (like the WRF winds)
        uu, vv, la = uu[::-1], vv[::-1], la[::-1]
    enc = lambda a: [None if not np.isfinite(x) else int(round(float(x) * 10)) for x in a.ravel()]  # noqa: E731
    return enc(uu), enc(vv), {"lat0": float(la.min()), "lon0": float(lons[cols].min()), "res": float(abs(lons[1] - lons[0])),
                              "nx": int(len(cols)), "ny": int(len(rows))}


def build_model(model: str, out_dir: Path, log, now: datetime, steps=None, fetch=http_get, exists=url_exists, open_grib=None) -> dict:
    """Process the latest run of one model; returns the manifest entry. Unchanged when the same run is already there."""
    meta_path = out_dir / f"mm_{model}.json"
    init = latest_init(model, now, exists)
    if init is None:
        raise RuntimeError(f"{model}: no complete run found")
    prev = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else None
    if prev and prev.get("initUTC") == init.isoformat() and prev.get("ver") == VERSION and prev.get("steps") == (steps or STEPS):
        return {**prev, "fresh": False}
    steps = steps or STEPS
    gdir = out_dir / "grids"
    tp_cache = {}

    def field_set(hh, params):
        """{param: (values, lats, lons)} of one forecast hour, downloaded by byte range."""
        idx = fetch(index_url(model, init, hh)).decode("utf-8")
        want = parse_gfs_index(idx, hh) if model == "gfs" else parse_ecmwf_index(idx)
        blobs = {}
        for p in params:
            if p not in want:
                raise RuntimeError(f"{model} +{hh}h: field {p} missing in the index")
            blobs[p] = fetch(file_url(model, init, hh), want[p])
        return read_fields(blobs, open_grib)

    wu, wv, winfo, times, rain, temp, msl = [], [], None, [], [], [], []
    for h in steps:
        cur = field_set(h, ("tp", "10u", "10v", "2t", "msl"))
        tp, lats, lons = cur["tp"]
        if model == "gfs":
            r6 = window_rain(model, tp, None)
        else:
            tp_cache[h] = tp
            if h - 6 not in tp_cache:                       # the running total 6 h earlier (nothing has fallen at the start of the run)
                tp_cache[h - 6] = np.zeros_like(tp) if h - 6 <= 0 else field_set(h - 6, ("tp",))["tp"][0]
            r6 = window_rain(model, tp, tp_cache[h - 6])
            tp_cache.pop(h - 12, None)
        valid = (init + timedelta(hours=h)).astimezone(TZ).isoformat()
        start = (init + timedelta(hours=h - 6)).astimezone(TZ).isoformat()
        grids.write_layer(gdir, f"mm_{model}_rain_{h:03d}", crop_grid(r6, lats, lons, RAIN_REGION), RAIN_SCALE, 0.0,
                          {"src": MODELS[model]["label"], "time": valid, "start": start, "label": f"{MODELS[model]['label']} 6 小時降水預報", "unit": "mm"})
        for key, scale, offset, label, unit, store in (("temp", TEMP_SCALE, TEMP_OFFSET, "2 m 氣溫預報", "°C", temp), ("msl", MSL_SCALE, MSL_OFFSET, "海平面氣壓預報", "hPa", msl)):
            src = cur["2t" if key == "temp" else "msl"][0]
            grids.write_layer(gdir, f"mm_{model}_{key}_{h:03d}", crop_grid(src, lats, lons, RAIN_REGION), scale, offset,
                              {"src": MODELS[model]["label"], "time": valid, "label": f"{MODELS[model]['label']} {label}", "unit": unit})
            store.append({"h": h, "time": valid, "meta": f"grids/mm_{model}_{key}_{h:03d}.json"})
        ui, vi, winfo = pack_wind(cur["10u"][0], cur["10v"][0], lats, lons, WIND_REGION)
        wu.append(ui)
        wv.append(vi)
        times.append(valid)
        rain.append({"h": h, "time": valid, "meta": f"grids/mm_{model}_rain_{h:03d}.json"})
        log.info(f"mm {model}: +{h:03d} h")
    wobj = {"init": init.astimezone(TZ).isoformat(), "grid": winfo, "steps": times, "u": wu, "v": wv, "scale": 0.1}
    (out_dir / f"mm_{model}_wind.json").write_text(json.dumps(wobj, separators=(",", ":")), encoding="utf-8")
    entry = {"model": model, "label": MODELS[model]["label"], "license": MODELS[model]["license"], "init": init.astimezone(TZ).isoformat(),
             "initUTC": init.isoformat(), "ver": VERSION, "steps": steps, "rain": rain, "temp": temp, "msl": msl, "wind": f"mm_{model}_wind.json", "built": now.isoformat()}
    meta_path.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
    return {**entry, "fresh": True}


def build(out_dir: Path, log, now: datetime, models=None, steps=None) -> dict:
    """All models; one that fails keeps its previous copy. Returns {"models": {id: entry}, "errors": [...]}."""
    res, errors = {}, []
    for m in models or MODELS:
        try:
            res[m] = build_model(m, out_dir, log, now, steps=steps)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{m}: {e}")
            p = out_dir / f"mm_{m}.json"
            if p.exists():
                res[m] = {**json.loads(p.read_text(encoding="utf-8")), "fresh": False, "stale": True}
    return {"models": res, "errors": errors}
