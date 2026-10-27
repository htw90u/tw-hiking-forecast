"""CWA regional WRF winds on pressure levels (M-A0061, 15 km, GRIB2) -> a small lon/lat grid for the map.

One GRIB2 file per forecast hour (about 60 MB each), so the files are only downloaded when a new model run
(initial time, 00/06/12/18 UTC) appears; wrf.json keeps the winds (u, v in 0.1 m/s) of 7 pressure levels (925 to 200 hPa) for 6-hourly steps up to 72 h.
"""
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from scipy.spatial import Delaunay

TZ = ZoneInfo("Asia/Taipei")
LEVELS = [925, 850, 700, 500, 300, 250, 200]   # 300-200 hPa (about 9-12 km): the jet stream
HOURS = list(range(0, 73, 6))
GRID = {"lon0": 116.0, "lat0": 19.0, "res": 0.25, "nx": 41, "ny": 37}   # cell centres, row 0 = south
META_KEY = "Model/M-A0061-000.json"


def grib_key(fh: int) -> str:
    return f"Model/M-A0061-{fh:03d}.grb2"


def init_time(meta: dict) -> datetime:
    """UTC initial time from the dataset JSON ('InitialTime': 'YYYYMMDDHHMM')."""
    s = meta["cwaopendata"]["dataset"]["datasetInfo"]["InitialTime"]
    return datetime.strptime(s, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


class Interp:
    """Barycentric weights from scattered source points (the model's Lambert grid) to the output lon/lat grid."""

    def __init__(self, lat, lon, grid=GRID):
        sel = (lat > grid["lat0"] - 2) & (lat < grid["lat0"] + grid["ny"] * grid["res"] + 2) \
            & (lon > grid["lon0"] - 2) & (lon < grid["lon0"] + grid["nx"] * grid["res"] + 2)
        self.sel = sel
        pts = np.column_stack([lon[sel], lat[sel]])
        lons = grid["lon0"] + np.arange(grid["nx"]) * grid["res"]
        lats = grid["lat0"] + np.arange(grid["ny"]) * grid["res"]
        gx, gy = np.meshgrid(lons, lats)
        self.shape = gx.shape
        tri = Delaunay(pts)
        q = np.column_stack([gx.ravel(), gy.ravel()])
        s = tri.find_simplex(q)
        if (s < 0).any():
            raise ValueError("output grid is not covered by the model grid")
        t = tri.transform[s]
        b = np.einsum("ijk,ik->ij", t[:, :2], q - t[:, 2])
        self.w = np.column_stack([b, 1 - b.sum(axis=1)])
        self.v = tri.simplices[s]

    def __call__(self, values):
        flat = np.asarray(values, dtype=np.float64)[self.sel]
        return (flat[self.v] * self.w).sum(axis=1).reshape(self.shape)


def extract(msgs, interp=None):
    """{(name, level): 2-D array on the output grid} for u / v / gh on LEVELS; also returns the Interp used."""
    out = {}
    for m in msgs:
        if m.typeOfLevel != "isobaricInhPa" or m.level not in LEVELS or m.shortName not in ("u", "v", "gh"):
            continue
        if interp is None:
            lat, lon = m.latlons()
            interp = Interp(lat, lon)
        out[(m.shortName, m.level)] = interp(np.ma.filled(m.values, np.nan))
    return out, interp


def _ints(a):
    return [int(round(float(x) * 10)) for x in a.ravel()]


def build(out_dir: Path, log, fetch, now: datetime, open_grib=None) -> dict:
    """fetch(key) -> bytes. Skips the download when wrf.json already holds the latest model run."""
    dest = out_dir / "wrf.json"
    init = init_time(json.loads(fetch(META_KEY).decode("utf-8-sig")))
    prev = json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    if prev and prev.get("initUTC") == init.isoformat() and prev.get("levels") == LEVELS:   # same run and same levels: nothing to do
        return {"fresh": False, "init": prev["init"], "steps": len(prev["steps"])}
    if open_grib is None:
        import pygrib
        open_grib = pygrib.open
    u = [[] for _ in LEVELS]
    v = [[] for _ in LEVELS]
    gh = [[] for _ in LEVELS]
    interp = None
    for fh in HOURS:
        data = fetch(grib_key(fh))
        fd, tmp = tempfile.mkstemp(suffix=".grb2")
        try:
            with os.fdopen(fd, "wb") as fp:
                fp.write(data)
            del data
            g = open_grib(tmp)
            fields, interp = extract(g, interp)
            g.close()
        finally:
            os.unlink(tmp)
        for li, lv in enumerate(LEVELS):
            u[li].append(_ints(fields[("u", lv)]))
            v[li].append(_ints(fields[("v", lv)]))
            gh[li].append(float(np.nanmedian(fields[("gh", lv)])))
        log.info(f"wrf: +{fh:03d} h done")
    steps = [(init + timedelta(hours=fh)).astimezone(TZ).isoformat() for fh in HOURS]
    obj = {"init": init.astimezone(TZ).isoformat(), "initUTC": init.isoformat(), "time": now.isoformat(), "levels": LEVELS, "steps": steps,
           "grid": GRID, "z": [int(round(float(np.median(g)))) for g in gh], "u": u, "v": v,
           "source": "中央氣象署 區域數值模式 WRF 15 km (M-A0061)"}
    tmpf = dest.with_suffix(".json.tmp")
    tmpf.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmpf.replace(dest)
    return {"fresh": True, "init": obj["init"], "steps": len(steps)}
