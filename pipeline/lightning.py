"""CWA lightning observations (O-A0039-001, KMZ with the last hour of strikes).

The KML lists one Placemark per strike; the style tells cloud-to-ground from in-cloud
strikes. Time and peak current are read from the placemark text when present, so the
parser keeps working if CWA rearranges the description.
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Taipei")  # CWA times are local

KML = "{http://www.opengis.net/kml/2.2}"
TIME_RE = re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?")
KA_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*kA", re.I)


def _time(text):
    m = TIME_RE.search(text or "")
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x or 0) for x in m.groups())
    return datetime(y, mo, d, h, mi, s, tzinfo=TZ)


def parse_kmz(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".kml"))
        root = ET.fromstring(z.read(name))
    doc = root.find(f"{KML}Document")
    title = (doc.findtext(f"{KML}name") if doc is not None else "") or ""
    start = _time(title.split("~")[0])
    end = _time(title.split("~")[1]) if "~" in title else None
    strikes = []
    for pm in root.iter(f"{KML}Placemark"):
        coords = (pm.findtext(f".//{KML}coordinates") or "").strip().split(",")
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (IndexError, ValueError):
            continue
        style = (pm.findtext(f"{KML}styleUrl") or "").lower()
        text = " ".join(t for t in pm.itertext() if t)
        t = _time(pm.findtext(f".//{KML}when") or "") or _time(text)
        ka = KA_RE.search(text)
        strikes.append({"lat": round(lat, 4), "lon": round(lon, 4), "t": t.isoformat() if t else None,
                        "cloud": "cloud" in style, "ka": float(ka.group(1)) if ka else None})
    strikes.sort(key=lambda s: s["t"] or "", reverse=True)
    return {"start": start.isoformat() if start else None, "end": end.isoformat() if end else None,
            "count": len(strikes), "strikes": strikes}
