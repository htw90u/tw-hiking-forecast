"""Named mountain peaks in Taiwan from OpenStreetMap (natural=peak) via the Overpass API.

Each peak also gets its county and township (MOI boundaries) so same-name peaks can be
told apart, and optional list tags (百岳, 小百岳, ...) from pipeline/data/peak_lists/*.json.

Data © OpenStreetMap contributors, Open Database License 1.0. Peaks change slowly,
so the list is refreshed weekly and the previous file is kept when Overpass is
unreachable. Peaks that are already CWA hiking forecast spots are left out so the
map shows each mountain once.
"""
import hashlib
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from . import geo
from .fetch import SSL_CTX, USER_AGENT, FetchError

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
# south, west, north, east: Taiwan with Penghu, Kinmen, Matsu, Green Island and Orchid Island
BBOX = (21.85, 118.1, 26.4, 122.1)
QUERY = '[out:json][timeout:180];node["natural"="peak"]["name"]({},{},{},{});out body;'.format(*BBOX)
MAX_AGE = timedelta(days=7)
NAME_KEYS = ("name:zh-Hant", "name:zh_TW", "name:zh-TW", "name:zh", "name")
FIELDS = ["n", "lat", "lon", "ele", "osm", "area", "tags", "est"]  # est = 1: elevation estimated from a terrain model
ENRICH_VERSION = 3  # 2: peaks outside Taiwan's townships (Fujian coast) dropped; 3: missing elevations estimated
ROOT = Path(__file__).resolve().parent.parent
TOPO = ROOT / "site" / "geo" / "towns-10t.json"
LISTS_DIR = Path(__file__).resolve().parent / "data" / "peak_lists"


def _km(lat1, lon1, lat2, lon2):
    dy = (lat2 - lat1) * 111.2
    dx = (lon2 - lon1) * 111.2 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


# CWA hiking-forecast coordinates can be a few km from the summit: an OSM peak with the same
# name within this distance is taken as that mountain's true position.
MATCH_KM = 5.0


def norm_name(n):
    """'奇萊主峰' / '奇萊主山' -> '奇萊': CWA and OSM differ in how they name main summits."""
    return re.sub(r"(主峰|主山)$", "", (n or "").strip())


def same_name(a, b):
    return a == b or norm_name(a) == norm_name(b)


def match_cwa(data, cwa_spots):
    """{spot key: [lat, lon, ele, osm id]} — the nearest same-name OSM peak within MATCH_KM of each CWA mountain."""
    nodes = []
    for el in data.get("elements", []):
        if el.get("type") == "node" and "lat" in el:
            name = pick_name(el.get("tags", {}))
            if name:
                nodes.append((name, el["lat"], el["lon"], parse_ele(el.get("tags", {}).get("ele")), el.get("id")))
    out = {}
    for k, n, lat, lon in cwa_spots:
        cands = [(d, x) for x in nodes if same_name(n, x[0]) and (d := _km(lat, lon, x[1], x[2])) <= MATCH_KM]
        if cands:
            _, (_, la, lo, ele, osm) = min(cands)
            out[k] = [round(la, 5), round(lo, 5), ele, osm]
    return out


def annotate_spots(out_dir, matches, locator):
    """Add the township ('a') to every spot and the OSM summit position ('plat', 'plon', 'ele') to matched mountains."""
    idx = out_dir / "spots" / "index.json"
    if not idx.exists():
        return 0
    doc = json.loads(idx.read_text(encoding="utf-8"))
    for s in doc.get("spots", []):
        m = matches.get(s["k"]) if s.get("c") == "mountain" else None
        if m:
            s["plat"], s["plon"], s["ele"] = m[0], m[1], m[2]
        else:
            for f in ("plat", "plon", "ele"):
                s.pop(f, None)
        s["a"] = geo.area_names(locator.locate_all(s.get("plat", s["lat"]), s.get("plon", s["lon"])))
    tmp = idx.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(idx)
    return sum(1 for s in doc.get("spots", []) if "plat" in s)


def parse_ele(v):
    """'3952', '3952 m', '3,952.5' -> float metres; None when missing or implausible for Taiwan."""
    if v is None:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(v).replace(",", ""))
    if not m:
        return None
    ele = float(m.group())
    return round(ele) if -50 <= ele <= 4000 else None


def pick_name(tags):
    for k in NAME_KEYS:
        n = (tags.get(k) or "").strip()
        if n:
            return n
    return ""


def parse(data, cwa_mountains=()):
    """Overpass JSON -> [[name, lat, lon, ele, osm_id], ...], highest first.

    cwa_mountains: iterable of (name, lat, lon) for CWA hiking spots; a peak with the
    same name (see same_name) within MATCH_KM is dropped: the map shows the forecast mountain. Same-name peaks closer than 200 m are merged.
    """
    cwa = list(cwa_mountains)
    out = []
    for el in data.get("elements", []):
        if el.get("type") != "node" or "lat" not in el:
            continue
        tags = el.get("tags", {})
        name = pick_name(tags)
        if not name:
            continue
        lat, lon = el["lat"], el["lon"]
        if not (BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]):
            continue
        if any(same_name(n, name) and _km(lat, lon, la, lo) <= MATCH_KM for n, la, lo in cwa):
            continue
        if any(p[0] == name and _km(lat, lon, p[1], p[2]) < 0.2 for p in out):
            continue
        out.append([name, round(lat, 5), round(lon, 5), parse_ele(tags.get("ele")), el.get("id")])
    out.sort(key=lambda p: (p[3] is None, -(p[3] or 0)))
    return out


def fetch_overpass(log, timeout=240):
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    errors = []
    for url in OVERPASS:
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - try the next mirror
            errors.append(f"{url}: {e}")
            log.warn(f"peaks: Overpass mirror failed: {url}: {e}")
    raise FetchError("all Overpass mirrors failed: " + " | ".join(errors))


def load_lists(lists_dir=LISTS_DIR):
    """Peak lists for tags: [{"id", "label", "match_km", "peaks": [{"n", "lat"?, "lon"?, "min_ele"?}]}]."""
    out = []
    for f in sorted(Path(lists_dir).glob("*.json")) if Path(lists_dir).is_dir() else []:
        d = json.loads(f.read_text(encoding="utf-8"))
        if d.get("peaks"):
            out.append(d)
    return out


def lists_version(lists) -> str:
    # ENRICH_VERSION changes whenever the area / filtering rules change, so cached files are re-processed.
    return hashlib.sha1(json.dumps([ENRICH_VERSION, lists], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


def match_tags(name, lat, lon, ele, lists):
    """List ids whose entries match by name and position (or, without coordinates, a minimum elevation)."""
    tags = []
    for lst in lists:
        km = lst.get("match_km", 1.5)
        for e in lst["peaks"]:
            if e["n"] != name:
                continue
            if "lat" in e and "lon" in e:
                ok = _km(lat, lon, e["lat"], e["lon"]) <= km
            else:
                ok = ele is not None and ele >= e.get("min_ele", 0)
            if ok:
                tags.append(lst["id"])
                break
    return tags


ELEVATION_API = "https://api.open-meteo.com/v1/elevation"
ELE_CHUNK = 100


def fetch_elevations(coords, timeout=60):
    """Terrain-model elevations (m) for [(lat, lon), ...] from Open-Meteo (Copernicus 90 m DEM)."""
    q = urllib.parse.urlencode({"latitude": ",".join(f"{la:.5f}" for la, _ in coords), "longitude": ",".join(f"{lo:.5f}" for _, lo in coords)})
    req = urllib.request.Request(f"{ELEVATION_API}?{q}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            vals = json.loads(r.read().decode("utf-8")).get("elevation") or []
    except Exception as e:  # noqa: BLE001 - network, HTTP or JSON error
        raise FetchError(f"Open-Meteo elevation: {e}") from e
    if len(vals) != len(coords):
        raise FetchError(f"Open-Meteo elevation returned {len(vals)} values for {len(coords)} points")
    return vals


def fill_elevations(rows, log=None, fetch=None):
    """Peaks without an OSM 'ele' get an estimate from the terrain model (flag est=1); the API being down is not fatal."""
    todo = [i for i, r in enumerate(rows) if r[3] is None]
    done = 0
    for k in range(0, len(todo), ELE_CHUNK):
        part = todo[k:k + ELE_CHUNK]
        try:
            vals = (fetch or fetch_elevations)([(rows[i][1], rows[i][2]) for i in part])
        except FetchError as e:
            if log:
                log.warn(f"peaks: elevation estimate skipped ({len(todo) - done} peaks left without): {e}")
            break
        for i, v in zip(part, vals):
            if v is not None and -50 <= v <= 4000:
                rows[i][3] = int(round(v))
                rows[i][7] = 1
                done += 1
    if log and todo:
        log.info(f"peaks: {done} of {len(todo)} missing elevations estimated from the terrain model")
    return rows


def enrich(rows, locator, lists, log=None, fetch_ele=None, estimate=True):
    """[[n, lat, lon, ele, osm(, area, tags, est)], ...] -> rows with area ('新竹縣關西鎮', or two joined by ／ on a boundary), tags and est.

    The download box also covers the Fujian coast: a peak that lies in no Taiwan township (MOI boundaries,
    1 km tolerance for coastlines) is not Taiwan's and is dropped.
    """
    out, dropped = [], []
    for r in rows:
        n, lat, lon, ele, osm = r[:5]
        area = geo.area_names(locator.locate_all(lat, lon))
        if not area:
            dropped.append(f"{n} ({lat}, {lon}, {ele} m)")
            continue
        est = r[7] if len(r) > 7 else 0   # keep an earlier estimate
        out.append([n, lat, lon, ele, osm, area, [], est])
    if estimate:
        fill_elevations(out, log, fetch_ele)
    for r in out:                          # tags last: list entries may be told apart by (estimated) elevation
        r[6] = match_tags(r[0], r[1], r[2], r[3], lists)
    if dropped and log:
        log.warn(f"peaks: dropped {len(dropped)} peaks outside Taiwan's townships: " + "; ".join(dropped[:20]) + (" ..." if len(dropped) > 20 else ""))
    return out


def _write(dest, now, rows, lists, matches):
    obj = {"time": now.isoformat(), "source": "OpenStreetMap (natural=peak)", "license": "ODbL-1.0",
           "areaSource": "內政部行政區界（taiwan-atlas）", "fields": FIELDS, "listsVersion": lists_version(lists),
           "lists": [{"id": x["id"], "label": x.get("label", x["id"])} for x in lists], "cwaMatch": matches, "peaks": rows}
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(dest)


def build(out_dir, log, now, fetch=None, force=False, topo_path=TOPO, lists_dir=LISTS_DIR, fetch_ele=None):
    """Write peaks.json and annotate spots/index.json; returns (count, refreshed?)."""
    dest = out_dir / "peaks.json"
    lists = load_lists(lists_dir)
    locator = geo.TownLocator(geo.load_topo(topo_path), snap_km=1.0)
    prev = None
    if dest.exists():
        try:
            prev = json.loads(dest.read_text(encoding="utf-8"))
        except ValueError:
            prev = None
    idx = out_dir / "spots" / "index.json"
    spots = json.loads(idx.read_text(encoding="utf-8")).get("spots", []) if idx.exists() else []
    cwa = [(s["k"], s["n"], s["lat"], s["lon"]) for s in spots if s.get("c") == "mountain"]
    if prev and not force and "cwaMatch" in prev:
        try:
            age = now - datetime.fromisoformat(prev["time"])
        except (KeyError, ValueError):
            age = MAX_AGE
        if age < MAX_AGE:
            # Same OSM download, but older format or changed peak lists: add area / tags without refetching.
            if prev.get("fields") != FIELDS or prev.get("listsVersion") != lists_version(lists):
                rows = enrich(prev.get("peaks", []), locator, lists, log, fetch_ele)
                _write(dest, datetime.fromisoformat(prev["time"]), rows, lists, prev["cwaMatch"])
            annotate_spots(out_dir, prev["cwaMatch"], locator)
            return len(prev.get("peaks", [])), False
    try:
        data = (fetch or fetch_overpass)(log)
    except FetchError:
        if prev:
            log.warn("peaks: Overpass unavailable, keeping the previous list")
            annotate_spots(out_dir, prev.get("cwaMatch", {}), locator)
            return len(prev.get("peaks", [])), False
        annotate_spots(out_dir, {}, locator)  # townships for the spots even without OSM data
        raise
    peaks = parse(data, [(n, la, lo) for _, n, la, lo in cwa])
    if not peaks:
        raise FetchError("Overpass returned no named peaks")
    matches = match_cwa(data, cwa)
    rows = enrich(peaks, locator, lists, log, fetch_ele)
    _write(dest, now, rows, lists, matches)
    annotate_spots(out_dir, matches, locator)
    return len(rows), True
