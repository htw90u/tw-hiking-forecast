"""CWA shakemap (等震度圖, E-A0015-003) image -> georeferenced intensity grid.

The image frame spans 119-123 E / 21-26 N in a plain lon/lat projection. The
pixel transform is verified against the Taiwan coastline on every run (and
re-fitted if the layout changes), then the legend colours are mapped back to
intensity levels on the same 0.01 degree grid as the QPF.
"""
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage, optimize

from . import geo
from .qpf import GRID, _densify

LEVELS = ["0級", "1級", "2級", "3級", "4級", "5弱", "5強", "6弱", "6強", "7級"]
SEA_RGB = (179, 238, 253)
LAND_RGB = (255, 255, 255)
CENTRE = (121.0, 23.5)
# x = ax * (lon - 121) + bx ; y = ay * (lat - 23.5) + by   (image 2334 x 2977)
DEFAULT_FIT = (531.53, 1202.74, -576.87, 1469.81)
# Inset boxes (Matsu / Kinmen) and the legend are not part of the main map.
EXCLUDE = [(0, 0, 680, 920)]


def coastline_points(topo: dict) -> np.ndarray:
    rings = [np.asarray(poly[0]) for _, polys in geo.polygons(topo, "nation") for poly in polys]
    sel = [r for r in rings if 119.2 < r[:, 0].mean() < 122.2 and 21.8 < r[:, 1].mean() < 25.4 and len(r) > 20]
    return np.concatenate([_densify(r, 0.002) for r in sel])


def _project(fit, lon, lat):
    ax, bx, ay, by = fit
    return ax * (lon - CENTRE[0]) + bx, ay * (lat - CENTRE[1]) + by


def fit_frame(rgb: np.ndarray, pts: np.ndarray, threshold: float = 4.0):
    dark = rgb.max(axis=2) < 60
    h, w = dark.shape
    dark[int(h * 0.86):, :] = False
    for x0, y0, x1, y1 in EXCLUDE:
        dark[y0:y1, x0:x1] = False
    dist = ndimage.distance_transform_edt(~dark)

    def cost(p):
        x, y = _project(p, pts[:, 0], pts[:, 1])
        xi = np.clip(np.round(x).astype(int), 0, w - 1)
        yi = np.clip(np.round(y).astype(int), 0, h - 1)
        d = np.sort(np.minimum(dist[yi, xi], 15) ** 2)
        return float(np.mean(d[: int(len(d) * 0.9)]))

    c = cost(DEFAULT_FIT)
    if c <= threshold:
        return DEFAULT_FIT, c, False
    r = optimize.minimize(cost, DEFAULT_FIT, method="Nelder-Mead", options={"maxiter": 6000, "xatol": 1e-3, "fatol": 1e-4})
    return tuple(r.x), float(r.fun), True


def read_legend(rgb: np.ndarray) -> list:
    """The nine intensity colours (1級 .. 7級) from the colour bar at the bottom."""
    h = rgb.shape[0]
    for y in range(int(h * 0.85), h):
        runs, prev, start = [], None, 0
        for x, c in enumerate(map(tuple, rgb[y])):
            if c != prev:
                if prev is not None and x - start >= 100 and prev not in (SEA_RGB, LAND_RGB):
                    runs.append(tuple(int(v) for v in prev))
                prev, start = c, x
        if len(runs) == 9:
            return runs
    raise ValueError("shakemap legend not found")


def classify(rgb: np.ndarray, legend: list) -> np.ndarray:
    """0 = sea / unknown, 1 = land below 1級, 2.. = 1級 .. 7級."""
    h, w, _ = rgb.shape
    pal = [SEA_RGB, LAND_RGB] + list(legend)
    best = np.full((h, w), np.iinfo(np.int32).max, np.int32)
    idx = np.zeros((h, w), np.int16)
    for i, c in enumerate(pal):
        d = ((rgb - np.array(c)) ** 2).sum(-1).astype(np.int32)
        better = d < best
        best[better] = d[better]
        idx[better] = i
    cls = np.where(best <= 12 ** 2, idx, -1)
    # Coastlines, rivers, county lines and contour outlines take the nearest clean colour.
    cls[ndimage.binary_dilation(rgb.max(axis=-1) < 60, iterations=1)] = -1
    # The blue epicentre star and its white outline hide the colour underneath.
    star = (rgb[..., 2] > 180) & (rgb[..., 0] < 90) & (rgb[..., 1] < 90)
    cls[ndimage.binary_dilation(star, iterations=8)] = -1
    unknown = cls < 0
    if unknown.any():
        _, (iy, ix) = ndimage.distance_transform_edt(unknown, return_indices=True)
        cls = cls[iy, ix]
    for x0, y0, x1, y1 in EXCLUDE:
        cls[y0:y1, x0:x1] = 0
    return cls.astype(np.int16)


def process(png_bytes: bytes, topo: dict, land: np.ndarray):
    rgb = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGB")).astype(np.int32)
    legend = read_legend(rgb)
    fit, cost, refit = fit_frame(rgb, coastline_points(topo))
    if cost > 10:
        raise ValueError(f"shakemap georeference check failed (cost {cost:.1f})")
    cls = classify(rgb, legend)
    lons = GRID["lon0"] + np.arange(GRID["nx"]) * GRID["res"]
    lats = GRID["lat0"] + np.arange(GRID["ny"]) * GRID["res"]
    lon2, lat2 = np.meshgrid(lons, lats)
    x, y = _project(fit, lon2, lat2)
    h, w = cls.shape
    xi, yi = np.round(x).astype(int), np.round(y).astype(int)
    inside = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < int(h * 0.86))
    grid = np.zeros(lon2.shape, np.int16)
    grid[inside] = cls[yi[inside], xi[inside]]
    # Lakes / reservoirs (and coastline mismatch) carry the sea colour on land:
    # give them the intensity of the nearest coloured land cell.
    holes = land & (grid == 0)
    # Tiny isolated "0級" specks (white map symbols) inside felt areas are holes too.
    lab, n = ndimage.label(land & (grid == 1))
    if n:
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
        holes |= np.isin(lab, np.flatnonzero(sizes <= 8) + 1)
    grid = np.where(holes, 0, grid)
    if holes.any() and (land & (grid > 0)).any():
        _, (iy, ix) = ndimage.distance_transform_edt(~(land & (grid > 0)), return_indices=True)  # noqa: E501
        grid = np.where(holes, grid[iy, ix], grid)
    grid = np.where(land, np.maximum(grid, 1), 0).astype(np.int16)  # row 0 = south
    return {"grid": grid, "legend": legend, "fit": fit, "cost": cost, "refit": refit}


def identifier_stamp(meta: dict) -> str:
    """'202610240925-EQ2026072-Shakemap' -> '202610240925' (origin time, minute)."""
    return (meta.get("identifier") or "").split("-", 1)[0]


def load_meta(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))["cwaopendata"]
