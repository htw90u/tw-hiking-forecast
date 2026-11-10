"""Hiking routes in Taiwan from OpenStreetMap (route=hiking relations) via the Overpass API.

Written to trails.json: {"time", "fields", "routes": [{"n", "ref", "net", "osm", "len", "l": [[lat, lon, lat, lon, ...], ...]}]}
Coordinates are integers in 1e-4 degree (about 11 m) after Douglas-Peucker simplification.
Data (c) OpenStreetMap contributors, Open Database License 1.0. Refreshed weekly; the previous file is kept
when Overpass is unreachable.
"""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from .fetch import SSL_CTX, USER_AGENT, FetchError
from .peaks import OVERPASS

# south, west, north, east: Taiwan main island (outlying islands have no named hiking route relations worth the size)
BBOX = (21.85, 119.3, 25.4, 122.1)
QUERY = '[out:json][timeout:240];relation["route"="hiking"]["name"]({},{},{},{});out geom;'.format(*BBOX)
MAX_AGE = timedelta(days=7)
SCALE = 1e4
TOL = 1.5  # simplification tolerance in 1e-4 degree units (about 17 m)
FIELDS = ["n", "ref", "net", "osm", "len", "l"]
NETS = {"iwn": 0, "nwn": 1, "rwn": 2, "lwn": 3}  # international / national / regional / local; others -> 4


def _dp(pts, tol):
    """Douglas-Peucker on [(x, y)] (iterative)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, idx = -1.0, a
        for i in range(a + 1, b):
            px, py = pts[i]
            d = math.hypot(px - ax, py - ay) if norm == 0 else abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def _km(lat1, lon1, lat2, lon2):
    return math.hypot((lat2 - lat1) * 111.2, (lon2 - lon1) * 111.2 * math.cos(math.radians((lat1 + lat2) / 2)))


def convert(data):
    """Overpass JSON ('out geom' of route relations) -> list of route dicts."""
    routes = []
    for el in data.get("elements", []):
        if el.get("type") != "relation":
            continue
        tags = el.get("tags", {})
        lines, seen = [], set()
        for m in el.get("members", []):
            geom = m.get("geometry")
            if m.get("type") != "way" or not geom or m.get("ref") in seen:
                continue
            seen.add(m.get("ref"))
            pts = [(round(g["lon"] * SCALE), round(g["lat"] * SCALE)) for g in geom if g]
            pts = _dp([p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]], TOL)
            if len(pts) >= 2:
                lines.append([c for x, y in pts for c in (y, x)])
        if not lines:
            continue
        length = sum(_km(l[i] / SCALE, l[i + 1] / SCALE, l[i + 2] / SCALE, l[i + 3] / SCALE) for l in lines for i in range(0, len(l) - 3, 2))
        routes.append({"n": tags.get("name:zh-Hant") or tags.get("name:zh") or tags["name"], "ref": tags.get("ref", ""),
                       "net": NETS.get(tags.get("network"), 4), "osm": el["id"], "len": round(length, 1), "l": lines})
    routes.sort(key=lambda r: (r["net"], -r["len"]))
    return routes


def fetch_overpass(log, timeout=300):
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    errors = []
    for url in OVERPASS:
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - try the next mirror
            errors.append(f"{url}: {e}")
            log.warn(f"trails: Overpass mirror failed: {url}: {e}")
    raise FetchError("all Overpass mirrors failed: " + " | ".join(errors))


def build(out_dir, log, now, fetch=None, force=False):
    """Write trails.json; returns (route count, refreshed?)."""
    dest = out_dir / "trails.json"
    prev = None
    if dest.exists():
        try:
            prev = json.loads(dest.read_text(encoding="utf-8"))
        except ValueError:
            prev = None
    if prev and not force and prev.get("fields") == FIELDS:
        try:
            if now - datetime.fromisoformat(prev["time"]) < MAX_AGE:
                return len(prev.get("routes", [])), False
        except (KeyError, ValueError):
            pass
    try:
        data = (fetch or fetch_overpass)(log)
    except FetchError:
        if prev:
            log.warn("trails: Overpass unreachable, keeping the previous file")
            return len(prev.get("routes", [])), False
        raise
    routes = convert(data)
    if not routes:
        raise FetchError("Overpass returned no hiking routes")
    dest.write_text(json.dumps({"time": now.isoformat(), "fields": FIELDS, "routes": routes}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log.info(f"trails: {len(routes)} routes, {dest.stat().st_size / 1e3:.0f} KB")
    return len(routes), True
