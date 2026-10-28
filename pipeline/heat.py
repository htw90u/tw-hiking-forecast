"""Heat-injury index forecast per township (CWA M-A0085: five days, every 3 hours) -> a compact heat.json.

Per township (Geocode = the TOWNCODE of the township polygons): the index and the CWA warning level for each step.
Warning levels as published: 注意 / 警戒 / 危險 / 極度危險 -> 1 / 2 / 3 / 4, no warning -> 0.
"""
import json
import re
from datetime import datetime
from pathlib import Path

META_KEY = "Model/M-A0085-001.json"
WARNINGS = ["注意", "警戒", "危險", "極度危險"]


def _iso(s: str) -> str:
    """CWA writes '+8:00'; normalise to '+08:00'."""
    return datetime.fromisoformat(re.sub(r"([+-])(\d):(\d\d)$", r"\g<1>0\2:\3", s)).isoformat()


def _num(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def parse(doc: dict) -> dict:
    """-> {'issue', 'times': [iso], 'towns': {geocode: [[index...], [warning level...]]}}"""
    res = doc["cwaopendata"]["Resources"]["Resource"]
    meta = res["Metadata"]
    locations = res["Data"]["Locations"]
    if isinstance(locations, dict):
        locations = [locations]
    times = []
    index = {}
    towns = {}
    for county in locations:
        locs = county.get("Location") or []
        if isinstance(locs, dict):
            locs = [locs]
        for loc in locs:
            for step in loc.get("Time") or []:
                t = _iso(step["IssueTime"])
                if t not in index:
                    index[t] = None
                    times.append(t)
    times.sort()
    index = {t: i for i, t in enumerate(times)}
    for county in locations:
        locs = county.get("Location") or []
        if isinstance(locs, dict):
            locs = [locs]
        for loc in locs:
            idx = [None] * len(times)
            warn = [0] * len(times)
            for step in loc.get("Time") or []:
                i = index[_iso(step["IssueTime"])]
                el = step.get("WeatherElements") or {}
                idx[i] = _num(el.get("HeatInjuryIndex"))
                w = el.get("HeatInjuryWarning")
                warn[i] = WARNINGS.index(w) + 1 if w in WARNINGS else 0
            if any(v is not None for v in idx):
                towns[str(loc["Geocode"])] = [idx, warn]
    if not towns:
        raise ValueError("no heat-injury forecast in M-A0085")
    return {"issue": _iso(meta["IssueTime"]), "times": times, "towns": towns}


def build(out_dir: Path, get_json) -> dict:
    data = parse(get_json(META_KEY))
    obj = {"source": "中央氣象署 健康氣象熱傷害指數及警示 (M-A0085)", **data}
    tmp = out_dir / "heat.json.tmp"
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(out_dir / "heat.json")
    warned = sum(1 for _, (_, w) in data["towns"].items() if any(w))
    return {"issue": data["issue"], "towns": len(data["towns"]), "steps": len(data["times"]), "warned": warned}
