"""Weather / rain-gauge station observations: current snapshot and hourly history."""
import csv
import gzip
import io
import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

MISSING = {"-99", "-99.0", "-999", "-999.0", "-9999", "X", "x", "", "None", "T"}


def num(v):
    """CWA numeric string -> float or None (missing / faulty / trace)."""
    if v is None:
        return None
    s = str(v).strip()
    if s in MISSING:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    if f <= -98:
        return None
    return f


def _strip(tag: str) -> str:
    return tag.split("}", 1)[-1]


def xml_to_obj(elem):
    """Generic XML -> dict/list/str; repeated child tags become lists."""
    kids = list(elem)
    if not kids:
        return (elem.text or "").strip()
    out = {}
    for k in kids:
        name = _strip(k.tag)
        val = xml_to_obj(k)
        if name in out:
            if not isinstance(out[name], list) or not getattr(out[name], "_multi", False):
                out[name] = _Multi([out[name]])
            out[name].append(val)
        else:
            out[name] = val
    return out


class _Multi(list):
    _multi = True


def load_doc(path: Path):
    """Load a CWA observation document from JSON or XML into a dict."""
    path = Path(path)
    if path.suffix == ".xml":
        root = ET.parse(path).getroot()
        return {"cwaopendata": xml_to_obj(root)}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def _get(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def _wgs84(geo):
    coords = _as_list(geo.get("Coordinates"))
    pick = next((c for c in coords if c.get("CoordinateName") == "WGS84"), coords[0] if coords else {})
    return num(pick.get("StationLatitude")), num(pick.get("StationLongitude"))


def parse_stations(doc, kind: str) -> list:
    """Normalize O-A0001-001 (auto), O-A0003-001 (manned) or O-A0002-001 (rain)."""
    out = []
    for s in _as_list(_get(doc, "cwaopendata", "dataset", "Station")):
        geo = s.get("GeoInfo", {})
        lat, lon = _wgs84(geo)
        if lat is None or lon is None:
            continue
        rec = {
            "id": s.get("StationId"), "n": s.get("StationName"), "lat": round(lat, 5), "lon": round(lon, 5),
            "alt": num(geo.get("StationAltitude")), "county": geo.get("CountyName"), "town": geo.get("TownName"),
            "tc": geo.get("TownCode"), "k": kind, "t": _get(s, "ObsTime", "DateTime"),
        }
        if kind == "rain":
            r = s.get("RainfallElement", {})
            rec.update({
                "Rnow": num(_get(r, "Now", "Precipitation")), "R10m": num(_get(r, "Past10Min", "Precipitation")),
                "R1h": num(_get(r, "Past1hr", "Precipitation")), "R3h": num(_get(r, "Past3hr", "Precipitation")),
                "R6h": num(_get(r, "Past6hr", "Precipitation")), "R12h": num(_get(r, "Past12hr", "Precipitation")),
                "R24h": num(_get(r, "Past24hr", "Precipitation")), "R2d": num(_get(r, "Past2days", "Precipitation")),
                "R3d": num(_get(r, "Past3days", "Precipitation")),
            })
        else:
            w = s.get("WeatherElement", {})
            rec.update({
                "Wx": w.get("Weather") if w.get("Weather") not in MISSING else None,
                "T": num(w.get("AirTemperature")), "RH": num(w.get("RelativeHumidity")),
                "WS": num(w.get("WindSpeed")), "WD": num(w.get("WindDirection")),
                "G": num(_get(w, "GustInfo", "PeakGustSpeed")), "P": num(w.get("AirPressure")),
                "Rnow": num(_get(w, "Now", "Precipitation")),
                "Tmax": num(_get(w, "DailyExtreme", "DailyHigh", "TemperatureInfo", "AirTemperature")),
                "Tmin": num(_get(w, "DailyExtreme", "DailyLow", "TemperatureInfo", "AirTemperature")),
            })
            if kind == "manned":
                rec["vis"] = w.get("VisibilityDescription") if w.get("VisibilityDescription") not in MISSING else None
                rec["uv"] = num(w.get("UVIndex"))
        out.append({k: v for k, v in rec.items() if v is not None})
    return out


def merge_current(auto, manned, rain) -> list:
    """Merge the three station feeds by station id (weather fields win over rain)."""
    by_id = {}
    for rec in rain:
        by_id[rec["id"]] = dict(rec)
    for rec in auto + manned:
        cur = by_id.get(rec["id"], {})
        rain_fields = {k: v for k, v in cur.items() if k.startswith("R")}
        merged = {**cur, **rec, **rain_fields}
        if cur:
            merged["k"] = rec["k"]
            merged["rt"] = cur.get("t")
        by_id[rec["id"]] = merged
    return sorted(by_id.values(), key=lambda r: r["id"])


# --------------------------------------------------------------------- history

HIST_FIELDS = ["T", "RH", "WS", "WD", "G", "R1h", "Rnow"]


def hour_key(iso: str) -> str:
    """Normalize an ISO timestamp to the local hour 'YYYY-MM-DDTHH'."""
    return iso[:13]


class Archive:
    """Hourly per-station archive stored as monthly gzip CSV files."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.rows = {}  # (hour, sid) -> dict
        self.dirty_months = set()
        self.processed_path = self.root / "processed.json"
        self.processed = set(json.loads(self.processed_path.read_text())) if self.processed_path.exists() else set()
        self.meta = {}  # sid -> (name, lat, lon, alt)

    def months(self):
        return sorted(p.name[:7] for p in self.root.glob("????-??.csv.gz"))

    def load_month(self, month: str):
        p = self.root / f"{month}.csv.gz"
        if not p.exists():
            return
        with gzip.open(p, "rt", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                rec = {f: (float(row[f]) if row.get(f) not in (None, "") else None) for f in HIST_FIELDS}
                self.rows[(row["hour"], row["sid"])] = rec

    def load_recent(self, now: datetime, days: int = 32):
        first = (now - timedelta(days=days)).strftime("%Y-%m")
        for m in self.months():
            if m >= first:
                self.load_month(m)

    def add(self, stations: list, source: str = None):
        for s in stations:
            t = s.get("t") if s.get("k") != "rain" else s.get("t")
            if not t:
                continue
            # Only keep on-the-hour observations (10-min rain snapshots are thinned).
            if t[14:16] not in ("00",):
                continue
            key = (hour_key(t), s["id"])
            rec = self.rows.setdefault(key, {f: None for f in HIST_FIELDS})
            for f in HIST_FIELDS:
                if s.get(f) is not None:
                    rec[f] = s[f]
            self.dirty_months.add(key[0][:7])
            self.meta.setdefault(s["id"], (s.get("n"), s.get("lat"), s.get("lon"), s.get("alt")))
        if source:
            self.processed.add(source)

    def save(self):
        for month in sorted(self.dirty_months):
            keys = sorted(k for k in self.rows if k[0].startswith(month))
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["hour", "sid"] + HIST_FIELDS)
            for k in keys:
                r = self.rows[k]
                w.writerow([k[0], k[1]] + ["" if r[f] is None else _fmt(r[f]) for f in HIST_FIELDS])
            p = self.root / f"{month}.csv.gz"
            tmp = p.with_suffix(".tmp")
            with gzip.open(tmp, "wt", encoding="utf-8", newline="", compresslevel=9) as fh:
                fh.write(buf.getvalue())
            tmp.replace(p)
        self.dirty_months.clear()
        self.processed_path.write_text(json.dumps(sorted(self.processed)))

    def wind_ids(self, now: datetime, days: int = 31) -> set:
        """Station ids that reported a wind speed during the last ``days`` days."""
        first = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H")
        return {sid for (hk, sid), rec in self.rows.items() if hk >= first and rec.get("WS") is not None}

    def export_station_files(self, out_dir: Path, now: datetime, days: int = 31) -> int:
        """Write data/hist/<sid>.json with the last ``days`` days of hourly values."""
        out_dir.mkdir(parents=True, exist_ok=True)
        end = now.replace(minute=0, second=0, microsecond=0)
        start = end - timedelta(days=days)
        hours = []
        h = start
        while h <= end:
            hours.append(h.strftime("%Y-%m-%dT%H"))
            h += timedelta(hours=1)
        index = {hk: i for i, hk in enumerate(hours)}
        series = {}
        for (hk, sid), rec in self.rows.items():
            i = index.get(hk)
            if i is None:
                continue
            arr = series.get(sid)
            if arr is None:
                arr = series[sid] = {f: [None] * len(hours) for f in HIST_FIELDS}
            for f in HIST_FIELDS:
                arr[f][i] = rec[f]
        for sid, arr in series.items():
            fields = {f: v for f, v in arr.items() if any(x is not None for x in v)}
            doc = {"id": sid, "start": hours[0], "step": 3600, "n": len(hours), "fields": fields}
            (out_dir / f"{sid}.json").write_text(json.dumps(doc, separators=(",", ":")))
        return len(series)


def flag_wind_faults(stations_list: list, wind_ids: set) -> int:
    """Set ``wf`` = 1 on weather stations that have no wind now but did report wind recently (sensor fault)."""
    n = 0
    for s in stations_list:
        if s.get("k") != "rain" and s.get("WS") is None and s["id"] in wind_ids:
            s["wf"] = 1
            n += 1
        else:
            s.pop("wf", None)
    return n


def _fmt(v: float) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    return f"{v:.1f}".rstrip("0").rstrip(".") if not float(v).is_integer() else str(int(v))
