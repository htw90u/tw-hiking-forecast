"""Debris-flow alerts (ARDSWC) and river water level / reservoir data (WRA open data) for the map.

Sources (all JSON, no key):
  * debris-flow alerts: https://246.ardswc.gov.tw/webService/GetAlertData.ashx (an empty list when no alert is in force)
  * real-time river water level (73c4c3de…) joined with the river station list (c4acc691…: name, TWD97 position, alert levels)
  * reservoir real-time conditions (2be9044c…: level, storage, inflow, outflow, planned flood release) joined with the daily
    operation table (51023e88…: name, capacity) and placed with the CWA reservoir spots (names match)
Field names are matched case-insensitively and a record that cannot be read is skipped, so a changed field never breaks the build.
"""
import json
import math
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .fetch import SSL_CTX, USER_AGENT, FetchError

TZ = ZoneInfo("Asia/Taipei")
WRA = "https://opendata.wra.gov.tw/api/v2"
URLS = {
    "debris": "https://246.ardswc.gov.tw/webService/GetAlertData.ashx",
    "river_level": f"{WRA}/73c4c3de-4045-4765-abeb-89f9f9cd5ff0?format=JSON",
    "river_station": f"{WRA}/c4acc691-7416-40ca-9464-292c0c00da92?format=JSON",
    "reservoir": f"{WRA}/2be9044c-6e44-4856-aad5-dd108c2e6679?format=JSON",
    "reservoir_daily": f"{WRA}/51023e88-4c76-4dbc-bbb9-470da690d539?format=JSON",
}


def get_json(url, timeout=60, tries=3):
    """JSON from a WRA / ARDSWC endpoint; these answer with an empty or truncated body now and then, so try a few times."""
    err = None
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except Exception as e:  # noqa: BLE001 - network, HTTP or JSON error
            err = e
            if attempt < tries - 1:
                time.sleep(3 * 3 ** attempt)
    raise FetchError(f"{url.split('?')[0]}: {err}") from err


# ------------------------------------------------------------------ helpers
def lower(rec):
    return {str(k).lower(): v for k, v in rec.items()}


def num(v):
    try:
        f = float(str(v).strip())
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def pick(rec, *names):
    """First non-empty value among the (lower-case) field names."""
    for n in names:
        v = rec.get(n)
        if v not in (None, "", "-"):
            return v
    return None


def tm2_to_lonlat(x, y):
    """TWD97 TM2 zone 121 (EPSG:3826: central meridian 121 E, scale 0.9999, false easting 250 km) -> (lon, lat) in degrees."""
    a, f = 6378137.0, 1 / 298.257222101
    k0, lon0, fe = 0.9999, math.radians(121.0), 250000.0
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    n1 = a / math.sqrt(1 - e2 * s * s)
    t1 = t * t
    c1 = ep2 * c * c
    r1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5
    d = (x - fe) / (n1 * k0)
    lat = phi1 - (n1 * t / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                  + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    return math.degrees(lon), math.degrees(lat)


def _iso(t):
    """'2026-10-27T18:00:00' (Taiwan time, no zone) -> ISO with +08:00."""
    try:
        return datetime.fromisoformat(str(t)).replace(tzinfo=TZ).isoformat()
    except ValueError:
        return None


# ------------------------------------------------------------------ debris-flow alerts
LEVELS = {"y": "yellow", "r": "red", "yellow": "yellow", "red": "red", "黃": "yellow", "紅": "red", "黃色": "yellow", "紅色": "red"}


def parse_debris(data) -> list:
    """[{no, level ('yellow'|'red'), type ('D' debris flow | 'L' landslide), county, town, village}] from the alert answer.

    An empty list (or an {errorMessage} object) means no alert is in force.
    """
    if isinstance(data, dict):
        data = data.get("data") or data.get("Data") or []
    rows = data if isinstance(data, list) else []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        r = lower(r)
        level = LEVELS.get(str(pick(r, "alertlevel", "alertvalue", "level", "alert") or "").strip().lower())
        out.append({"no": pick(r, "debrisno", "debrisnumber", "no"), "level": level, "type": pick(r, "alerttype", "type") or "D",
                    "county": pick(r, "county", "countyname", "cityname"), "town": pick(r, "town", "townname", "townshipname"),
                    "village": pick(r, "vill", "village", "villagename")})
    return out


# ------------------------------------------------------------------ river water level
def parse_rivers(levels, stations) -> list:
    """[{id, n, river, lat, lon, t, wl, a1, a2, a3}]; wl in metres, a1..a3 = first (highest) to third alert level when published."""
    by_id = {}
    for s in stations:
        s = lower(s)
        xy = str(pick(s, "locationbytwd97_xy") or "").split()
        lat, lon = num(pick(s, "latitude", "lat")), num(pick(s, "longitude", "lon", "lng"))
        if (lat is None or lon is None) and len(xy) == 2 and num(xy[0]) and num(xy[1]):
            lon, lat = tm2_to_lonlat(float(xy[0]), float(xy[1]))
        if lat is None or lon is None:
            continue
        name = pick(s, "observatoryname", "stationname", "name") or next((v for k, v in s.items() if k.endswith("name") and "english" not in k and v), None)
        rec = {"n": name, "river": pick(s, "rivername", "affiliatedriver"), "lat": round(lat, 5), "lon": round(lon, 5),
               "a1": num(s.get("alertlevel1")), "a2": num(s.get("alertlevel2")), "a3": num(s.get("alertlevel3"))}
        for key in (pick(s, "observatoryidentifier"), pick(s, "basinidentifier")):
            if key:
                by_id[str(key)] = rec
                by_id[str(key).split("_")[0]] = rec
    out = {}
    for r in levels:
        r = lower(r)
        if str(r.get("checkresult", "true")).lower() == "false":
            continue
        wl = num(r.get("waterlevel"))
        sid = str(pick(r, "stationid", "observatoryidentifier") or "")
        st = by_id.get(str(pick(r, "observatoryidentifier") or "")) or by_id.get(sid) or by_id.get(sid.split("_")[0])
        if wl is None or not st or not st["n"]:
            continue
        out[sid] = {"id": sid, **st, "t": _iso(r.get("datetime")), "wl": wl}
    return sorted(out.values(), key=lambda x: x["id"])


# ------------------------------------------------------------------ reservoirs
def parse_reservoirs(realtime, daily, spots) -> list:
    """Latest reading per reservoir with its name, capacity and position (from the CWA reservoir spots with the same name).

    [{id, n, lat, lon, t, wl (m), vol, cap, inflow, outflow, spill, plan, planT}]; flows in m3/s, vol / cap in the dataset's unit.
    """
    names = {}
    for d in daily:
        d = lower(d)
        rid = str(pick(d, "reservoiridentifier") or "")
        if rid:
            names[rid] = {"n": pick(d, "reservoirname"), "cap": num(d.get("capacity"))}
    where = {s["n"]: s for s in spots if s.get("c") == "reservoir"}
    latest = {}
    for r in realtime:
        r = lower(r)
        rid = str(pick(r, "reservoiridentifier") or "")
        t = str(pick(r, "observationtime") or "")
        if rid and (rid not in latest or t > latest[rid][0]):
            latest[rid] = (t, r)
    out = []
    for rid, (t, r) in latest.items():
        meta = names.get(rid)
        if not meta or not meta["n"]:
            continue
        sp = where.get(meta["n"]) or next((s for n, s in where.items() if n in meta["n"] or meta["n"] in n), None)
        if not sp:
            continue
        out.append({"id": rid, "n": meta["n"], "lat": sp["lat"], "lon": sp["lon"], "t": _iso(t), "wl": num(r.get("waterlevel")),
                    "vol": num(r.get("effectivewaterstoragecapacity")), "cap": meta["cap"], "inflow": num(r.get("inflowdischarge")),
                    "outflow": num(r.get("totaloutflow")), "spill": num(r.get("spillwayoutflow")),
                    "plan": num(r.get("predeterminedcrossflow")), "planT": _iso(r.get("predeterminedoutflowtime"))})
    return sorted(out, key=lambda x: x["id"])


# ------------------------------------------------------------------ build
def _rivers(fetch, log):
    levels, stations = fetch(URLS["river_level"]), fetch(URLS["river_station"])
    out = parse_rivers(levels, stations)
    if levels and not out:   # a changed field name: show what the station records look like
        log.warn(f"hydro rivers: no station could be matched; station keys {sorted(lower(stations[0]))[:60] if stations else None}")
    return out


def build(out_dir: Path, log, now: datetime, fetch=get_json) -> dict:
    spots = []
    idx = out_dir / "spots" / "index.json"
    if idx.exists():
        spots = json.loads(idx.read_text(encoding="utf-8")).get("spots", [])
    obj = {"time": now.isoformat(), "debris": None, "rivers": None, "reservoirs": None}
    errors = []
    for key, fn in (
        ("debris", lambda: parse_debris(fetch(URLS["debris"]))),
        ("rivers", lambda: _rivers(fetch, log)),
        ("reservoirs", lambda: parse_reservoirs(fetch(URLS["reservoir"]), fetch(URLS["reservoir_daily"]), spots)),
    ):
        try:
            obj[key] = fn()
        except Exception as e:  # noqa: BLE001 - one source down must not drop the others
            errors.append(f"{key}: {e}")
            log.warn(f"hydro {key}: {e}")
    if all(obj[k] is None for k in ("debris", "rivers", "reservoirs")):
        raise FetchError("; ".join(errors))
    dest = out_dir / "hydro.json"
    if dest.exists():   # keep the last good copy of a source that failed this time
        prev = json.loads(dest.read_text(encoding="utf-8"))
        for k in ("debris", "rivers", "reservoirs"):
            if obj[k] is None and prev.get(k) is not None:
                obj[k] = prev[k]
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(dest)
    return {"debris": len(obj["debris"] or []), "rivers": len(obj["rivers"] or []), "reservoirs": len(obj["reservoirs"] or []), "errors": errors}
