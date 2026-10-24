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
FIELDS = ["n", "lat", "lon", "ele", "osm", "area", "tags"]
ROOT = Path(__file__).resolve().parent.parent
TOPO = ROOT / "site" / "geo" / "towns-10t.json"
LISTS_DIR = Path(__file__).resolve().parent / "data" / "peak_lists"


def _km(lat1, lon1, lat2, lon2):
    dy = (lat2 - lat1) * 111.2
    dx = (lon2 - lon1) * 111.2 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


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
    same name within 2 km is dropped. Same-name peaks closer than 200 m are merged.
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
        if any(n == name and _km(lat, lon, la, lo) <= 2 for n, la, lo in cwa):
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
    return hashlib.sha1(json.dumps(lists, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


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


def enrich(rows, locator, lists):
    """[[n, lat, lon, ele, osm], ...] -> rows with area ('新竹縣關西鎮', or two joined by ／ on a boundary) and tags appended."""
    out = []
    for r in rows:
        n, lat, lon, ele, osm = r[:5]
        out.append([n, lat, lon, ele, osm, geo.area_names(locator.locate_all(lat, lon)), match_tags(n, lat, lon, ele, lists)])
    return out


def _write(dest, now, rows, lists):
    obj = {"time": now.isoformat(), "source": "OpenStreetMap (natural=peak)", "license": "ODbL-1.0",
           "areaSource": "內政部行政區界（taiwan-atlas）", "fields": FIELDS, "listsVersion": lists_version(lists),
           "lists": [{"id": x["id"], "label": x.get("label", x["id"])} for x in lists], "peaks": rows}
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(dest)


def build(out_dir, log, now, fetch=None, force=False, topo_path=TOPO, lists_dir=LISTS_DIR):
    """Write peaks.json; returns (count, refreshed?)."""
    dest = out_dir / "peaks.json"
    lists = load_lists(lists_dir)
    locator = None
    prev = None
    if dest.exists():
        try:
            prev = json.loads(dest.read_text(encoding="utf-8"))
        except ValueError:
            prev = None
    if prev and not force:
        try:
            age = now - datetime.fromisoformat(prev["time"])
        except (KeyError, ValueError):
            age = MAX_AGE
        if age < MAX_AGE:
            # Same OSM download, but older format or changed peak lists: add area / tags without refetching.
            if prev.get("fields") != FIELDS or prev.get("listsVersion") != lists_version(lists):
                locator = geo.TownLocator(geo.load_topo(topo_path))
                rows = enrich(prev.get("peaks", []), locator, lists)
                _write(dest, datetime.fromisoformat(prev["time"]), rows, lists)
            return len(prev.get("peaks", [])), False
    cwa = []
    idx = out_dir / "spots" / "index.json"
    if idx.exists():
        spots = json.loads(idx.read_text(encoding="utf-8")).get("spots", [])
        cwa = [(s["n"], s["lat"], s["lon"]) for s in spots if s.get("c") == "mountain"]
    try:
        data = (fetch or fetch_overpass)(log)
    except FetchError:
        if prev:
            log.warn("peaks: Overpass unavailable, keeping the previous list")
            return len(prev.get("peaks", [])), False
        raise
    peaks = parse(data, cwa)
    if not peaks:
        raise FetchError("Overpass returned no named peaks")
    locator = locator or geo.TownLocator(geo.load_topo(topo_path))
    _write(dest, now, enrich(peaks, locator, lists), lists)
    return len(peaks), True
