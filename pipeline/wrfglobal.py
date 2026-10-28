"""CWA global model (M-A0060, GRIB2, 0.25 degree, 0-384 h) -> East Asia map grids and point series.

52 forecast times: every 6 h to 240 h, then every 12 h to 384 h (about 60 MB each), so a file set is only downloaded when a new model run
(initial time) appears. Each file is reduced at once to:
  * grids/wrfg_{rain,msl,temp}_<hours>.png at the daily times (24, 48 ... 240, 264 ... 384 h): the 24-hour rain, the sea-level pressure and the
    2 m temperature on the native 0.25 degree grid of East Asia (same 16-bit PNG encoding as the other grids, see grids.py)
  * wrfgpts.json: 2 m temperature, 10 m wind speed and the accumulated rain at every forecast spot and township centre, for all 52 times
"""
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from scipy.ndimage import map_coordinates

from . import grids

TZ = ZoneInfo("Asia/Taipei")
META_KEY = "Model/M-A0060-000.json"
HOURS = list(range(0, 241, 6)) + list(range(264, 385, 12))
DAYS = [h for h in HOURS if h and h % 24 == 0]          # 24, 48 ... 240, 264, 288 ... 384: sixteen days
VERSION = 2   # bump when the output changes: the same model run is then processed again
REGION = {"lon": (100.0, 160.0), "lat": (0.0, 50.0)}
RAIN_SCALE, MSL_SCALE, MSL_OFFSET = 0.1, 0.1, 850.0
T_SCALE, T_OFFSET = 0.1, -100.0


def grib_key(fh: int) -> str:
    return f"Model/M-A0060-{fh:03d}.grb2"


def init_time(meta: dict) -> datetime:
    s = meta["cwaopendata"]["dataset"]["datasetInfo"]["InitialTime"]
    return datetime.strptime(s, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def _is_precip(m) -> bool:
    """Total precipitation accumulated from the start of the run (the file also carries the last-interval accumulation, e.g. 6-12 h)."""
    try:
        if not (m["parameterCategory"] == 1 and m["parameterNumber"] == 8):
            return False
    except Exception:  # noqa: BLE001 - key missing in this message
        return False
    try:
        return int(m["startStep"]) == 0
    except Exception:  # noqa: BLE001 - no step information: take it as the running total
        return True


class Field:
    """One regular lon/lat field: crop for the map and bilinear sampling at points."""

    def __init__(self, m):
        lat, lon = m.latlons()
        self.lats, self.lons = lat[:, 0], lon[0, :]
        self.dlat, self.dlon = self.lats[1] - self.lats[0], self.lons[1] - self.lons[0]
        la = (self.lats >= REGION["lat"][0] - 1e-6) & (self.lats <= REGION["lat"][1] + 1e-6)
        lo = (self.lons >= REGION["lon"][0] - 1e-6) & (self.lons <= REGION["lon"][1] + 1e-6)
        self.rows, self.cols = np.where(la)[0], np.where(lo)[0]

    def crop(self, values):
        """Region array with row 0 = south (the layout of grids.write_layer)."""
        a = np.ma.filled(values, np.nan)[np.ix_(self.rows, self.cols)].astype(np.float64)
        return a[::-1] if self.dlat < 0 else a

    def grid(self, values):
        a = self.crop(values)
        lats = self.lats[self.rows]
        lons = self.lons[self.cols]
        return {"data": a, "lon0": float(lons.min()), "lat0": float(lats.min()), "res": float(abs(self.dlon))}

    def sample(self, values, pts):
        """Bilinear values at [(key, lat, lon)]."""
        fy = [(p[1] - self.lats[0]) / self.dlat for p in pts]
        fx = [(p[2] - self.lons[0]) / self.dlon for p in pts]
        return map_coordinates(np.ma.filled(values, np.nan).astype(np.float64), [fy, fx], order=1, mode="nearest")


def extract(msgs, field=None):
    """({name: 2-D array}, Field): msl (Pa), t2 (K), u10, v10 and the accumulated rain 'acc'."""
    out = {}
    for m in msgs:
        lvl, name = m.typeOfLevel, m.shortName
        if lvl == "meanSea" and name == "msl":
            key = "msl"
        elif lvl == "heightAboveGround" and name in ("2t", "10u", "10v"):
            key = {"2t": "t2", "10u": "u10", "10v": "v10"}[name]
        elif lvl == "surface" and _is_precip(m):
            key = "acc"
        else:
            continue
        if field is None:
            field = Field(m)
        out[key] = m.values
    return out, field


def _ints(a, scale):
    return [None if not np.isfinite(x) else int(round(float(x) / scale)) for x in a]


def build(out_dir: Path, log, fetch, now: datetime, points, open_grib=None) -> dict:
    """fetch(key) -> bytes; points: [(key, lat, lon)]. Skips the download when wrfgpts.json already holds the latest run."""
    dest = out_dir / "wrfgpts.json"
    init = init_time(json.loads(fetch(META_KEY).decode("utf-8-sig")))
    prev = json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    if prev and prev.get("initUTC") == init.isoformat() and prev.get("nPoints") == len(points) and prev.get("ver") == VERSION:
        return {"fresh": False, "init": prev["init"], "days": prev["days"]}
    if open_grib is None:
        import pygrib
        open_grib = pygrib.open
    field = None
    acc_at = {}
    pts = {k: [] for k in ("t2", "ws", "acc")}
    for fh in HOURS:
        data = fetch(grib_key(fh))
        fd, tmp = tempfile.mkstemp(suffix=".grb2")
        try:
            with os.fdopen(fd, "wb") as fp:
                fp.write(data)
            del data
            g = open_grib(tmp)
            f, field = extract(g, field)
            g.close()
        finally:
            os.unlink(tmp)
        valid = (init + timedelta(hours=fh)).astimezone(TZ).isoformat()
        if fh == 0:
            f["acc"] = np.zeros_like(np.ma.filled(f["acc"], 0.0))   # nothing has fallen at the start of the run
        acc_at[fh] = f["acc"]
        pts["t2"].append(_ints(field.sample(f["t2"], points) - 273.15, 0.1))
        pts["ws"].append(_ints(np.hypot(field.sample(f["u10"], points), field.sample(f["v10"], points)), 0.1))
        pts["acc"].append(_ints(field.sample(f["acc"], points), 0.1))
        if fh in DAYS:
            meta = {"src": "M-A0060", "time": valid}
            gdir = out_dir / "grids"
            grids.write_layer(gdir, f"wrfg_msl_{fh:03d}", field.grid(f["msl"] / 100.0), MSL_SCALE, MSL_OFFSET,
                              {**meta, "label": "全球模式 海平面氣壓預報", "unit": "hPa"})
            grids.write_layer(gdir, f"wrfg_temp_{fh:03d}", field.grid(f["t2"] - 273.15), T_SCALE, T_OFFSET,
                              {**meta, "label": "全球模式 2 m 氣溫預報", "unit": "°C"})
            before = acc_at.get(fh - 24)
            rain = np.ma.filled(f["acc"], np.nan) - (np.ma.filled(before, np.nan) if before is not None else 0.0)
            start = (init + timedelta(hours=fh - 24)).astimezone(TZ).isoformat()
            grids.write_layer(gdir, f"wrfg_rain_{fh:03d}", field.grid(np.maximum(rain, 0)), RAIN_SCALE, 0.0,
                              {**meta, "start": start, "label": "全球模式 24 小時降水預報", "unit": "mm"})
        log.info(f"wrfg: +{fh:03d} h done")
    obj = {"init": init.astimezone(TZ).isoformat(), "initUTC": init.isoformat(), "time": now.isoformat(), "hours": HOURS, "days": DAYS,
           "nPoints": len(points), "ver": VERSION, "source": "中央氣象署 全球模式 (M-A0060)",
           "points": {p[0]: {k: [row[i] for row in v] for k, v in pts.items()} for i, p in enumerate(points)}}
    tmpf = out_dir / "wrfgpts.json.tmp"
    tmpf.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmpf.replace(dest)
    return {"fresh": True, "init": obj["init"], "days": DAYS}
