"""Point forecasts: CWA recreation spots (F-B0053) and townships (F-D0047)."""
import json
from pathlib import Path

# F-B0053 is published as 14 categories x (1-week daily, 1-week 12h, 3-day 3h) x (zh, en).
# The value is (12h one-week dataset, 3-day dataset) for the Chinese edition.
SPOT_CATEGORIES = [
    ("beach", "海水浴場", "F-B0053-003", "F-B0053-005"),
    ("park", "自行車道", "F-B0053-009", "F-B0053-011"),   # CWA calls it 公園綠地; all 118 spots are cycling routes (English names "<place>_Biking_<route>")
    ("farm", "農場與森林", "F-B0053-015", "F-B0053-017"),
    ("fishing", "海釣點", "F-B0053-021", "F-B0053-023"),
    ("coast", "海岸遊憩", "F-B0053-027", "F-B0053-029"),
    ("mountain", "登山", "F-B0053-033", "F-B0053-035"),
    ("np", "國家公園", "F-B0053-039", "F-B0053-041"),
    ("nsa", "國家風景區", "F-B0053-045", "F-B0053-047"),
    ("port", "港口", "F-B0053-051", "F-B0053-053"),
    ("forest", "國家森林遊樂區", "F-B0053-057", "F-B0053-059"),
    ("reservoir", "水庫", "F-B0053-063", "F-B0053-065"),
    ("scenic", "山區景點", "F-B0053-069", "F-B0053-071"),
    ("water", "水域遊憩", "F-B0053-076", "F-B0053-078"),
    ("sea", "海域遊憩", "F-B0053-082", "F-B0053-084"),
]

# Township forecasts: one dataset per county for 3-day (3-hourly) and 1-week (12-hourly).
# 001, 005, ... are 3-day files and 003, 007, ... 1-week files (22 counties each).
TOWN_DATASETS = [f"F-D0047-{i:03d}" for i in range(1, 88, 2)]


def _as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def compact_elements(elements) -> dict:
    """WeatherElement list -> {name: {"t": [...], "e": [...], "v": {key: [...]}}}.

    ``t`` is the start/data time of each step, ``e`` the end time (if any) and
    ``v`` maps every ElementValue key to an aligned list of strings/numbers.
    """
    out = {}
    for el in _as_list(elements):
        times = _as_list(el.get("Time"))
        t, e, v = [], [], {}
        for i, tm in enumerate(times):
            t.append(tm.get("StartTime") or tm.get("DataTime"))
            e.append(tm.get("EndTime"))
            for k, val in (tm.get("ElementValue") or {}).items():
                v.setdefault(k, [None] * len(times))[i] = _num_or_str(val)
        rec = {"t": t, "v": v}
        if any(e):
            rec["e"] = e
        out[el.get("ElementName")] = rec
    return out


def _num_or_str(val):
    if val is None:
        return None
    s = str(val).strip()
    if s in ("", "-", "NA"):
        return None
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return s


def read_locations(doc):
    ds = doc["cwaopendata"]["Dataset"]
    info = ds.get("DatasetInfo", {})
    locs = ds["Locations"]
    blocks = _as_list(locs)
    items = []
    for b in blocks:
        for loc in _as_list(b.get("Location")):
            items.append(loc)
    return info, items


def _spot_id(loc):
    p = _as_list((loc.get("ParameterSet") or {}).get("Parameter"))
    for x in p:
        if x.get("ParameterName") == "id":
            return x.get("ParameterValue")
    return loc.get("LocationName")


def build_spots(fetch_json, out_dir: Path, log) -> dict:
    """Write spots/index.json and spots/f/<cat>-<id>.json; returns summary."""
    fdir = out_dir / "spots" / "f"
    fdir.mkdir(parents=True, exist_ok=True)
    index, issue = [], {}
    for cat, label, week_id, d3_id in SPOT_CATEGORIES:
        try:
            week_info, week_locs = read_locations(fetch_json(f"Forecast/{week_id}.json"))
            d3_info, d3_locs = read_locations(fetch_json(f"Forecast/{d3_id}.json"))
        except Exception as e:  # noqa: BLE001
            log.fail(f"spots {cat} ({week_id}/{d3_id}): {e}")
            continue
        d3_by_id = {_spot_id(l): l for l in d3_locs}
        for loc in week_locs:
            sid = _spot_id(loc)
            try:
                lat, lon = float(loc["Latitude"]), float(loc["Longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            key = f"{cat}-{sid}"
            index.append({"k": key, "n": loc.get("LocationName"), "c": cat, "lat": round(lat, 5), "lon": round(lon, 5),
                          "g": loc.get("Geocode")})
            doc = {"k": key, "n": loc.get("LocationName"), "c": cat, "lat": lat, "lon": lon,
                   "issue": week_info.get("IssueTime"), "week": compact_elements(loc.get("WeatherElement"))}
            d3 = d3_by_id.get(sid)
            if d3:
                doc["issue3d"] = d3_info.get("IssueTime")
                doc["d3"] = compact_elements(d3.get("WeatherElement"))
            (fdir / f"{key}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        issue[cat] = week_info.get("IssueTime")
        log.ok(f"spots {label}: {sum(1 for i in index if i['c'] == cat)} locations")
    cats = [{"id": c, "label": l} for c, l, _, _ in SPOT_CATEGORIES]
    (out_dir / "spots" / "index.json").write_text(
        json.dumps({"categories": cats, "issue": issue, "spots": index}, ensure_ascii=False, separators=(",", ":")))
    return {"count": len(index), "issue": issue}


def build_towns(fetch_json, out_dir: Path, log) -> dict:
    """Write towns/<geocode>.json combining 3-day and 1-week township forecasts."""
    tdir = out_dir / "towns"
    tdir.mkdir(parents=True, exist_ok=True)
    towns = {}
    issue = None
    for ds_id in TOWN_DATASETS:
        try:
            info, locs = read_locations(fetch_json(f"Forecast/{ds_id}.json"))
        except Exception as e:  # noqa: BLE001
            log.warn(f"towns {ds_id}: {e}")
            continue
        desc = info.get("DatasetDescription", "")
        part = "week" if "1週" in desc or "一週" in desc else "d3"
        for loc in locs:
            g = loc.get("Geocode")
            if not g:
                continue
            rec = towns.setdefault(g, {"g": g, "n": loc.get("LocationName"),
                                       "lat": _num_or_str(loc.get("Latitude")), "lon": _num_or_str(loc.get("Longitude"))})
            rec[part] = compact_elements(loc.get("WeatherElement"))
            rec["issue" if part == "week" else "issue3d"] = info.get("IssueTime")
            issue = issue or info.get("IssueTime")
    for g, rec in towns.items():
        (tdir / f"{g}.json").write_text(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
    log.ok(f"township forecasts: {len(towns)} townships")
    return {"count": len(towns), "issue": issue}
