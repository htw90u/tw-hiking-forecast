"""Minimal TopoJSON decoding and rasterization helpers."""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def load_topo(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def decode_arcs(topo: dict) -> list:
    sc, tl = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sc[0] + tl[0], y * sc[1] + tl[1]))
        arcs.append(pts)
    return arcs


def _ring(arcs, idx):
    pts = []
    for i in idx:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(a if not pts else a[1:])
    return pts


def polygons(topo: dict, obj: str):
    """Yield (properties, [polygon rings...]) where each polygon is [outer, *holes]."""
    arcs = decode_arcs(topo)
    for g in topo["objects"][obj]["geometries"]:
        if g["type"] == "Polygon":
            polys = [g["arcs"]]
        elif g["type"] == "MultiPolygon":
            polys = g["arcs"]
        else:
            continue
        yield g.get("properties", {}), [[_ring(arcs, r) for r in poly] for poly in polys]


def land_mask(topo: dict, lon0: float, lat0: float, res: float, nx: int, ny: int) -> np.ndarray:
    """Boolean mask (row 0 = south) of grid cell centres that fall on land."""
    scale = 4  # supersample for smoother coastlines
    img = Image.new("L", (nx * scale, ny * scale), 0)
    draw = ImageDraw.Draw(img)

    def px(lon, lat):
        return ((lon - lon0 + res / 2) / res * scale, (ny - (lat - lat0 + res / 2) / res) * scale)

    # Only outer rings: county "holes" are enclaves of other counties (e.g.
    # Taipei inside New Taipei), so the union of outer rings is the land area.
    for _, polys in polygons(topo, "counties"):
        for poly in polys:
            draw.polygon([px(*p) for p in poly[0]], fill=255)
    a = np.asarray(img.resize((nx, ny), Image.BILINEAR)) >= 128
    return a[::-1]
