"""Wind-gust forecasts for the townships from Open-Meteo.

CWA's township and hiking forecasts give mean wind only, so gusts come from the
Open-Meteo forecast API (numerical weather models, CC BY 4.0, free for non-commercial
use). The file is refreshed hourly; when the API is unreachable the previous file is
kept for up to 12 hours so the map is never filled with stale gusts.
"""
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .fetch import SSL_CTX, USER_AGENT, FetchError

API = "https://api.open-meteo.com/v1/forecast"
TZ = ZoneInfo("Asia/Taipei")
REFRESH = timedelta(minutes=55)
KEEP = timedelta(hours=12)
CHUNK = 100  # locations per request


def points(out_dir: Path) -> list:
    """[(geocode, lat, lon)] of the townships. Mountain forecast points are left out on purpose: the model's grid cell (about 10 km, its
    own terrain height) is far lower and smoother than a summit, so its gusts come out below the CWA mean wind there."""
    pts = []
    for f in sorted((out_dir / "towns").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        try:
            pts.append((d["g"], round(float(d["lat"]), 4), round(float(d["lon"]), 4)))
        except (KeyError, TypeError, ValueError):
            continue
    return pts


def fetch_open_meteo(pts, timeout=60):
    """Return one Open-Meteo response object per point (hourly gusts, m/s, local time)."""
    out = []
    for i in range(0, len(pts), CHUNK):
        part = pts[i:i + CHUNK]
        q = urllib.parse.urlencode({
            "latitude": ",".join(str(p[1]) for p in part), "longitude": ",".join(str(p[2]) for p in part),
            "hourly": "wind_gusts_10m", "wind_speed_unit": "ms", "timezone": "Asia/Taipei", "forecast_days": 4,
        })
        req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - network, HTTP or JSON error
            raise FetchError(f"Open-Meteo: {e}") from e
        out.extend(data if isinstance(data, list) else [data])
    if len(out) != len(pts):
        raise FetchError(f"Open-Meteo returned {len(out)} locations for {len(pts)}")
    return out


def parse(pts, responses) -> dict:
    """{key: {iso local hour: gust m/s}}."""
    res = {}
    for (key, _, _), r in zip(pts, responses):
        h = r.get("hourly") or {}
        series = {}
        for t, g in zip(h.get("time") or [], h.get("wind_gusts_10m") or []):
            if g is None:
                continue
            series[datetime.fromisoformat(t).replace(tzinfo=TZ).isoformat()] = round(float(g), 1)
        res[key] = series
    return res


def build(out_dir: Path, log, now: datetime, fetch=None) -> dict:
    dest = out_dir / "gusts.json"
    prev = json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    age = now - datetime.fromisoformat(prev["time"]) if prev else None
    if prev and age < REFRESH:
        return {"points": len(prev["points"]), "fresh": False, "time": prev["time"]}
    pts = points(out_dir)
    if not pts:
        raise FetchError("no mountain spots or townships to look up (run the spots and towns tasks first)")
    try:
        series = parse(pts, (fetch or fetch_open_meteo)(pts))
    except FetchError as e:
        if prev and age < KEEP:
            log.warn(f"gusts: {e}; keeping the copy from {prev['time']}")
            return {"points": len(prev["points"]), "fresh": False, "time": prev["time"]}
        dest.unlink(missing_ok=True)
        raise
    obj = {"time": now.isoformat(), "source": "Open-Meteo forecast API (wind_gusts_10m)", "license": "CC BY 4.0",
           "points": series}
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(dest)
    return {"points": len(series), "fresh": True, "time": obj["time"]}


def window_max(series: dict, start_iso: str, hours: int = 3):
    """Highest gust in [start, start + hours) from an hourly {iso: gust} series, or None."""
    t0 = datetime.fromisoformat(start_iso)
    vals = [series.get((t0 + timedelta(hours=h)).isoformat()) for h in range(hours)]
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None
