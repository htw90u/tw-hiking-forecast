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


class TownLocator:
    """Point -> (county, town) from the township polygons (MOI boundaries via taiwan-atlas)."""

    def __init__(self, topo: dict, snap_km: float = 3.0):
        self.items = []
        for props, polys in polygons(topo, "towns"):
            xs = [x for poly in polys for x, _ in poly[0]]
            ys = [y for poly in polys for _, y in poly[0]]
            self.items.append((props, polys, (min(xs), min(ys), max(xs), max(ys))))
        self.snap = snap_km

    @staticmethod
    def _inside(ring, x, y):
        hit = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                hit = not hit
            j = i
        return hit

    def locate(self, lat: float, lon: float):
        for props, polys, (x0, y0, x1, y1) in self.items:
            if not (x0 <= lon <= x1 and y0 <= lat <= y1):
                continue
            for poly in polys:
                if self._inside(poly[0], lon, lat) and not any(self._inside(h, lon, lat) for h in poly[1:]):
                    return props.get("COUNTYNAME"), props.get("TOWNNAME")
        # Simplified coastlines miss some capes and islets: snap to the nearest boundary vertex.
        best, best_d = None, self.snap
        kx = 111.2 * np.cos(np.radians(lat))
        for props, polys, (x0, y0, x1, y1) in self.items:
            if (max(x0 - lon, 0, lon - x1) * kx) > best_d or (max(y0 - lat, 0, lat - y1) * 111.2) > best_d:
                continue
            for poly in polys:
                for x, y in poly[0]:
                    d = float(np.hypot((x - lon) * kx, (y - lat) * 111.2))
                    if d < best_d:
                        best, best_d = props, d
        return (best.get("COUNTYNAME"), best.get("TOWNNAME")) if best else (None, None)


    def locate_all(self, lat: float, lon: float, edge_km: float = 0.4):
        """Containing township plus any whose boundary is within edge_km.

        Peaks often sit on ridge-line boundaries, and the simplified polygons can be a few hundred
        metres off, so a peak near a boundary is listed under both townships.
        """
        first = self.locate(lat, lon)
        out = [first] if first[0] else []
        kx = 111.2 * np.cos(np.radians(lat))
        for props, polys, (x0, y0, x1, y1) in self.items:
            key = (props.get("COUNTYNAME"), props.get("TOWNNAME"))
            if key in out or (max(x0 - lon, 0, lon - x1) * kx) > edge_km or (max(y0 - lat, 0, lat - y1) * 111.2) > edge_km:
                continue
            if any(_seg_dist_km(poly[0], lat, lon, kx) <= edge_km for poly in polys):
                out.append(key)
        return out


def _seg_dist_km(ring, lat, lon, kx) -> float:
    """Shortest distance (km) from the point to a ring's edges, on a local flat projection."""
    pts = np.array([((x - lon) * kx, (y - lat) * 111.2) for x, y in ring])
    a, b = pts[:-1], pts[1:]
    ab = b - a
    t = np.clip(-(a * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-12), 0, 1)
    proj = a + ab * t[:, None]
    return float(np.sqrt((proj * proj).sum(1)).min()) if len(pts) > 1 else float("inf")


def area_names(places) -> str:
    """[(county, town), ...] -> '南投縣信義鄉／高雄市桃源區'."""
    return "／".join(area_name(c, t) for c, t in places)


def area_name(county, town) -> str:
    """'台東縣', '成功鎮' -> '臺東縣成功鎮' (official 臺)."""
    return f"{county or ''}{town or ''}".replace("台", "臺")
