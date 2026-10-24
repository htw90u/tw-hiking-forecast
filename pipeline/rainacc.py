"""Multi-period accumulated rainfall grids interpolated from rain gauges.

Gauges report past 3/6/12/24 h and 2/3 day totals; the 7-day total is summed
from the hourly archive. Values are spread to the 0.01 degree land grid with
inverse-distance weighting (the method CWA uses for its daily rain analysis).
"""
from datetime import datetime, timedelta

import numpy as np
from scipy.spatial import cKDTree

from .qpf import GRID

# id, station field (None = archive sum), label, hours
PERIODS = [
    ("3h", "R3h", "過去3小時", 3), ("6h", "R6h", "過去6小時", 6), ("12h", "R12h", "過去12小時", 12),
    ("24h", "R24h", "過去24小時", 24), ("2d", "R2d", "過去2天", 48), ("3d", "R3d", "過去3天", 72),
    ("7d", None, "過去7天", 168),
]
MAX_KM = 25.0      # cells farther than this from every gauge are left blank
NEIGHBOURS = 8
POWER = 2.0


def idw_grid(lons, lats, values, land, grid=GRID):
    """Inverse-distance weighted grid (row 0 = south), NaN outside land / coverage."""
    lons, lats, values = map(np.asarray, (lons, lats, values))
    ok = np.isfinite(values) & (values >= 0)
    lons, lats, values = lons[ok], lats[ok], values[ok]
    out = np.full((grid["ny"], grid["nx"]), np.nan, np.float32)
    if len(values) < 3:
        return out
    kx = np.cos(np.radians(23.7))  # metric-ish distances at Taiwan's latitude
    tree = cKDTree(np.c_[lons * kx, lats])
    gx = grid["lon0"] + np.arange(grid["nx"]) * grid["res"]
    gy = grid["lat0"] + np.arange(grid["ny"]) * grid["res"]
    X, Y = np.meshgrid(gx, gy)
    pts = np.c_[X[land] * kx, Y[land]]
    k = min(NEIGHBOURS, len(values))
    d, idx = tree.query(pts, k=k, distance_upper_bound=MAX_KM / 111.0)
    d = d.reshape(len(pts), k)
    idx = idx.reshape(len(pts), k)
    valid = np.isfinite(d)
    v = np.where(valid, values[np.minimum(idx, len(values) - 1)], 0.0)
    w = np.where(valid, 1.0 / np.maximum(d, 1e-4) ** POWER, 0.0)
    wsum = w.sum(axis=1)
    res = np.where(wsum > 0, (w * v).sum(axis=1) / np.where(wsum > 0, wsum, 1), np.nan)
    out[land] = res
    return out


def archive_totals(rows: dict, now: datetime, hours: int, min_frac: float = 0.9) -> dict:
    """Sum hourly R1h per station over the last ``hours`` (needs >= min_frac coverage)."""
    end = now.replace(minute=0, second=0, microsecond=0)
    keys = {(end - timedelta(hours=h)).strftime("%Y-%m-%dT%H") for h in range(hours)}
    tot, cnt = {}, {}
    for (hk, sid), rec in rows.items():
        if hk in keys and rec.get("R1h") is not None:
            tot[sid] = tot.get(sid, 0.0) + rec["R1h"]
            cnt[sid] = cnt.get(sid, 0) + 1
    return {sid: v for sid, v in tot.items() if cnt[sid] >= hours * min_frac}
