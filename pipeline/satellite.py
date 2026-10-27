"""Himawari imagery from CWA as numbers (O-B0056 IR brightness temperature,
O-B0055 visible albedo): Lambert-conformal GeoTIFF -> lon/lat grid.

Using the values instead of the pre-rendered JPEG lets the web app draw the
clouds with interpolation (smooth at high zoom), choose colour scales and
report cloud-top temperature at a point.
"""
import io
import math
import zipfile

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

# Output grid (cell centres) around Taiwan, WGS84. The source pixels are about 1.9 km, so 0.01 degree (1.1 km) cells
# with bilinear sampling keep all the detail (0.02 degree nearest-pixel sampling threw part of it away).
GRID = {"lon0": 116.0, "lat0": 19.0, "res": 0.01, "nx": 1101, "ny": 951}

A = 6378137.0
INV_F = 298.257223563
E = math.sqrt(2 / INV_F - 1 / INV_F ** 2)


def read_geotiff(zip_bytes: bytes):
    """-> (array uint16, geo dict) from the zipped CWA GeoTIFF."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith((".tif", ".gtif", ".tiff")))
        im = Image.open(io.BytesIO(z.read(name)))
        im.load()
    tags = im.tag_v2
    sx, sy = tags[33550][:2]
    tie = tags[33922]
    params = tags[34736]  # (origin lat, central meridian, std parallel 1, std parallel 2, false E, false N, inv f, a)
    geo = {"x0": tie[3], "y0": tie[4], "sx": sx, "sy": sy, "lat0": params[0], "lon0": params[1],
           "lat1": params[2], "lat2": params[3], "fe": params[4], "fn": params[5], "name": name}
    return np.asarray(im).astype(np.float32), geo


def _m(phi):
    return np.cos(phi) / np.sqrt(1 - (E * np.sin(phi)) ** 2)


def _t(phi):
    s = E * np.sin(phi)
    return np.tan(np.pi / 4 - phi / 2) / ((1 - s) / (1 + s)) ** (E / 2)


def lcc_forward(lon, lat, geo):
    """Lambert conformal conic (2SP, ellipsoidal; Snyder 15-7..15-10) -> projected metres."""
    p1, p2, p0 = (math.radians(geo[k]) for k in ("lat1", "lat2", "lat0"))
    m1, m2 = _m(p1), _m(p2)
    t1, t2, t0 = _t(p1), _t(p2), _t(p0)
    n = (math.log(m1) - math.log(m2)) / (math.log(t1) - math.log(t2))
    F = m1 / (n * t1 ** n)
    rho0 = A * F * t0 ** n
    rho = A * F * _t(np.radians(lat)) ** n
    theta = n * np.radians(np.asarray(lon) - geo["lon0"])
    return geo["fe"] + rho * np.sin(theta), geo["fn"] + rho0 - rho * np.cos(theta)


def resample(arr, geo, grid=GRID, bilinear=True):
    """Resample converted values (NaN = no data) to the lon/lat grid (row 0 = south); NaN outside the image.

    Bilinear between the four nearest source pixel centres (NaN neighbours are left out of the average), so the
    picture is smooth instead of blocky; bilinear=False takes the single nearest pixel.
    """
    lons = grid["lon0"] + np.arange(grid["nx"]) * grid["res"]
    lats = grid["lat0"] + np.arange(grid["ny"]) * grid["res"]
    lon2, lat2 = np.meshgrid(lons, lats)
    x, y = lcc_forward(lon2, lat2, geo)
    fc = (x - geo["x0"]) / geo["sx"] - 0.5      # fractional pixel index of the pixel centres
    fr = (geo["y0"] - y) / geo["sy"] - 0.5
    h, w = arr.shape
    out = np.full(lon2.shape, np.nan, np.float32)
    if not bilinear:
        col, row = np.floor(fc + 0.5).astype(int), np.floor(fr + 0.5).astype(int)
        ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
        out[ok] = arr[row[ok], col[ok]]
        return out
    c0, r0 = np.floor(fc).astype(int), np.floor(fr).astype(int)
    tx, ty = fc - c0, fr - r0
    inside = (fc >= -0.5) & (fc <= w - 0.5) & (fr >= -0.5) & (fr <= h - 0.5)
    num = np.zeros(lon2.shape, np.float64)
    den = np.zeros(lon2.shape, np.float64)
    for dc, dr, wt in ((0, 0, (1 - tx) * (1 - ty)), (1, 0, tx * (1 - ty)), (0, 1, (1 - tx) * ty), (1, 1, tx * ty)):
        c, r = np.clip(c0 + dc, 0, w - 1), np.clip(r0 + dr, 0, h - 1)
        v = arr[r, c]
        good = ~np.isnan(v)
        num += np.where(good, v * wt, 0.0)
        den += np.where(good, wt, 0.0)
    ok = inside & (den > 0.5)       # keep cells whose neighbourhood is mostly valid
    out[ok] = (num[ok] / den[ok]).astype(np.float32)
    return out


def ir_celsius(raw):
    """Brightness temperature stored as K x 100 -> degrees Celsius."""
    out = raw / 100.0 - 273.15
    return np.where((raw <= 0) | (raw >= 65535), np.nan, out)


def vis_albedo(raw):
    """Albedo stored as percent x 100 -> fraction (0..~1.2)."""
    return np.where((raw <= 0) | (raw >= 65535), np.nan, raw / 10000.0)
