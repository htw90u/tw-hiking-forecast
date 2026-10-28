"""CWA regional WRF 3 km (M-A0064, GRIB2, 0-84 h every 6 h) -> map grids, winds aloft and point series.

One GRIB2 file per forecast hour (about 180 MB each), so the files are only downloaded when a new model run
(initial time) appears. Each file is reduced at once to:
  * grids/wrf3_temp_<fh>.png / wrf3_rain_<fh>.png: 2 m temperature (deg C) and 6-hour rain (mm), 0.03 degree lon/lat (the same
    16-bit PNG encoding as the other grids, see grids.py)
  * wrf3.json: winds (u, v in 0.1 m/s, int16, base64) at 7 pressure levels and 10 m on a 0.06 degree grid
  * wrf3pts.json: 2 m temperature / humidity, 10 m wind and 6-hour rain at every forecast spot and township centre
"""
import base64
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from scipy.spatial import Delaunay

from . import grids

TZ = ZoneInfo("Asia/Taipei")
META_KEY = "Model/M-A0064-000.json"
HOURS = list(range(0, 85, 6))
LEVELS = [925, 850, 700, 500, 300, 250, 200]
REGION = {"lon": (118.9, 123.2), "lat": (20.9, 26.6)}
FINE, COARSE = 0.03, 0.06       # output grid steps (degrees): temperature / rain, winds
T_SCALE, T_OFFSET = 0.1, -100.0   # same encoding as the temperature analysis layer
R_SCALE = 0.1


def grib_key(fh: int) -> str:
    return f"Model/M-A0064-{fh:03d}.grb2"


def init_time(meta: dict) -> datetime:
    s = meta["cwaopendata"]["dataset"]["datasetInfo"]["InitialTime"]
    return datetime.strptime(s, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def grid_axes(res: float):
    """Cell-centre longitudes / latitudes of an output grid (row 0 = south)."""
    lons = np.arange(REGION["lon"][0], REGION["lon"][1] + 1e-9, res)
    lats = np.arange(REGION["lat"][0], REGION["lat"][1] + 1e-9, res)
    return lons, lats


class Sampler:
    """Barycentric weights from the model's (Lambert) grid points to every output target."""

    def __init__(self, lat, lon, targets):
        """targets: {name: (lon array, lat array)} (flat arrays of query points)."""
        pad = 1.0
        lo0, lo1 = REGION["lon"]
        la0, la1 = REGION["lat"]
        sel = (lat > la0 - pad) & (lat < la1 + pad) & (lon > lo0 - pad) & (lon < lo1 + pad)
        self.sel = sel
        pts = np.column_stack([lon[sel], lat[sel]])
        tri = Delaunay(pts)
        self.w = {}
        for name, (qx, qy) in targets.items():
            q = np.column_stack([np.asarray(qx, float), np.asarray(qy, float)])
            s = tri.find_simplex(q)
            if (s < 0).any():
                raise ValueError(f"target {name} is not covered by the model grid")
            t = tri.transform[s]
            b = np.einsum("ijk,ik->ij", t[:, :2], q - t[:, 2])
            self.w[name] = (tri.simplices[s], np.column_stack([b, 1 - b.sum(axis=1)]))

    def __call__(self, values):
        """{target: 1-D array} for one model field."""
        flat = np.asarray(np.ma.filled(values, np.nan), dtype=np.float64)[self.sel]
        return {n: (flat[v] * w).sum(axis=1) for n, (v, w) in self.w.items()}


def _is_precip(m) -> bool:
    try:
        return m["parameterCategory"] == 1 and m["parameterNumber"] == 8
    except Exception:  # noqa: BLE001 - key missing in this message
        return False


def extract(msgs, sampler=None, targets=None):
    """{field: {target: 1-D array}}: u / v / gh on LEVELS, u10 / v10 / t2 / rh2 and the accumulated rain 'rain'."""
    out = {}
    for m in msgs:
        lvl, name = m.typeOfLevel, m.shortName
        if lvl == "isobaricInhPa" and m.level in LEVELS and name in ("u", "v", "gh"):
            key = (name, m.level)
        elif lvl == "heightAboveGround" and name in ("10u", "10v", "2t", "2r"):
            key = {"10u": "u10", "10v": "v10", "2t": "t2", "2r": "rh2"}[name]
        elif lvl == "surface" and _is_precip(m):
            key = "rain"
        else:
            continue
        if sampler is None:
            lat, lon = m.latlons()
            sampler = Sampler(lat, lon, targets)
        out[key] = sampler(m.values)
    return out, sampler


def _b64(a) -> str:
    return base64.b64encode(np.asarray(a, "<i2").tobytes()).decode("ascii")


def _ints(a, scale):
    return [None if not np.isfinite(x) else int(round(float(x) / scale)) for x in a]


def build(out_dir: Path, log, fetch, now: datetime, points, open_grib=None) -> dict:
    """fetch(key) -> bytes; points: [(key, lat, lon)]. Skips the download when wrf3.json already holds the latest run."""
    dest = out_dir / "wrf3.json"
    init = init_time(json.loads(fetch(META_KEY).decode("utf-8-sig")))
    prev = json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    if prev and prev.get("initUTC") == init.isoformat() and prev.get("levels") == LEVELS and prev.get("nPoints") == len(points):
        return {"fresh": False, "init": prev["init"], "steps": len(prev["steps"]), "rain": prev["rainSteps"]}
    if open_grib is None:
        import pygrib
        open_grib = pygrib.open
    flon, flat = grid_axes(FINE)
    cx, cy = grid_axes(COARSE)
    gx, gy = np.meshgrid(flon, flat)
    wx, wy = np.meshgrid(cx, cy)
    targets = {"fine": (gx.ravel(), gy.ravel()), "wind": (wx.ravel(), wy.ravel()),
               "pts": ([p[2] for p in points], [p[1] for p in points])}
    sampler = None
    wind = {k: [] for k in [f"{c}{lv}" for lv in LEVELS for c in "uv"] + ["u10", "v10"]}
    zmed = [[] for _ in LEVELS]
    pts = {k: [] for k in ("t2", "rh", "u", "v", "rain")}
    acc_prev = None
    rain_steps = []
    for fh in HOURS:
        data = fetch(grib_key(fh))
        fd, tmp = tempfile.mkstemp(suffix=".grb2")
        try:
            with os.fdopen(fd, "wb") as fp:
                fp.write(data)
            del data
            g = open_grib(tmp)
            f, sampler = extract(g, sampler, targets)
            g.close()
        finally:
            os.unlink(tmp)
        valid = (init + timedelta(hours=fh)).astimezone(TZ).isoformat()
        t2 = f["t2"]["fine"] - 273.15
        grid = {"data": t2.reshape(gx.shape), "lon0": float(flon[0]), "lat0": float(flat[0]), "res": FINE}
        grids.write_layer(out_dir / "grids", f"wrf3_temp_{fh:03d}", grid, T_SCALE, T_OFFSET,
                          {"label": "WRF 3 km 2 m 氣溫預報", "unit": "°C", "time": valid, "src": "M-A0064"})
        acc = f["rain"]
        if acc_prev is not None:
            six = {n: np.maximum(acc[n] - acc_prev[n], 0) for n in acc}
            grid = {"data": six["fine"].reshape(gx.shape), "lon0": float(flon[0]), "lat0": float(flat[0]), "res": FINE}
            start = (init + timedelta(hours=fh - 6)).astimezone(TZ).isoformat()
            grids.write_layer(out_dir / "grids", f"wrf3_rain_{fh:03d}", grid, R_SCALE, 0.0,
                              {"label": "WRF 3 km 6 小時降水預報", "unit": "mm", "time": valid, "start": start, "src": "M-A0064"})
            rain_steps.append(fh)
            pts["rain"].append(_ints(six["pts"], 0.1))
        else:
            pts["rain"].append([None] * len(points))
        acc_prev = acc
        for k in wind:
            src = f[k] if k in ("u10", "v10") else f[(k[0], int(k[1:]))]
            wind[k].append(np.rint(src["wind"] * 10))
        for li, lv in enumerate(LEVELS):
            zmed[li].append(float(np.nanmedian(f[("gh", lv)]["pts"])))
        pts["t2"].append(_ints(f["t2"]["pts"] - 273.15, 0.1))
        pts["rh"].append(_ints(f["rh2"]["pts"], 1))
        pts["u"].append(_ints(f["u10"]["pts"], 0.1))
        pts["v"].append(_ints(f["v10"]["pts"], 0.1))
        log.info(f"wrf3: +{fh:03d} h done")
    steps = [(init + timedelta(hours=fh)).astimezone(TZ).isoformat() for fh in HOURS]
    nx, ny = len(cx), len(cy)
    obj = {"init": init.astimezone(TZ).isoformat(), "initUTC": init.isoformat(), "time": now.isoformat(), "levels": LEVELS, "steps": steps,
           "rainSteps": rain_steps, "nPoints": len(points),
           "grid": {"lon0": float(cx[0]), "lat0": float(cy[0]), "res": COARSE, "nx": nx, "ny": ny},
           "z": [int(round(float(np.median(z)))) for z in zmed],
           "wind": {k: _b64(np.stack(v)) for k, v in wind.items()},   # int16 LE, shape (steps, ny, nx), 0.1 m/s
           "source": "中央氣象署 區域數值模式 WRF 3 km (M-A0064)"}
    series = {"init": obj["init"], "steps": steps, "rainSteps": rain_steps,
              "points": {p[0]: {k: [row[i] for row in v] for k, v in pts.items()} for i, p in enumerate(points)},
              "source": obj["source"]}
    for name, o in (("wrf3.json", obj), ("wrf3pts.json", series)):
        tmpf = out_dir / (name + ".tmp")
        tmpf.write_text(json.dumps(o, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmpf.replace(out_dir / name)
    return {"fresh": True, "init": obj["init"], "steps": len(steps), "rain": rain_steps}
