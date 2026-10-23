"""Quantitative precipitation forecast (QPF) images -> georeferenced class grids.

CWA publishes the 12-hour QPF (F-C0035-015/017/023/024) only as PNG maps
without coordinates.  The main map panel is a plain lon/lat (equirectangular)
projection.  The pixel transform below was fitted by chamfer-matching the
county boundaries drawn on the image against Taiwan county polygons
(taiwan-atlas, MOI data); the fit is re-verified on every run and re-fitted
automatically if CWA changes the layout.
"""
import io
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage, optimize

QPF_IDS = ["F-C0035-015", "F-C0035-017", "F-C0035-023", "F-C0035-024"]

# x = AX * (lon - 121) + BX ; y = AY * (lat - 23.5) + BY   (pixels, image 1245x1500)
DEFAULT_FIT = (357.86, 740.51, -358.62, 847.60)

LEGEND_X = 1177
LEGEND_Y = (600, 1420)
# Legend boxes from the bottom (lowest) to the top; values in mm / 12 h.
CLASS_BOUNDS = [(0.5, 1), (1, 2), (2, 5), (5, 10), (10, 15), (15, 20), (20, 30), (30, 40), (40, 50),
                (50, 70), (70, 90), (90, 110), (110, 130), (130, 150), (150, 200), (200, 300), (300, None)]
SEA_RGB = (237, 249, 254)
DRY_RGB = (255, 255, 255)

# Output grid (cell centres), WGS84.
GRID = {"lon0": 119.3, "lat0": 21.85, "res": 0.01, "nx": 290, "ny": 356}

# Image regions that are not part of the geographic main panel.
EXCLUDE = [(0, 0, 1245, 152), (88, 198, 502, 662), (50, 1270, 340, 1445), (1060, 680, 1245, 1500), (900, 1420, 1245, 1500)]


def boundary_points(topo_path: Path) -> np.ndarray:
    """Densified county-boundary vertices of the main island (lon, lat)."""
    topo = json.loads(Path(topo_path).read_text())
    sc, tl = topo["transform"]["scale"], topo["transform"]["translate"]
    used = set()

    def collect(a):
        if isinstance(a, int):
            used.add(a if a >= 0 else ~a)
        else:
            for x in a:
                collect(x)

    for geom in topo["objects"]["counties"]["geometries"]:
        collect(geom.get("arcs", []))
    dense = []
    for i, arc in enumerate(topo["arcs"]):
        if i not in used:
            continue
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sc[0] + tl[0], y * sc[1] + tl[1]))
        pts = np.array(pts)
        for p, q in zip(pts[:-1], pts[1:]):
            n = max(2, int(np.hypot(*(q - p)) / 0.002))
            dense.append(p + (q - p) * np.linspace(0, 1, n)[:, None])
    pts = np.concatenate(dense)
    sel = (pts[:, 0] > 119.9) & (pts[:, 0] < 122.2) & (pts[:, 1] > 21.8) & (pts[:, 1] < 25.4)
    return pts[sel]


def _project(fit, lon, lat):
    ax, bx, ay, by = fit
    return ax * (lon - 121.0) + bx, ay * (lat - 23.5) + by


def _cost(fit, pts, dist):
    h, w = dist.shape
    x, y = _project(fit, pts[:, 0], pts[:, 1])
    xi = np.clip(np.round(x).astype(int), 0, w - 1)
    yi = np.clip(np.round(y).astype(int), 0, h - 1)
    return float(np.mean(np.minimum(dist[yi, xi], 15) ** 2))


def verify_fit(rgb: np.ndarray, pts: np.ndarray, fit=DEFAULT_FIT, threshold: float = 45.0):
    """Return (fit, cost, refitted). Re-fits if the stored transform drifts."""
    dark = rgb.max(axis=2) < 90
    region = np.zeros_like(dark)
    region[160:1480, 520:1150] = True
    dist = ndimage.distance_transform_edt(~(dark & region))
    cost = _cost(fit, pts, dist)
    if cost <= threshold:
        return tuple(fit), cost, False
    r = optimize.minimize(lambda p: _cost(p, pts, dist), fit, method="Nelder-Mead",
                          options={"maxiter": 4000, "xatol": 1e-3, "fatol": 1e-4})
    return tuple(r.x), float(r.fun), True


def read_legend(rgba: np.ndarray) -> list:
    """Legend colours ordered from the lowest class to the highest."""
    col = rgba[LEGEND_Y[0]:LEGEND_Y[1], LEGEND_X, :3]
    runs, prev, start = [], None, 0
    for i, c in enumerate(map(tuple, col)):
        if c != prev:
            if prev is not None and i - start >= 20:
                runs.append(prev)
            prev, start = c, i
    if prev is not None and len(col) - start >= 20:
        runs.append(prev)
    colours = [tuple(int(v) for v in c) for c in runs if c != SEA_RGB and c != DRY_RGB]
    return colours[::-1]


def classify(rgba: np.ndarray, legend: list) -> np.ndarray:
    """Pixel classes: 0 no rain / outside, 2.. legend classes (1 is set later for dry land)."""
    rgb = rgba[..., :3].astype(np.int32)
    h, w, _ = rgb.shape
    pal = [SEA_RGB, DRY_RGB] + list(legend)
    best = np.full((h, w), np.iinfo(np.int32).max, np.int32)
    idx = np.zeros((h, w), np.int16)
    for i, c in enumerate(pal):
        d = ((rgb - np.array(c, np.int32)) ** 2).sum(-1)
        better = d < best
        best[better] = d[better]
        idx[better] = i
    cls = np.where(best <= 12 ** 2, idx, -1)
    # Lines, labels and anti-aliased edges take the class of the nearest clean pixel.
    unknown = cls < 0
    if unknown.any():
        _, (iy, ix) = ndimage.distance_transform_edt(unknown, return_indices=True)
        cls = cls[iy, ix]
    for x0, y0, x1, y1 in EXCLUDE:
        cls[y0:y1, x0:x1] = 0
    return cls.astype(np.int16)


def resample(cls: np.ndarray, fit) -> np.ndarray:
    g = GRID
    lons = g["lon0"] + np.arange(g["nx"]) * g["res"]
    lats = g["lat0"] + np.arange(g["ny"]) * g["res"]
    lon2, lat2 = np.meshgrid(lons, lats)
    x, y = _project(fit, lon2, lat2)
    h, w = cls.shape
    xi, yi = np.round(x).astype(int), np.round(y).astype(int)
    inside = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
    out = np.zeros(lon2.shape, np.int16)
    out[inside] = cls[yi[inside], xi[inside]]
    return out  # row 0 = south


def period_start(sent_iso: str) -> datetime:
    """Start of period (I): the issue time floored to 02/08/14/20 local time."""
    t = datetime.fromisoformat(sent_iso)
    h = t.hour - ((t.hour - 2) % 6)
    return t.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=h)


def process(png_bytes: bytes, pts: np.ndarray, land: np.ndarray):
    """``land``: boolean mask on GRID (row 0 = south). Dry land and sea share one
    colour on the CWA image, so land cells without rain become class 1."""
    rgba = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGBA"))
    legend = read_legend(rgba)
    if len(legend) != len(CLASS_BOUNDS):
        raise ValueError(f"QPF legend has {len(legend)} colours, expected {len(CLASS_BOUNDS)}")
    fit, cost, refit = verify_fit(rgba[..., :3].astype(int), pts)
    if cost > 60:
        raise ValueError(f"QPF georeference check failed (cost {cost:.1f})")
    grid = resample(classify(rgba, legend), fit)
    grid = np.where(land, np.maximum(grid, 1), 0).astype(np.int16)
    title = Image.fromarray(rgba[0:150, 0:1000])
    buf = io.BytesIO()
    title.save(buf, "PNG", optimize=True)
    return {"grid": grid, "legend": legend, "fit": fit, "cost": cost, "refit": refit, "title_png": buf.getvalue()}
