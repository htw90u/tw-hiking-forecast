"""Wind forecast summary for the map: township and mountain-spot wind every 3 hours.

Reads the forecast files written by the spots and towns tasks (CWA F-D0047 township and
F-B0053 hiking forecasts: mean wind, direction, apparent temperature) and, when present,
gusts.json (Open-Meteo model gusts, since CWA forecasts carry no gusts), and writes one
compact wind.json for the wind layer and the point panel.
"""
import json
from pathlib import Path

from .gusts import window_max

# Compass names used by CWA, clockwise from north; the index is stored (direction the wind comes from).
DIRS = ["偏北風", "東北風", "偏東風", "東南風", "偏南風", "西南風", "偏西風", "西北風"]


def _series(doc, gust=None):
    """{time: (speed m/s, Beaufort, direction index, max gust m/s, apparent °C)} for each 3-hour step."""
    d3 = doc.get("d3") or {}
    ws, wd = d3.get("風速") or {}, d3.get("風向") or {}
    at = d3.get("體感溫度") or {}
    at_by_t = dict(zip(at.get("t") or [], (at.get("v") or {}).get("ApparentTemperature") or []))
    speeds = (ws.get("v") or {}).get("WindSpeed") or []
    scales = (ws.get("v") or {}).get("BeaufortScale") or []
    dir_by_t = dict(zip(wd.get("t") or [], (wd.get("v") or {}).get("WindDirection") or []))
    out = {}
    for i, t in enumerate(ws.get("t") or []):
        s = _num(speeds[i] if i < len(speeds) else None)
        b = _num(scales[i] if i < len(scales) else None)
        d = dir_by_t.get(t)
        g = window_max(gust, t) if gust else None
        out[t] = (s, b, DIRS.index(d) if d in DIRS else None, g, _num(at_by_t.get(t)))
    return out


def _num(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def build(out_dir: Path) -> dict:
    gfile = out_dir / "gusts.json"
    gusts = json.loads(gfile.read_text(encoding="utf-8")) if gfile.exists() else None
    gp = (gusts or {}).get("points", {})
    towns = {}
    for f in sorted((out_dir / "towns").glob("*.json")):
        doc = json.loads(f.read_text(encoding="utf-8"))
        if doc.get("g"):
            towns[doc["g"]] = (doc, _series(doc, gp.get(doc["g"])))
    mtns = []
    for f in sorted((out_dir / "spots" / "f").glob("mountain-*.json")):
        doc = json.loads(f.read_text(encoding="utf-8"))
        mtns.append((doc, _series(doc, gp.get(doc.get("k")))))
    times = sorted({t for _, s in list(towns.values()) + mtns for t in s})
    if not times:
        raise ValueError("no wind forecast in the township / spot files")

    def cols(series):
        rows = [series.get(t, (None,) * 5) for t in times]
        return [[r[k] for r in rows] for k in range(5)]

    issue = next((d.get("issue3d") for d, _ in towns.values() if d.get("issue3d")), None)
    obj = {
        "issue": issue, "times": times, "dirs": DIRS, "fields": ["ws", "bf", "wd", "gust", "at"],
        "gustSource": ({"name": "Open-Meteo", "license": gusts.get("license"), "time": gusts.get("time")} if gusts else None),
        "towns": {g: cols(s) for g, (_, s) in towns.items()},
        "mountains": [{"k": d["k"], "n": d["n"], "lat": d["lat"], "lon": d["lon"], "w": cols(s)} for d, s in mtns],
    }
    tmp = out_dir / "wind.json.tmp"
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(out_dir / "wind.json")
    return {"times": len(times), "towns": len(towns), "mountains": len(mtns), "issue": issue, "gusts": bool(gusts),
            "start": times[0], "end": times[-1]}
