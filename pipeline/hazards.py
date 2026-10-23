"""Earthquake reports, typhoon products and weather warnings."""
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from .stations import xml_to_obj, _as_list, num


# ------------------------------------------------------------------ earthquakes

def _intensity_value(s):
    """'5弱' -> 5.0, '5強' -> 5.5, '3級' -> 3.0."""
    if not s:
        return None
    m = re.match(r"(\d)", str(s))
    if not m:
        return None
    v = float(m.group(1))
    if "強" in str(s):
        v += 0.5
    return v


def parse_quake_xml(data: bytes) -> dict:
    root = ET.fromstring(data)
    doc = xml_to_obj(root)
    eq = doc["dataset"]["Earthquake"]
    info = eq["EarthquakeInfo"]
    epi = info["Epicenter"]
    areas, stations = [], []
    for a in _as_list(eq.get("Intensity", {}).get("ShakingArea")):
        areas.append({"area": a.get("AreaDesc"), "county": a.get("CountyName"), "int": a.get("AreaIntensity"),
                      "iv": _intensity_value(a.get("AreaIntensity"))})
        for st in _as_list(a.get("EqStation")):
            lat, lon = num(st.get("StationLatitude")), num(st.get("StationLongitude"))
            if lat is None or lon is None:
                continue
            stations.append({"n": st.get("StationName"), "lat": lat, "lon": lon, "int": st.get("SeismicIntensity"),
                             "iv": _intensity_value(st.get("SeismicIntensity")),
                             "d": num(st.get("EpicenterDistance"))})
    uniq = {}
    for s in stations:
        k = (s["n"], s["lat"], s["lon"])
        if k not in uniq or (s["iv"] or 0) > (uniq[k]["iv"] or 0):
            uniq[k] = s
    stations = sorted(uniq.values(), key=lambda s: -(s["iv"] or 0))
    max_iv = max([a["iv"] or 0 for a in areas] or [0])
    return {
        "no": eq.get("EarthquakeNo"), "time": info.get("OriginTime"), "lat": num(epi.get("EpicenterLatitude")),
        "lon": num(epi.get("EpicenterLongitude")), "loc": epi.get("Location"), "depth": num(info.get("FocalDepth")),
        "mag": num(_as_list(info.get("EarthquakeMagnitude"))[0].get("MagnitudeValue")) if info.get("EarthquakeMagnitude") else None,
        "text": eq.get("ReportContent"), "color": eq.get("ReportColor"), "web": eq.get("Web"),
        "img": eq.get("ReportImageURI"), "shakemap": eq.get("ShakemapImageURI"),
        "maxInt": max_iv, "areas": areas, "stations": stations[:60],
    }


def read_quake_zip(path: Path, kind: str) -> list:
    out = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.lower().endswith(".xml"):
                continue
            try:
                q = parse_quake_xml(z.read(name))
            except Exception:  # noqa: BLE001 - skip malformed report
                continue
            if q["lat"] is None or q["lon"] is None:
                continue
            q["kind"] = kind
            out.append(q)
    return out


def merge_quakes(*lists, limit: int = 60) -> list:
    by_key = {}
    for lst in lists:
        for q in lst:
            by_key[(q["time"], q["lat"], q["lon"])] = q
    return sorted(by_key.values(), key=lambda q: q["time"] or "", reverse=True)[:limit]


# --------------------------------------------------------------------- typhoon

def parse_cyclones(doc) -> list:
    tcs = []
    root = doc["cwaopendata"]["Dataset"]["TropicalCyclones"]
    for tc in _as_list(root.get("TropicalCyclone")):
        def fixes(block):
            res = []
            for f in _as_list((block or {}).get("Fix")):
                c15 = f.get("Circle15ms")
                c25 = f.get("Circle25ms")
                res.append({
                    "t": f.get("DateTime") or f.get("InitialTime"), "h": num(f.get("ForecastHour")),
                    "lat": num(f.get("CoordinateLatitude")), "lon": num(f.get("CoordinateLongitude")),
                    "ws": num(f.get("MaxWindSpeed")), "gs": num(f.get("MaxGustSpeed")), "p": num(f.get("Pressure")),
                    "mv": f.get("MovingDirection"), "ms": num(f.get("MovingSpeed")),
                    "r15": num(c15.get("Radius")) if isinstance(c15, dict) else None,
                    "r25": num(c25.get("Radius")) if isinstance(c25, dict) else None,
                    "r70": num(f.get("Radius70PercentProbability")),
                })
            return [x for x in res if x["lat"] is not None and x["lon"] is not None]

        tcs.append({
            "name": tc.get("TyphoonName"), "cname": tc.get("CwaTyphoonName"), "no": tc.get("CwaTyNo"),
            "td": tc.get("CwaTdNo"), "year": tc.get("Year"),
            "past": fixes(tc.get("AnalysisData")), "fcst": fixes(tc.get("ForecastData")),
        })
    return tcs


def _text(e, path):
    x = e.find(path)
    return x.text.strip() if x is not None and x.text else None


def parse_precip_table(data: bytes) -> dict:
    """24hPrecipTable.xml / AllPrecipTable.xml -> {name, issue, start, end, note, areas[]}."""
    root = ET.fromstring(data)
    areas = []
    for a in root.iter("AreaForecastData"):
        p = a.find("Precipitation")
        if p is None:
            continue
        areas.append({"area": a.get("area"), "region": p.get("region"), "value": _text(p, "Value"),
                      "lo": num(_text(p, "LowerBound")), "hi": num(_text(p, "UpperBound")),
                      "hl": _text(p, "IsHighlight") == "True"})
    return {
        "name": _text(root, "BulletinInformation/BulletinName"),
        "issue": _text(root, "BulletinInformation/IssueTime/Time"),
        "start": _text(root, "BulletinInformation/StartValidTime/Time"),
        "end": _text(root, "BulletinInformation/EndValidTime/Time"),
        "period": _text(root, "TextInformation/TitleEdit"),
        "note": _text(root, "TextInformation/Annotate"),
        "areas": areas,
    }


def parse_wind_table(data: bytes) -> dict:
    """WindTable.xml -> areas[] each with periods[{start, end, average, gust}] (Beaufort levels)."""
    root = ET.fromstring(data)
    by_area = {}
    for a in root.iter("AreaForecastData"):
        start, end = _text(a, "StartValidTime/Time"), _text(a, "EndValidTime/Time")
        area = by_area.setdefault(a.get("area"), {"area": a.get("area"), "periods": {}})
        per = area["periods"].setdefault((start, end), {"start": start, "end": end})
        for w in a.iter("WindData"):
            levels = [num(_text(w, t)) for t in ("StartLowerBound", "StartUpperBound", "EndLowerBound", "EndUpperBound")]
            levels = [x for x in levels if x is not None]
            per[w.get("type") or "average"] = {"level": _text(w, "Level"), "max": max(levels) if levels else None}
    areas = [{"area": a["area"], "periods": sorted(a["periods"].values(), key=lambda p: p["start"] or "")}
             for a in by_area.values()]
    return {
        "name": _text(root, "BulletinInformation/BulletinName"),
        "issue": _text(root, "BulletinInformation/IssueTime/Time"),
        "start": _text(root, "BulletinInformation/StartValidTime/Time"),
        "end": _text(root, "BulletinInformation/EndValidTime/Time"),
        "note": _text(root, "TextInformation/Annotate"),
        "areas": areas,
    }


# --------------------------------------------------------------------- warnings

def parse_county_warnings(doc) -> list:
    out = []
    for loc in _as_list(doc["cwaopendata"]["dataset"].get("location")):
        hz = []
        for h in _as_list((loc.get("hazardConditions") or {}).get("hazards")):
            info = h.get("info", {})
            vt = h.get("validTime", {})
            hz.append({"ph": info.get("phenomena"), "sig": info.get("significance"),
                       "start": vt.get("startTime"), "end": vt.get("endTime")})
        out.append({"county": loc.get("locationName"), "geocode": loc.get("geocode"), "hazards": hz})
    return out


def parse_warning_texts(doc) -> list:
    out = []
    for ds in _as_list(doc["cwaopendata"].get("dataset")):
        info = ds.get("datasetInfo", {})
        content = ((ds.get("contents") or {}).get("content") or {})
        hz = ((ds.get("hazardConditions") or {}).get("hazards") or {}).get("hazard") or {}
        hinfo = hz.get("info", {}) if isinstance(hz, dict) else {}
        areas = [a.get("locationName") for a in _as_list((hinfo.get("affectedAreas") or {}).get("location"))]
        out.append({"title": info.get("datasetDescription"), "issue": info.get("issueTime"),
                    "start": (info.get("validTime") or {}).get("startTime"), "end": (info.get("validTime") or {}).get("endTime"),
                    "text": content.get("contentText"), "ph": hinfo.get("phenomena"), "sig": hinfo.get("significance"),
                    "areas": areas})
    return out
