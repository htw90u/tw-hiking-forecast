"""Winds aloft, visibility, UV index and freezing level for the mountain forecast points (Open-Meteo).

CWA's forecasts only cover the 10 m wind. Open-Meteo's numerical models give the wind on pressure levels
(925 / 850 / 700 / 500 hPa, roughly 800 / 1,500 / 3,000 / 5,500 m), plus visibility, UV index and the freezing
level. Values are kept for every 3rd hour (the same steps as the CWA forecasts). The file is refreshed hourly;
when the API is unreachable the previous file is kept for up to 12 hours.
"""
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .fetch import SSL_CTX, USER_AGENT, FetchError

API = "https://api.open-meteo.com/v1/forecast"
TZ = ZoneInfo("Asia/Taipei")
LEVELS = [925, 850, 700, 500]
REFRESH = timedelta(minutes=55)
KEEP = timedelta(hours=12)
CHUNK = 20  # locations per request (every location asks for 15 hourly variables)
TRIES = 4   # attempts per request: the API sometimes answers with a TLS handshake timeout
HOURLY = ["visibility", "uv_index", "freezing_level_height"] + [
    f"{v}_{lv}hPa" for lv in LEVELS for v in ("wind_speed", "wind_direction", "geopotential_height")]


def points(out_dir: Path) -> list:
    """[(key, lat, lon)] of the mountain forecast spots."""
    idx = out_dir / "spots" / "index.json"
    if not idx.exists():
        return []
    return [(s["k"], s["lat"], s["lon"]) for s in json.loads(idx.read_text(encoding="utf-8")).get("spots", [])
            if s.get("c") == "mountain"]


def fetch_open_meteo(pts, timeout=40):
    """One Open-Meteo response object per point (hourly values, local time)."""
    out = []
    for i in range(0, len(pts), CHUNK):
        part = pts[i:i + CHUNK]
        q = urllib.parse.urlencode({
            "latitude": ",".join(str(p[1]) for p in part), "longitude": ",".join(str(p[2]) for p in part),
            "hourly": ",".join(HOURLY), "wind_speed_unit": "ms", "timezone": "Asia/Taipei", "forecast_days": 4,
        })
        req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": USER_AGENT})
        for attempt in range(TRIES):
            try:
                with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                    data = json.loads(r.read().decode("utf-8"))
                break
            except Exception as e:  # noqa: BLE001 - network, HTTP or JSON error
                if attempt == TRIES - 1:
                    raise FetchError(f"Open-Meteo: {e}") from e
                time.sleep(3 * 3 ** attempt)
        out.extend(data if isinstance(data, list) else [data])
        time.sleep(0.5)
    if len(out) != len(pts):
        raise FetchError(f"Open-Meteo returned {len(out)} locations for {len(pts)}")
    return out


def _r(v, nd=0):
    return None if v is None else (round(float(v), nd) if nd else int(round(float(v))))


def parse(pts, responses) -> dict:
    """-> {'times': [iso], 'points': {key: {...}}}; every 3rd hour, columns follow `times`.

    Per point: vis (km), uv, fz (freezing level, m), ws / wd / z (one list per level: speed m/s, direction the wind
    comes from in degrees, geopotential height m).
    """
    times = None
    res = {}
    for (key, _, _), r in zip(pts, responses):
        h = r.get("hourly") or {}
        hours = h.get("time") or []
        keep = [i for i, t in enumerate(hours) if datetime.fromisoformat(t).hour % 3 == 0]
        if times is None:
            times = [datetime.fromisoformat(hours[i]).replace(tzinfo=TZ).isoformat() for i in keep]

        def col(name, nd=0, scale=1.0):
            vals = h.get(name) or [None] * len(hours)
            return [_r(None if vals[i] is None else vals[i] * scale, nd) for i in keep]
        res[key] = {
            "vis": col("visibility", 1, 0.001), "uv": col("uv_index", 1), "fz": col("freezing_level_height"),
            "ws": [col(f"wind_speed_{lv}hPa", 1) for lv in LEVELS],
            "wd": [col(f"wind_direction_{lv}hPa") for lv in LEVELS],
            "z": [col(f"geopotential_height_{lv}hPa") for lv in LEVELS],
        }
    return {"times": times or [], "points": res}


def build(out_dir: Path, log, now: datetime, fetch=None) -> dict:
    dest = out_dir / "aloft.json"
    prev = json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    age = now - datetime.fromisoformat(prev["time"]) if prev else None
    if prev and age < REFRESH:
        return {"points": len(prev["points"]), "fresh": False, "time": prev["time"]}
    pts = points(out_dir)
    if not pts:
        raise FetchError("no mountain spots to look up (run the spots task first)")
    try:
        data = parse(pts, (fetch or fetch_open_meteo)(pts))
    except FetchError as e:
        if prev and age < KEEP:
            log.warn(f"aloft: {e}; keeping the copy from {prev['time']}")
            return {"points": len(prev["points"]), "fresh": False, "time": prev["time"]}
        dest.unlink(missing_ok=True)
        raise
    obj = {"time": now.isoformat(), "source": "Open-Meteo forecast API", "license": "CC BY 4.0", "levels": LEVELS, **data}
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(dest)
    return {"points": len(data["points"]), "fresh": True, "time": obj["time"]}
