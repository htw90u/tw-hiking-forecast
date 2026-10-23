"""CWA lat/lon grid products -> compact 16-bit PNG layers.

Encoding (shared with the web client, see site/js/grid.js):
  * pixel value code = R * 256 + G  (B is 0, alpha is 255)
  * code 0 means "no data"; otherwise value = offset + (code - 1) * scale
  * row 0 is the northern edge; bounds are cell edges in WGS84 degrees
"""
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

# CWA grids are published on TWD67 geographic coordinates.  The shift below is
# the mean TWD67 -> WGS84 difference measured from station metadata that
# carries both coordinate sets (e.g. station C0TB40: +0.008163 lon, -0.001804 lat).
TWD67_TO_WGS84 = (0.00816, -0.00180)

# Region kept for map layers (Taiwan main island, Penghu and surrounding sea).
CROP = {"lon": (118.9, 123.2), "lat": (20.9, 26.6)}


def parse_values(text: str) -> np.ndarray:
    return np.array(text.replace(",", " ").split(), dtype=np.float32)


def make_grid(values, nx, ny, lon0, lat0, res, nodata=(), valid_min=None, twd67=True):
    """Build a grid dict. ``lon0/lat0`` is the centre of the south-west cell."""
    arr = np.asarray(values, dtype=np.float32)
    if arr.size != nx * ny:
        raise ValueError(f"grid size mismatch: got {arr.size}, expected {nx}x{ny}")
    arr = arr.reshape(ny, nx)  # row 0 = south
    mask = np.zeros(arr.shape, bool)
    for nd in nodata:
        mask |= np.isclose(arr, nd)
    if valid_min is not None:
        mask |= arr < valid_min
    arr = np.where(mask, np.nan, arr)
    if twd67:
        lon0 += TWD67_TO_WGS84[0]
        lat0 += TWD67_TO_WGS84[1]
    return {"data": arr, "lon0": lon0, "lat0": lat0, "res": res}


def crop(grid, region=CROP):
    a, lon0, lat0, res = grid["data"], grid["lon0"], grid["lat0"], grid["res"]
    ny, nx = a.shape
    i0 = max(0, int(np.floor((region["lon"][0] - lon0) / res)))
    i1 = min(nx, int(np.ceil((region["lon"][1] - lon0) / res)) + 1)
    j0 = max(0, int(np.floor((region["lat"][0] - lat0) / res)))
    j1 = min(ny, int(np.ceil((region["lat"][1] - lat0) / res)) + 1)
    return {"data": a[j0:j1, i0:i1], "lon0": lon0 + i0 * res, "lat0": lat0 + j0 * res, "res": res}


def bounds(grid):
    ny, nx = grid["data"].shape
    r = grid["res"]
    w, s = grid["lon0"] - r / 2, grid["lat0"] - r / 2
    return [round(w, 5), round(s, 5), round(w + nx * r, 5), round(s + ny * r, 5)]


def encode_png(grid, scale: float, offset: float) -> bytes:
    a = grid["data"]
    code = np.zeros(a.shape, np.int64)
    ok = ~np.isnan(a)
    code[ok] = np.clip(np.round((a[ok] - offset) / scale) + 1, 1, 65535).astype(np.int64)
    code = code[::-1]  # north up
    rgba = np.zeros(code.shape + (4,), np.uint8)
    rgba[..., 0] = code >> 8
    rgba[..., 1] = code & 255
    rgba[..., 3] = 255
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def decode_png(data: bytes, scale: float, offset: float) -> np.ndarray:
    """Inverse of encode_png (used by tests); returns north-up float array."""
    rgba = np.asarray(Image.open(io.BytesIO(data)).convert("RGBA")).astype(np.int64)
    code = rgba[..., 0] * 256 + rgba[..., 1]
    out = offset + (code - 1) * scale
    return np.where(code == 0, np.nan, out)


def write_layer(out_dir: Path, name: str, grid, scale, offset, meta: dict) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    png = encode_png(grid, scale, offset)
    (out_dir / f"{name}.png").write_bytes(png)
    a = grid["data"]
    info = {
        "id": name,
        "png": f"grids/{name}.png",
        "bounds": bounds(grid),
        "size": [int(a.shape[1]), int(a.shape[0])],
        "scale": scale,
        "offset": offset,
        "max": None if np.all(np.isnan(a)) else round(float(np.nanmax(a)), 2),
        **meta,
    }
    (out_dir / f"{name}.json").write_text(json.dumps(info, ensure_ascii=False))
    return info


# ---------------------------------------------------------------- product readers

def read_qpesums(doc: dict):
    """O-A0059-001 / O-B0045-001 / F-B0046-001 style (lowercase keys)."""
    ds = doc["cwaopendata"]["dataset"]
    p = ds["datasetInfo"]["parameterSet"]
    values = parse_values(ds["contents"]["content"])
    return values, {
        "nx": int(p["GridDimensionX"]), "ny": int(p["GridDimensionY"]),
        "lon0": float(p["StartPointLongitude"]), "lat0": float(p["StartPointLatitude"]),
        "res": float(p["GridResolution"]), "time": p["DateTime"],
    }


def read_analysis(doc: dict):
    """O-A0040-004 / O-A0038-003 style (GeoInfo + Resource.Content)."""
    ds = doc["cwaopendata"]["dataset"]
    g = ds["GeoInfo"]
    values = parse_values(ds["Resource"]["Content"])
    lon0, lat0 = float(g["BottomLeftLongitude"]), float(g["BottomLeftLatitude"])
    lon1, lat1 = float(g["TopRightLongitude"]), float(g["TopRightLatitude"])
    res = 0.03
    nx = int(round((lon1 - lon0) / res)) + 1
    ny = int(round((lat1 - lat0) / res)) + 1
    time = (ds.get("DataTime") or ds.get("ObsTime") or {}).get("DateTime")
    return values, {"nx": nx, "ny": ny, "lon0": lon0, "lat0": lat0, "res": res, "time": time}


# id, dataset key, reader, nodata values, valid_min, scale, offset, label, unit
PRODUCTS = [
    ("radar", "Observation/O-A0059-001.json", read_qpesums, (-99, -999), None, 0.1, -100.0, "雷達回波", "dBZ"),
    ("qpe1h", "Observation/O-B0045-001.json", read_qpesums, (-1,), 0, 0.1, 0.0, "過去1小時雨量(雷達估計)", "mm"),
    ("qpf1h", "Forecast/F-B0046-001.json", read_qpesums, (-99,), 0, 0.1, 0.0, "未來1小時雨量(臨近預報)", "mm"),
    ("rainday", "Observation/O-A0040-004.json", read_analysis, (-1,), 0, 0.1, 0.0, "今日累積雨量(測站內插)", "mm"),
    ("temp", "Observation/O-A0038-003.json", read_analysis, (-999,), -60, 0.1, -100.0, "溫度分析", "°C"),
]


def build_product(doc, reader, nodata, valid_min):
    values, p = reader(doc)
    g = make_grid(values, p["nx"], p["ny"], p["lon0"], p["lat0"], p["res"], nodata, valid_min)
    return crop(g), p["time"]
