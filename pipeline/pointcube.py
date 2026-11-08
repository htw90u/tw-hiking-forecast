"""Time cubes of the multi-model layer for the point card: one small file per model and variable.

The map layer keeps one picture per time step. The point card needs one number per step at a single place, which would mean
downloading and decoding every picture. Here the pictures of a model are stacked once at build time into a single file
(``mm_<model>_pts_<variable>.json``): int16 values x 10, shape (steps, ny, nx), rows from the south, base64 encoded.
"""
import base64
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

VERSION = 1
CUBE_REGION = {"lon": (116.0, 126.0), "lat": (20.0, 28.0)}     # Taiwan and the sea around it (the same area as the wind files)
NODATA = -32768


def read_png(out_dir: Path, meta_path: str) -> tuple:
    """(values, lon0, lat0, res) of one grid picture: values float, rows from the south, cell centres lon0 / lat0."""
    meta = json.loads((out_dir / meta_path).read_text(encoding="utf-8"))
    rgba = np.asarray(Image.open(out_dir / meta["png"]).convert("RGBA")).astype(np.int64)
    code = rgba[..., 0] * 256 + rgba[..., 1]
    vals = np.where(code == 0, np.nan, meta["offset"] + (code - 1) * meta["scale"])[::-1]
    w, s, e, n = meta["bounds"]
    res = (e - w) / vals.shape[1]
    return vals, w + res / 2, s + res / 2, res


def crop(vals, lon0, lat0, res, region=CUBE_REGION, step=1) -> tuple:
    """Cells whose centre lies in the region (every `step`-th cell): (values, lon0, lat0, res)."""
    lons = lon0 + res * np.arange(vals.shape[1])
    lats = lat0 + res * np.arange(vals.shape[0])
    ci = np.where((lons >= region["lon"][0] - 1e-6) & (lons <= region["lon"][1] + 1e-6))[0][::step]
    ri = np.where((lats >= region["lat"][0] - 1e-6) & (lats <= region["lat"][1] + 1e-6))[0][::step]
    return vals[np.ix_(ri, ci)], float(lons[ci[0]]), float(lats[ri[0]]), res * step


def pack(stack, times, init, grid) -> dict:
    """Cube object for the file: stack is (steps, ny, nx) in the unit of the variable."""
    a = np.where(np.isfinite(stack), np.clip(np.rint(stack * 10), -32767, 32767), NODATA).astype("<i2")
    return {"init": init, "ver": VERSION, "grid": grid, "scale": 10, "times": times, "d": base64.b64encode(a.tobytes()).decode("ascii")}


def unpack(obj) -> np.ndarray:
    g = obj["grid"]
    a = np.frombuffer(base64.b64decode(obj["d"]), "<i2").reshape(len(obj["times"]), g["ny"], g["nx"]).astype(float)
    return np.where(a == NODATA, np.nan, a / obj["scale"])


def cube_from_frames(out_dir: Path, frames: list, init: str, step: int = 1) -> dict | None:
    """frames: [{time, meta}] of one variable -> cube object (None when there is nothing)."""
    layers, grid, times = [], None, []
    for f in frames:
        try:
            vals, lon0, lat0, res = read_png(out_dir, f["meta"])
        except (OSError, KeyError, ValueError):
            continue
        sub, lo, la, r = crop(vals, lon0, lat0, res, step=step)
        g = {"lat0": la, "lon0": lo, "res": round(r, 6), "nx": sub.shape[1], "ny": sub.shape[0]}
        if grid is None:
            grid = g
        if g != grid:
            continue
        layers.append(sub)
        times.append(f["time"])
    if not layers:
        return None
    return pack(np.stack(layers), times, init, grid)


def speed_cube(u_rows, v_rows, times, init, grid) -> dict:
    """10 m wind speed (m/s) cube from the u / v lists of a wind file (0.1 m/s, None for no data, rows from the south)."""
    def arr(rows):
        return np.array([[np.nan if x is None else x / 10 for x in r] for r in rows], float).reshape(len(rows), grid["ny"], grid["nx"])
    return pack(np.hypot(arr(u_rows), arr(v_rows)), times, init, grid)


def write(out_dir: Path, name: str, obj: dict) -> str:
    tmp = out_dir / (name + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmp.replace(out_dir / name)
    return name


def build_model(out_dir: Path, mid: str, entry: dict) -> dict:
    """25 km models (modelgrid): rain, temp, msl from their pictures, wind speed from the wind file. Returns {variable: file}."""
    files = {}
    for var in ("rain", "temp", "msl"):
        frames = entry.get(var) or []
        cube = cube_from_frames(out_dir, frames, entry.get("init"))
        if cube:
            files[var] = write(out_dir, f"mm_{mid}_pts_{var}.json", cube)
    wind_file = entry.get("wind")
    if wind_file and (out_dir / wind_file).exists():
        w = json.loads((out_dir / wind_file).read_text(encoding="utf-8"))
        files["wind"] = write(out_dir, f"mm_{mid}_pts_wind.json", speed_cube(w["u"], w["v"], w["steps"], entry.get("init"), w["grid"]))
    return files


def build_wrf3(out_dir: Path, wrf3: dict) -> dict:
    """WRF 3 km: temperature and rain pictures (0.03 degree) thinned to the 0.06 degree grid of its wind field, wind speed from wrf3.json."""
    init, files = wrf3.get("time"), {}
    steps = wrf3["steps"]
    for var, key in (("temp", "temp"), ("rain", "rain")):
        frames = [{"time": steps[x["fh"] // 6], "meta": x["meta"]} for x in wrf3.get(key, [])]
        cube = cube_from_frames(out_dir, frames, init, step=2)
        if cube:
            files[var] = write(out_dir, f"mm_wrf3_pts_{var}.json", cube)
    path = out_dir / "wrf3.json"
    if path.exists():
        w = json.loads(path.read_text(encoding="utf-8"))
        g = w["grid"]
        n = len(w["steps"])

        def dec(key):
            return np.frombuffer(base64.b64decode(w["wind"][key]), "<i2").reshape(n, g["ny"], g["nx"]).astype(float) / 10
        files["wind"] = write(out_dir, "mm_wrf3_pts_wind.json", pack(np.hypot(dec("u10"), dec("v10")), w["steps"], w["init"], g))
    return files
