"""Unit tests for the data pipeline, using trimmed real CWA files as fixtures."""
import gzip
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from pipeline import aloft, hydro, wrf, forecast, geo, grids, gusts, hazards, lightning, peaks, qpf, qpfweb, satellite, stations, wind
from pipeline.build import to_mercator
from pipeline.fetch import FetchError
from pipeline.log import TZ, Log, colorize

FIX = Path(__file__).parent / "fixtures"
TOPO = Path(__file__).parent.parent / "site" / "geo" / "towns-10t.json"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


# ------------------------------------------------------------------ grids
def test_grid_roundtrip():
    vals = np.array([[np.nan, 0.0, 12.3], [45.6, 99.9, 0.1]], np.float32)
    g = {"data": vals, "lon0": 120.0, "lat0": 22.0, "res": 0.5}
    png = grids.encode_png(g, 0.1, 0.0)
    back = grids.decode_png(png, 0.1, 0.0)[::-1]  # decode returns north-up
    assert np.isnan(back[0, 0])
    np.testing.assert_allclose(back[~np.isnan(back)], vals[~np.isnan(vals)], atol=0.051)
    assert grids.bounds(g) == [119.75, 21.75, 121.25, 22.75]


def test_grid_size_mismatch():
    with pytest.raises(ValueError):
        grids.make_grid(np.zeros(5), 2, 2, 120, 22, 0.1)


def test_read_qpesums_fixture():
    values, p = grids.read_qpesums(load("qpe.json"))
    assert (p["nx"], p["ny"]) == (441, 20)
    g = grids.make_grid(values, p["nx"], p["ny"], p["lon0"], p["lat0"], p["res"], (-1,), 0)
    assert g["data"].shape == (20, 441)
    # TWD67 -> WGS84 shift applied
    assert g["lon0"] == pytest.approx(118 + grids.TWD67_TO_WGS84[0])
    c = grids.crop(g)
    assert c["data"].shape[1] < 441


# ------------------------------------------------------------------ qpf
@pytest.fixture(scope="module")
def qpf_result():
    topo = geo.load_topo(TOPO)
    g = qpf.GRID
    land = geo.land_mask(topo, g["lon0"], g["lat0"], g["res"], g["nx"], g["ny"])
    pts = qpf.boundary_points(TOPO)
    return qpf.process((FIX / "qpf_I.png").read_bytes(), pts, land, qpf.prepare_insets(topo)), land


def test_qpf_legend_and_fit(qpf_result):
    r, _ = qpf_result
    assert len(r["legend"]) == 17
    assert r["legend"][0] == (194, 194, 194)  # 0.5-1 mm grey
    assert r["legend"][-1] == (253, 201, 255)  # >=300 mm
    assert r["cost"] < 45 and not r["refit"]


def test_qpf_values(qpf_result):
    r, land = qpf_result
    g = r["grid"]
    # sea and off-island cells are "no data"
    assert (g[~land] == 0).all()
    # every land cell is classified (dry land = 1)
    assert (g[land] >= 1).all()

    def at(lon, lat):
        j = round((lat - qpf.GRID["lat0"]) / qpf.GRID["res"])
        i = round((lon - qpf.GRID["lon0"]) / qpf.GRID["res"])
        return int(g[j, i])

    # Yangmingshan: 70-130 mm on the 2026-10-23 20:30 forecast image
    assert 11 <= at(121.55, 25.17) <= 14
    # Tainan coast: dry / very light
    assert at(120.2, 23.0) <= 3


def test_qpf_island_insets(qpf_result):
    r, _ = qpf_result
    ins = r["insets"]
    assert set(ins) == {"matsu", "dongyin", "juguang", "kinmen"}
    for name, v in ins.items():
        assert "error" not in v and v["cost"] < 1.0 and not v["refit"], name
    counts = {k: set(np.unique(v["grid"]).tolist()) for k, v in ins.items()}
    # 2026-10-23 20:30 image: Nangan grey (0.5-1), Beigan light cyan (1-2),
    # Dongyin 2-10 mm, Juguang dry/grey, Kinmen dry (white) everywhere.
    assert {2, 3} <= counts["matsu"]
    assert {4, 5} <= counts["dongyin"]
    assert counts["juguang"] <= {0, 1, 2}
    assert counts["kinmen"] == {0, 1}

    def at(name, lon, lat):
        from pipeline.qpf import INSET_RES
        topo = geo.load_topo(TOPO)
        g = qpf.prepare_insets(topo)[name]["grid"]
        return int(ins[name]["grid"][round((lat - g["lat0"]) / INSET_RES), round((lon - g["lon0"]) / INSET_RES)])

    assert at("matsu", 119.94, 26.155) == 2   # Nangan
    assert at("matsu", 120.000, 26.222) == 3  # Beigan


def test_qpf_period_start():
    assert qpf.period_start("2026-10-23T20:09:10+08:00").hour == 20
    assert qpf.period_start("2026-10-23T08:40:00+08:00").hour == 8
    assert qpf.period_start("2026-10-23T01:40:00+08:00").isoformat().startswith("2026-10-22T20")


def test_land_mask_includes_taipei():
    topo = geo.load_topo(TOPO)
    g = qpf.GRID
    land = geo.land_mask(topo, g["lon0"], g["lat0"], g["res"], g["nx"], g["ny"])
    j = round((25.05 - g["lat0"]) / g["res"])
    i = round((121.53 - g["lon0"]) / g["res"])
    assert land[j, i]


# ------------------------------------------------------------------ stations
def test_parse_and_merge_stations():
    auto = stations.parse_stations(load("auto.json"), "auto")
    manned = stations.parse_stations(load("manned.json"), "manned")
    rain = stations.parse_stations(load("rain.json"), "rain")
    assert len(auto) == 3 and len(manned) == 2 and len(rain) == 3
    s = auto[0]
    assert s["id"] == "C0TB40" and abs(s["lat"] - 24.16) < 0.05
    assert "G" not in s  # -99 gust is treated as missing
    merged = stations.merge_current(auto, manned, rain)
    ids = [m["id"] for m in merged]
    assert len(ids) == len(set(ids))


def test_history_xml_and_archive(tmp_path):
    doc = stations.load_doc(FIX / "auto_hist.xml")
    recs = stations.parse_stations(doc, "auto")
    assert len(recs) == 2 and recs[0]["t"].startswith("2026-10-08T08:00")
    arc = stations.Archive(tmp_path)
    arc.add(recs, source="k1")
    arc.save()
    assert (tmp_path / "2026-10.csv.gz").exists()
    with gzip.open(tmp_path / "2026-10.csv.gz", "rt") as fh:
        assert fh.readline().startswith("hour,sid,T")
    arc2 = stations.Archive(tmp_path)
    assert "k1" in arc2.processed
    arc2.load_month("2026-10")
    assert ("2026-10-08T08", recs[0]["id"]) in arc2.rows
    n = arc2.export_station_files(tmp_path / "hist", datetime(2026, 10, 9, 0, tzinfo=TZ), days=2)
    assert n == 2
    h = json.loads((tmp_path / "hist" / f"{recs[0]['id']}.json").read_text())
    assert h["n"] == 49 and h["fields"]["T"][32] == recs[0]["T"]  # 2026-10-07T00 + 32 h


def test_num():
    assert stations.num("-99") is None and stations.num("X") is None
    assert stations.num("12.5") == 12.5 and stations.num(None) is None


# ------------------------------------------------------------------ forecasts
def test_compact_elements():
    _, locs = forecast.read_locations(load("spot_week.json"))
    el = forecast.compact_elements(locs[0]["WeatherElement"])
    assert "最高溫度" in el and len(el["最高溫度"]["t"]) == len(el["最高溫度"]["v"]["MaxTemperature"])
    _, locs3 = forecast.read_locations(load("spot_3d.json"))
    el3 = forecast.compact_elements(locs3[0]["WeatherElement"])
    assert "e" not in el3["溫度"] and "e" in el3["3小時降雨機率"]


# ------------------------------------------------------------------ hazards
def test_quake_xml():
    q = hazards.parse_quake_xml((FIX / "quake.xml").read_bytes())
    assert q["mag"] == 4.3 and q["lat"] == 23.56 and q["lon"] == 121.45
    assert q["maxInt"] == 3.0 and q["stations"] and q["areas"]


def test_typhoon_and_tables():
    tcs = hazards.parse_cyclones(load("typhoon.json"))
    assert tcs[0]["cname"] == "薔琵" and tcs[0]["fcst"][0]["r70"] == 30
    rain = hazards.parse_precip_table((FIX / "precip24.xml").read_bytes())
    assert rain["areas"][0]["area"] == "基隆市" and rain["areas"][0]["hi"] == 150
    assert any(a["region"] == "mountain" for a in rain["areas"])
    wind = hazards.parse_wind_table((FIX / "wind.xml").read_bytes())
    kl = next(a for a in wind["areas"] if a["area"] == "基隆市")
    assert kl["periods"][0]["gust"]["max"] == 10 and kl["periods"][0]["average"]["max"] == 7


def test_intensity_value():
    assert hazards._intensity_value("5強") == 5.5
    assert hazards._intensity_value("3級") == 3.0


# ------------------------------------------------------------------ misc
def test_to_mercator_shape():
    from PIL import Image
    img = Image.new("RGB", (40, 80), (10, 20, 30))
    assert to_mercator(img, 19.1, 28.3).size == (40, 80)


def test_log_reproduce_and_color(tmp_path):
    log = Log("t", tmp_path, argv=["python", "-m", "pipeline.build", "--only", "qpf"])
    log.ok("done")
    log.close()
    text = log.path.read_text()
    assert text.startswith("# Reproduce: cd ") and "pipeline.build --only qpf" in text
    assert "\033[32mPASS" in colorize("PASS") and "\033[31mFAIL" in colorize("x FAIL")


# ------------------------------------------------------------------ typhoon table gating
class _StubFetcher:
    """Serves fixtures in place of the S3 fetcher."""

    files = {
        "Warning/W-C0034-005.json": "typhoon.json",
        "Forecast/WindTable.xml": "wind.xml",
        "Forecast/24hPrecipTable.xml": "precip24.xml",
        "Forecast/AllPrecipTable.xml": "precip24.xml",
    }
    warning = {"cwaopendata": {"dataset": [{
        "datasetInfo": {"datasetDescription": "測試颱風警報", "issueTime": "2026-01-01T10:00:00+08:00",
                        "validTime": {"startTime": "2026-01-01T10:00:00+08:00", "endTime": "2026-01-01T16:00:00+08:00"}},
        "contents": {"content": {"contentText": "測試"}},
        "hazardConditions": {"hazards": {"hazard": {"info": {"phenomena": "颱風", "significance": "警報"}}}},
    }]}}

    def get_json(self, key):
        if key == "Warning/W-C0033-002.json":
            return self.warning
        return load(self.files[key])

    def get(self, key):
        return FIX / self.files[key]


@pytest.mark.parametrize("enabled", [False, True])
def test_typhoon_tables_only_when_enabled(tmp_path, monkeypatch, enabled):
    import argparse
    from pipeline import build
    monkeypatch.setattr(build, "now", lambda: datetime.fromisoformat("2026-01-01T12:00:00+08:00"))
    args = argparse.Namespace(out=str(tmp_path / "data"), cache=str(tmp_path / "cache"), typhoon_tables=enabled)
    log = Log("t", tmp_path / "logs", argv=["x"])
    b = build.Builder(args, log)
    b.f = _StubFetcher()
    b.task_typhoon()
    doc = json.loads((tmp_path / "data" / "typhoon.json").read_text())
    if enabled:
        assert set(doc["tables"]) == {"wind", "rain24", "rainTotal"} and doc["tablesRestricted"] is False
    else:
        assert doc["tables"] == {} and doc["tablesRestricted"] is True
        assert doc["tablesLink"].startswith("https://www.cwa.gov.tw/")
    log.close()


# ------------------------------------------------------------------ shakemap
def test_shakemap_georeference_and_levels():
    from pipeline import shakemap
    topo = geo.load_topo(TOPO)
    g = qpf.GRID
    land = geo.land_mask(topo, g["lon0"], g["lat0"], g["res"], g["nx"], g["ny"])
    r = shakemap.process((FIX / "shakemap.png").read_bytes(), topo, land)
    assert len(r["legend"]) == 9 and r["legend"][2] == (255, 255, 0)  # 3級 yellow
    assert r["cost"] < 2 and not r["refit"]
    G = r["grid"]

    def level(lon, lat):
        return shakemap.LEVELS[int(G[round((lat - g["lat0"]) / g["res"]), round((lon - g["lon0"]) / g["res"])]) - 1]

    # 2026-10-24 09:25 M4.0 Kaohsiung Taoyuan: 3級 core east of the epicentre, 0級 in Taipei
    assert level(120.80, 23.10) == "3級"
    assert level(121.5, 25.05) == "0級"
    assert set(np.unique(G).tolist()) <= {0, 1, 2, 3, 4}


def test_shakemap_identifier_stamp():
    from pipeline import shakemap
    assert shakemap.identifier_stamp({"identifier": "202610240925-EQ2026072-Shakemap"}) == "202610240925"


# ------------------------------------------------------------------ accumulated rain
def test_idw_grid_reproduces_gauges():
    from pipeline import rainacc
    g = {"lon0": 120.0, "lat0": 23.0, "res": 0.01, "nx": 50, "ny": 50}
    land = np.ones((50, 50), bool)
    lons, lats, vals = [120.1, 120.3, 120.2, 120.45], [23.1, 23.1, 23.3, 23.45], [10.0, 50.0, 30.0, 0.0]
    a = rainacc.idw_grid(lons, lats, vals, land, g)
    assert abs(a[10, 10] - 10.0) < 0.5 and abs(a[10, 30] - 50.0) < 0.5   # at gauges
    assert 10 < a[10, 20] < 50                                             # between gauges
    assert np.nanmin(a) >= 0 and np.nanmax(a) <= 50
    far = rainacc.idw_grid([120.0], [23.0], [5.0], land, g)                 # < 3 gauges -> blank
    assert np.isnan(far).all()


def test_archive_totals_needs_coverage():
    from pipeline import rainacc
    now_ = datetime(2026, 10, 24, 10, 30, tzinfo=TZ)
    rows = {}
    for h in range(24):
        hk = (now_.replace(minute=0) - timedelta(hours=h)).strftime("%Y-%m-%dT%H")
        rows[(hk, "A")] = {"R1h": 1.0}
        if h < 10:
            rows[(hk, "B")] = {"R1h": 5.0}
    tot = rainacc.archive_totals(rows, now_, 24)
    assert tot == {"A": 24.0}  # B has only 10 of 24 hours


# ------------------------------------------------------------------ QPF totals / 6 h grid
def test_sum_classes_ranges():
    from pipeline import qpfacc
    # class codes: 0 no data, 1 dry, 12 = 70-90 mm, 18 = >=300 mm
    a = np.array([[1, 12, 18, 0]])
    b = np.array([[1, 12, 12, 1]])
    lo, hi, mid = qpfacc.sum_classes([a, b])
    assert lo[0, 0] == 0 and hi[0, 0] == 1.0 and mid[0, 0] == 0
    assert (lo[0, 1], hi[0, 1], mid[0, 1]) == (140, 180, 160)
    assert lo[0, 2] == 370 and np.isinf(hi[0, 2]) and mid[0, 2] == 380
    assert np.isnan(mid[0, 3])  # any period without data -> no total


def test_parse_qpf6_fixture():
    from pipeline import qpfacc
    g = qpfacc.parse_qpf6(load("qpf6.json"))
    assert g["data"].shape == (130, 130) and np.nanmax(g["data"]) > 10
    assert g["start"].startswith("2026-10-24T08") and g["end"].startswith("2026-10-24T14")
    b = grids.bounds(g)
    assert abs(b[0] - (117.56 + grids.TWD67_TO_WGS84[0] - g["res"] / 2)) < 1e-4 and abs(b[3] - 26.67) < 0.05


# ------------------------------------------------------------------ satellite projection
def test_lcc_forward_matches_cwa_grid():
    from pipeline import satellite as sat
    geo_ = {"x0": -3765109.1081896117, "y0": 6022415.477491152, "sx": 1879.834333780261, "sy": 1870.3513229919351,
            "lat0": 0.0, "lon0": 128.5, "lat1": 30.0, "lat2": 60.0, "fe": 0.0, "fn": 0.0}
    x, y = sat.lcc_forward(np.array(128.5), np.array(0.0), geo_)
    assert abs(float(x)) < 1e-6 and abs(float(y)) < 1e-6          # projection origin
    # The image's documented extent starts at 102E / -1N: its south-west corner falls on column ~0
    x, y = sat.lcc_forward(np.array(102.0), np.array(-1.0), geo_)
    assert 0 <= (float(x) - geo_["x0"]) / geo_["sx"] < 10
    assert sat.ir_celsius(np.array([27315.0]))[0] == pytest.approx(0.0)


def _web_head():
    return qpfweb.read_png((FIX / "qpf6_web_head.png").read_bytes())


def test_qpfweb_decode_header():
    cur = datetime(2026, 10, 24, 12, 0, tzinfo=TZ)
    res = qpfweb.decode(_web_head(), cur, 6, qpfweb.load_templates())
    assert qpfweb.confident(res)
    assert res["issue"] == datetime(2026, 10, 24, 11, 30, tzinfo=TZ)
    assert res["start"] == datetime(2026, 10, 24, 20, 0, tzinfo=TZ)
    assert res["end"] == res["start"] + timedelta(hours=6)


def test_qpfweb_learns_missing_digit(tmp_path):
    cur = datetime(2026, 10, 24, 12, 0, tzinfo=TZ)
    tpl = qpfweb.load_templates()
    tpl.pop("4")
    res = qpfweb.decode(_web_head(), cur, 6, tpl)
    assert res["start"] == datetime(2026, 10, 24, 20, 0, tzinfo=TZ)
    learned = qpfweb.learn_unknown_digits(res, 6, tmp_path, tpl)
    assert "4" in learned and (tmp_path / "4.png").exists()
    assert "4" in qpfweb.load_templates(tmp_path)


# ------------------------------------------------------------------ OSM peaks
@pytest.fixture(autouse=True)
def _offline_elevation(monkeypatch):
    """Peak elevations come from a web API in production; unit tests must never reach it."""
    def down(coords, timeout=60):
        raise FetchError("tests are offline")
    monkeypatch.setattr(peaks, "fetch_elevations", down)


OVERPASS_SAMPLE = {"elements": [
    {"type": "node", "id": 1, "lat": 23.47, "lon": 120.957, "tags": {"natural": "peak", "name": "玉山", "ele": "3952"}},
    {"type": "node", "id": 2, "lat": 24.383, "lon": 121.231, "tags": {"natural": "peak", "name": "Snow Mountain", "name:zh": "雪山", "ele": "3,886 m"}},
    {"type": "node", "id": 3, "lat": 24.3831, "lon": 121.2311, "tags": {"natural": "peak", "name:zh": "雪山", "ele": "3886"}},
    {"type": "node", "id": 4, "lat": 25.17, "lon": 121.55, "tags": {"natural": "peak", "name": "七星山", "ele": "abc"}},
    {"type": "node", "id": 5, "lat": 30.0, "lon": 121.0, "tags": {"natural": "peak", "name": "Outside"}},
    {"type": "node", "id": 6, "lat": 24.1, "lon": 121.0, "tags": {"natural": "peak"}},
    {"type": "node", "id": 7, "lat": 23.2, "lon": 120.9, "tags": {"natural": "peak", "name": "測試山", "ele": "9999"}},
]}


def test_peaks_parse():
    out = peaks.parse(OVERPASS_SAMPLE, cwa_mountains=[("玉山", 23.47, 120.957)])
    names = [p[0] for p in out]
    assert "玉山" not in names                      # already a CWA forecast spot
    assert names.count("雪山") == 1                 # zh name preferred, near-duplicates merged
    assert "Outside" not in names and len(out) == 3  # outside Taiwan and unnamed peaks dropped
    assert out[0][:4] == ["雪山", 24.383, 121.231, 3886]  # highest first, '3,886 m' parsed
    assert dict((p[0], p[3]) for p in out) == {"雪山": 3886, "七星山": None, "測試山": None}


def test_peaks_build_cache_and_fallback(tmp_path):
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    n, fresh = peaks.build(tmp_path, log, now, fetch=lambda _log: OVERPASS_SAMPLE)
    assert (n, fresh) == (4, True)
    saved = json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))
    assert saved["license"] == "ODbL-1.0" and saved["fields"][0] == "n"

    def boom(_log):
        raise FetchError("offline")
    assert peaks.build(tmp_path, log, now + timedelta(days=1), fetch=boom) == (4, False)   # fresh copy kept
    assert peaks.build(tmp_path, log, now + timedelta(days=8), fetch=boom) == (4, False)   # stale but Overpass down
    with pytest.raises(FetchError):
        peaks.build(tmp_path / "empty", log, now, fetch=boom)
    log.close()


def test_peaks_area_and_list_tags(tmp_path):
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    lists = tmp_path / "lists"
    lists.mkdir()
    out = tmp_path / "out"
    out.mkdir()
    n, _ = peaks.build(out, log, now, fetch=lambda _log: OVERPASS_SAMPLE, lists_dir=lists)
    saved = json.loads((out / "peaks.json").read_text(encoding="utf-8"))
    assert saved["fields"] == peaks.FIELDS
    rows = {r[0]: r for r in saved["peaks"]}
    assert rows["雪山"][5] == "臺中市和平區／苗栗縣泰安鄉" and rows["雪山"][6] == []   # MOI townships (on a boundary), official 臺
    # A new list re-tags the cached download without fetching again.
    (lists / "baiyue.json").write_text(json.dumps({"id": "baiyue", "label": "百岳", "peaks": [
        {"n": "雪山", "lat": 24.3835, "lon": 121.2315}, {"n": "七星山", "min_ele": 3000}]}, ensure_ascii=False), encoding="utf-8")

    def boom(_log):
        raise AssertionError("should not download")
    assert peaks.build(out, log, now + timedelta(hours=1), fetch=boom, lists_dir=lists) == (n, False)
    saved = json.loads((out / "peaks.json").read_text(encoding="utf-8"))
    rows = {r[0]: r for r in saved["peaks"]}
    assert rows["雪山"][6] == ["baiyue"] and rows["七星山"][6] == []    # no elevation -> no match
    assert saved["lists"] == [{"id": "baiyue", "label": "百岳"}]
    # Old-format file (no area) is upgraded in place.
    old = dict(saved, fields=["n", "lat", "lon", "ele", "osm"], peaks=[r[:5] for r in saved["peaks"]])
    (out / "peaks.json").write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
    peaks.build(out, log, now + timedelta(hours=2), fetch=boom, lists_dir=lists)
    assert json.loads((out / "peaks.json").read_text(encoding="utf-8"))["peaks"][0][5]
    log.close()


def _fc(t, ws, bf, wd, at=None, pop=None):
    d = {"風速": {"t": t, "v": {"WindSpeed": ws, "BeaufortScale": bf}}, "風向": {"t": t, "v": {"WindDirection": wd}}}
    if at:
        d["體感溫度"] = {"t": t, "v": {"ApparentTemperature": at}}
    if pop:
        d["3小時降雨機率"] = {"t": t, "v": {"ProbabilityOfPrecipitation": pop}}
    return d


def test_wind_summary(tmp_path):
    (tmp_path / "towns").mkdir()
    (tmp_path / "spots" / "f").mkdir(parents=True)
    t = ["2026-10-24T12:00:00+08:00", "2026-10-24T15:00:00+08:00"]
    (tmp_path / "towns" / "10014020.json").write_text(json.dumps(
        {"g": "10014020", "n": "成功鎮", "lat": "23.1", "lon": "121.37", "issue3d": "2026-10-24T11:00:00+08:00",
         "d3": _fc(t, ["6", "11"], ["4", "6"], ["東北風", "偏北風"], ["24", "22"], [30, 70]),
         "week": {"紫外線指數": {"t": ["2026-10-24T12:00:00+08:00", "2026-10-25T06:00:00+08:00", "2026-10-25T18:00:00+08:00"],
                                 "v": {"UVIndex": [4, 7, 0]}}}}), encoding="utf-8")
    (tmp_path / "spots" / "f" / "mountain-D001.json").write_text(json.dumps(
        {"k": "mountain-D001", "n": "玉山", "lat": 23.47, "lon": 120.957, "d3": _fc(t[1:], [14], [7], ["西南風"])}), encoding="utf-8")
    r = wind.build(tmp_path)
    assert (r["times"], r["towns"], r["mountains"]) == (2, 1, 1)
    d = json.loads((tmp_path / "wind.json").read_text(encoding="utf-8"))
    assert d["towns"]["10014020"] == [[6, 11], [4, 6], [1, 0], [None, None], [24, 22], [30, 70]]  # ws, Beaufort, dir, gust, apparent, rain %
    assert d["uv"]["10014020"] == [["2026-10-24", 4], ["2026-10-25", 7]]            # first period of each date
    assert d["mountains"][0]["w"][:3] == [[None, 14], [None, 7], [None, 5]]  # missing first step stays empty
    assert d["gustSource"] is None


def test_gusts_open_meteo(tmp_path):
    test_wind_summary(tmp_path)
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    hours = [f"2026-10-24T{h:02d}:00" for h in range(12, 18)]

    def fake(pts):
        assert [p[0] for p in pts] == ["10014020"]                        # townships (no mountain index here)
        return [{"hourly": {"time": hours, "wind_gusts_10m": [9.0, 12.5, 11.0, 14.2, None, 8.0]}}]
    r = gusts.build(tmp_path, log, now, fetch=fake)
    assert r["fresh"] and r["points"] == 1
    wind.build(tmp_path)
    d = json.loads((tmp_path / "wind.json").read_text(encoding="utf-8"))
    assert d["towns"]["10014020"][3] == [12.5, 14.2]                   # max gust in each 3-hour step
    assert d["gustSource"]["name"] == "Open-Meteo"

    def boom(_pts):
        raise FetchError("offline")
    assert gusts.build(tmp_path, log, now + timedelta(minutes=30), fetch=boom)["fresh"] is False   # fresh copy, no fetch
    assert gusts.build(tmp_path, log, now + timedelta(hours=2), fetch=boom)["fresh"] is False      # API down: keep
    with pytest.raises(FetchError):
        gusts.build(tmp_path, log, now + timedelta(hours=13), fetch=boom)                          # too old: dropped
    assert not (tmp_path / "gusts.json").exists()
    log.close()


def test_aloft_open_meteo(tmp_path):
    (tmp_path / "spots").mkdir()
    (tmp_path / "spots" / "index.json").write_text(json.dumps({"spots": [
        {"k": "mountain-D001", "c": "mountain", "lat": 23.47, "lon": 120.957}, {"k": "park-1", "c": "park", "lat": 24, "lon": 121}]}), encoding="utf-8")
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    hours = [f"2026-10-24T{h:02d}:00" for h in range(12, 19)]
    h = {"time": hours, "visibility": [30000.0, 20000, 12000, 9500, 500, None, 8000], "uv_index": [5.0, 4, 3, 2, 0, 0, 0],
         "freezing_level_height": [4200.0] * 7}
    for lv in aloft.LEVELS:
        h[f"wind_speed_{lv}hPa"] = [10.0 + lv / 100] * 7
        h[f"wind_direction_{lv}hPa"] = [250.0] * 7
        h[f"geopotential_height_{lv}hPa"] = [float(lv) * 3] * 7

    def fake(pts):
        assert [p[0] for p in pts] == ["mountain-D001"]                  # mountains only
        return [{"hourly": h}]
    r = aloft.build(tmp_path, log, now, fetch=fake)
    assert r["fresh"] and r["points"] == 1
    d = json.loads((tmp_path / "aloft.json").read_text(encoding="utf-8"))
    assert d["times"] == ["2026-10-24T12:00:00+08:00", "2026-10-24T15:00:00+08:00", "2026-10-24T18:00:00+08:00"]
    p = d["points"]["mountain-D001"]
    assert p["vis"] == [30.0, 9.5, 8.0] and p["uv"] == [5.0, 2.0, 0.0] and p["fz"] == [4200] * 3
    assert d["levels"] == [925, 850, 700, 500] and p["ws"][1] == [18.5] * 3 and p["wd"][0] == [250] * 3 and p["z"][3] == [1500] * 3

    def boom(_pts):
        raise FetchError("offline")
    assert aloft.build(tmp_path, log, now + timedelta(hours=2), fetch=boom)["fresh"] is False      # API down: keep
    with pytest.raises(FetchError):
        aloft.build(tmp_path, log, now + timedelta(hours=13), fetch=boom)                          # too old: dropped
    log.close()


def test_lightning_kmz(tmp_path):
    import io
    import zipfile
    kml = """<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>中央氣象署閃電資料: 2026-10-24 14:15 ~ 2026-10-24 15:15</name><Folder><name>閃電資料 (2筆)</name>
<Placemark><name>2026-10-24 15:01:02</name><description>強度: -23.5 kA</description><styleUrl>#m_valid_pos-pushpin0</styleUrl><Point><coordinates>121.10,23.50,0</coordinates></Point></Placemark>
<Placemark><description>時間 2026/10/24 14:40:00</description><styleUrl>#m_valid_cloud-pushpin0</styleUrl><Point><coordinates>120.9,23.4,0</coordinates></Point></Placemark>
</Folder></Document></kml>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("doc.kml", kml)
    r = lightning.parse_kmz(buf.getvalue())
    assert r["count"] == 2 and r["start"] == "2026-10-24T14:15:00+08:00" and r["end"] == "2026-10-24T15:15:00+08:00"
    first, second = r["strikes"]
    assert first == {"lat": 23.5, "lon": 121.1, "t": "2026-10-24T15:01:02+08:00", "cloud": False, "ka": -23.5}
    assert second["cloud"] and second["t"] == "2026-10-24T14:40:00+08:00" and second["ka"] is None


def test_cwa_mountain_snapped_to_osm_summit(tmp_path):
    log = Log("t", tmp_path)
    (tmp_path / "spots").mkdir()
    spots = [{"k": "mountain-D001", "n": "雪山主峰", "c": "mountain", "lat": 24.40, "lon": 121.25},   # ~2.6 km off
             {"k": "mountain-D002", "n": "測試峰", "c": "mountain", "lat": 23.0, "lon": 121.0},
             {"k": "park-A1", "n": "成功", "c": "park", "lat": 23.1, "lon": 121.37}]
    (tmp_path / "spots" / "index.json").write_text(json.dumps({"spots": spots}, ensure_ascii=False), encoding="utf-8")
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    peaks.build(tmp_path, log, now, fetch=lambda _log: OVERPASS_SAMPLE, lists_dir=tmp_path / "none")
    saved = json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))
    assert "雪山" not in [p[0] for p in saved["peaks"]]                  # shown once, as the forecast mountain
    assert abs(saved["cwaMatch"]["mountain-D001"][0] - 24.383) < 0.001  # "雪山" matches "雪山主峰"
    idx = {s["k"]: s for s in json.loads((tmp_path / "spots" / "index.json").read_text(encoding="utf-8"))["spots"]}
    assert abs(idx["mountain-D001"]["plat"] - 24.383) < 0.001 and idx["mountain-D001"]["ele"] == 3886
    assert "plat" not in idx["mountain-D002"]
    assert idx["mountain-D001"]["a"].startswith("臺中市和平區") and idx["park-A1"]["a"] == "臺東縣成功鎮"
    log.close()


def test_peaks_outside_taiwan_dropped(tmp_path):
    log = Log("t", tmp_path)
    data = {"elements": [
        {"type": "node", "id": 1, "lat": 24.383, "lon": 121.231, "tags": {"natural": "peak", "name": "石牛山", "ele": "155"}},
        {"type": "node", "id": 2, "lat": 25.70, "lon": 118.30, "tags": {"natural": "peak", "name": "石牛山", "ele": "1782"}},   # Fujian
        {"type": "node", "id": 3, "lat": 25.90, "lon": 119.00, "tags": {"natural": "peak", "name": "石牛山", "ele": "1116"}}]}   # Fujian
    n, _ = peaks.build(tmp_path, log, datetime(2026, 10, 24, 12, tzinfo=TZ), fetch=lambda _log: data, lists_dir=tmp_path / "none")
    saved = json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))
    assert n == 1 and [p[3] for p in saved["peaks"]] == [155] and saved["peaks"][0][5]
    log.close()


def test_cached_peaks_reprocessed_when_rules_change(tmp_path):
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    peaks.build(tmp_path, log, now, fetch=lambda _log: OVERPASS_SAMPLE, lists_dir=tmp_path / "none")
    saved = json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))
    saved["peaks"].append(["石牛山", 25.7, 118.3, 1782, 99, "", []])        # a mainland peak left by an older build
    saved["listsVersion"] = "old"
    (tmp_path / "peaks.json").write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")

    def boom(_log):
        raise AssertionError("no download expected")
    peaks.build(tmp_path, log, now + timedelta(hours=1), fetch=boom, lists_dir=tmp_path / "none")
    again = json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))
    assert all(p[3] != 1782 for p in again["peaks"]) and again["listsVersion"] != "old"
    log.close()


def test_missing_peak_elevations_estimated(tmp_path):
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 24, 12, tzinfo=TZ)
    calls = []

    def dem(coords):
        calls.append(len(coords))
        return [123.4 + i for i, _ in enumerate(coords)]
    lists = tmp_path / "lists"
    lists.mkdir()
    (lists / "x.json").write_text(json.dumps({"id": "x", "label": "X", "peaks": [{"n": "七星山", "min_ele": 100}]}, ensure_ascii=False), encoding="utf-8")
    peaks.build(tmp_path, log, now, fetch=lambda _log: OVERPASS_SAMPLE, lists_dir=lists, fetch_ele=dem)
    saved = json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))
    rows = {r[0]: r for r in saved["peaks"]}
    assert rows["雪山"][3] == 3886 and rows["雪山"][7] == 0                 # OSM value untouched
    assert rows["七星山"][7] == 1 and 123 <= rows["七星山"][3] <= 130        # estimated, flagged
    assert rows["七星山"][6] == ["x"]                                       # list matched on the estimate
    # A later build keeps the estimate and does not ask again for peaks that have one.
    calls.clear()
    peaks.build(tmp_path, log, now + timedelta(hours=1), fetch=lambda _log: (_ for _ in ()).throw(AssertionError("no download")), lists_dir=lists, fetch_ele=dem)
    assert calls == []
    # API down: peaks stay without elevation, the build still works.
    (tmp_path / "peaks.json").unlink()
    peaks.build(tmp_path, log, now, fetch=lambda _log: OVERPASS_SAMPLE, lists_dir=lists)
    assert any(r[3] is None for r in json.loads((tmp_path / "peaks.json").read_text(encoding="utf-8"))["peaks"])
    log.close()


def test_satellite_bilinear_resample():
    from pipeline import satellite
    # A flat 4x4 'image' with a gradient in x; geo as a trivial projection is not available, so test the sampler through a
    # stub lcc: identity-like geo where lcc_forward is replaced by a linear map.
    arr = np.tile(np.arange(4, dtype=np.float32), (4, 1))          # value = column index
    arr[0, 0] = np.nan                                            # a missing pixel must not poison neighbours
    geo = {"x0": 0.0, "y0": 4.0, "sx": 1.0, "sy": 1.0}
    orig = satellite.lcc_forward
    satellite.lcc_forward = lambda lon, lat, g: (lon, lat)       # x = lon, y = lat (metres == degrees here)
    try:
        grid = {"lon0": 0.5, "lat0": 0.5, "res": 0.5, "nx": 7, "ny": 7}
        out = satellite.resample(arr, geo, grid)
        near = satellite.resample(arr, geo, grid, bilinear=False)
    finally:
        satellite.lcc_forward = orig
    # cell centre at x = 2.0 is the pixel boundary between columns 1 and 2: bilinear gives 1.5, nearest gives a whole number
    j = int(round((1.5 - 0.5) / 0.5)); i = int(round((2.0 - 0.5) / 0.5))
    assert abs(out[j, i] - 1.5) < 1e-5 and near[j, i] in (1.0, 2.0)
    assert np.isfinite(out[~np.isnan(out)]).all() and not np.isnan(out[j, i])
    assert np.isnan(out[0, 0]) or abs(out[0, 0]) < 4              # outside / edge handled without errors


class _Msg:
    def __init__(self, name, level, values, lat, lon, kind="isobaricInhPa"):
        self.shortName, self.level, self.typeOfLevel = name, level, kind
        self.values = np.ma.masked_invalid(values)
        self._ll = (lat, lon)

    def latlons(self):
        return self._ll


def test_wrf_interpolation_and_build(tmp_path):
    lat, lon = np.meshgrid(np.linspace(15, 32, 120), np.linspace(110, 132, 150), indexing="ij")   # model grid (lat, lon 2-D)
    msgs = [_Msg("u", 850, lon * 0.1, lat, lon), _Msg("v", 850, lat * 0.1, lat, lon), _Msg("gh", 850, lon * 0 + 1500.0, lat, lon),
            _Msg("u", 1000, lon * 0, lat, lon), _Msg("t", 850, lon * 0, lat, lon), _Msg("u", 850, lon * 0, lat, lon, kind="surface")]
    fields, interp = wrf.extract(msgs)
    assert set(fields) == {("u", 850), ("v", 850), ("gh", 850)}                       # other levels, variables and level types skipped
    u = fields[("u", 850)]
    assert u.shape == (wrf.GRID["ny"], wrf.GRID["nx"]) and abs(u[0, 0] - 11.6) < 1e-6 and abs(u[0, 40] - 12.6) < 1e-6   # linear field is exact
    assert abs(fields[("v", 850)][36, 0] - 2.8) < 1e-6

    def fake_open(path):
        class G(list):
            def close(self):
                pass
        return G([_Msg(n, lv, (lon * 0.1 if n == "u" else lat * 0.1 if n == "v" else lon * 0 + 1500 * 850 / lv), lat, lon)
                  for lv in wrf.LEVELS for n in ("u", "v", "gh")])
    meta = json.dumps({"cwaopendata": {"dataset": {"datasetInfo": {"InitialTime": "202610270000"}}}}).encode()
    calls = []

    def fetch(key):
        calls.append(key)
        return meta if key == wrf.META_KEY else b"x"
    log = Log("t", tmp_path)
    now = datetime(2026, 10, 27, 10, tzinfo=TZ)
    r = wrf.build(tmp_path, log, fetch, now, open_grib=fake_open)
    assert r["fresh"] and r["steps"] == 13 and len(calls) == 14
    d = json.loads((tmp_path / "wrf.json").read_text(encoding="utf-8"))
    assert d["init"] == "2026-10-27T08:00:00+08:00" and d["steps"][1] == "2026-10-27T14:00:00+08:00" and d["levels"] == wrf.LEVELS
    assert len(d["u"]) == len(wrf.LEVELS) and len(d["u"][0]) == 13 and len(d["u"][0][0]) == 41 * 37 and d["u"][1][0][0] == 116   # u = 11.6 m/s -> 116 (0.1 m/s)
    calls.clear()
    assert wrf.build(tmp_path, log, fetch, now, open_grib=fake_open)["fresh"] is False and calls == [wrf.META_KEY]   # same run: no download
    log.close()


def test_hydro_parsers(tmp_path):
    assert hydro.parse_debris([]) == [] and hydro.parse_debris({"errorMessage": "目前無警戒"}) == []
    d = hydro.parse_debris([{"AlertType": "D", "DebrisNo": "投縣DF001", "AlertLevel": "r", "County": "南投縣", "Town": "信義鄉", "Vill": "同富村"},
                            {"alerttype": "L", "debrisNo": "L01", "alertlevel": "y"}])
    assert d[0] == {"no": "投縣DF001", "level": "red", "type": "D", "county": "南投縣", "town": "信義鄉", "village": "同富村"} and d[1]["level"] == "yellow"
    lon, lat = hydro.tm2_to_lonlat(310928.30, 2790168.45)               # 金山 river station
    assert abs(lon - 121.60) < 0.02 and abs(lat - 25.22) < 0.02
    stations = [{"observatoryidentifier": "1010H006_API", "basinidentifier": "1010H006", "observatoryname": "金山", "rivername": "磺溪",
                 "locationbytwd97_xy": "310928.30 2790168.45", "alertlevel1": "5.5", "alertlevel2": "", "alertlevel3": "4.0"},
                {"observatoryidentifier": "X_API", "basinidentifier": "X", "observatoryname": "無座標"}]
    levels = [{"stationid": "1010H006", "observatoryidentifier": "1010H006_API", "checkresult": "true", "datetime": "2026-10-27T18:00:00", "waterlevel": "1.93"},
              {"stationid": "1010H007", "observatoryidentifier": "1010H007_API", "checkresult": "true", "datetime": "2026-10-27T18:00:00", "waterlevel": "0.13"},
              {"stationid": "X", "observatoryidentifier": "X_API", "checkresult": "true", "datetime": "2026-10-27T18:00:00", "waterlevel": "1"},
              {"stationid": "1010H006", "observatoryidentifier": "1010H006_API", "checkresult": "false", "waterlevel": "99"}]
    r = hydro.parse_rivers(levels, stations)
    assert len(r) == 1 and r[0]["n"] == "金山" and r[0]["wl"] == 1.93 and r[0]["a1"] == 5.5 and r[0]["a2"] is None and r[0]["t"] == "2026-10-27T18:00:00+08:00"
    daily = [{"reservoiridentifier": "10201", "reservoirname": "石門水庫", "capacity": "2.5"}, {"reservoiridentifier": "10802", "reservoirname": "羅東攔河堰"}]
    realtime = [{"reservoiridentifier": "10201", "observationtime": "2026-10-27T07:00:00", "waterlevel": "240.1", "effectivewaterstoragecapacity": "2.0", "totaloutflow": "10"},
                {"reservoiridentifier": "10201", "observationtime": "2026-10-27T08:00:00", "waterlevel": "240.5", "effectivewaterstoragecapacity": "2.1", "inflowdischarge": "5.5",
                 "totaloutflow": "30.0", "spillwayoutflow": "12", "predeterminedcrossflow": "50", "predeterminedoutflowtime": "2026-10-27T20:00:00"},
                {"reservoiridentifier": "99999", "observationtime": "2026-10-27T08:00:00", "waterlevel": "1"}]
    spots = [{"n": "石門水庫", "c": "reservoir", "lat": 24.81, "lon": 121.24}, {"n": "別處", "c": "park", "lat": 1, "lon": 2}]
    rs = hydro.parse_reservoirs(realtime, daily, spots)
    assert len(rs) == 1 and rs[0]["n"] == "石門水庫" and rs[0]["wl"] == 240.5 and rs[0]["spill"] == 12 and rs[0]["plan"] == 50 and rs[0]["lat"] == 24.81   # latest reading only
    (tmp_path / "spots").mkdir()
    (tmp_path / "spots" / "index.json").write_text(json.dumps({"spots": spots}), encoding="utf-8")
    log = Log("t", tmp_path)
    answers = {hydro.URLS["debris"]: [], hydro.URLS["river_level"]: levels, hydro.URLS["river_station"]: stations,
               hydro.URLS["reservoir"]: realtime, hydro.URLS["reservoir_daily"]: daily}
    res = hydro.build(tmp_path, log, datetime(2026, 10, 27, 18, tzinfo=TZ), fetch=answers.__getitem__)
    assert res == {"debris": 0, "rivers": 1, "reservoirs": 1, "errors": []}

    def flaky(url):
        if url == hydro.URLS["debris"]:
            raise FetchError("down")
        return answers[url]
    res = hydro.build(tmp_path, log, datetime(2026, 10, 27, 18, 30, tzinfo=TZ), fetch=flaky)
    assert res["errors"] and json.loads((tmp_path / "hydro.json").read_text(encoding="utf-8"))["debris"] == []   # failed source keeps the last copy
    log.close()


def test_visible_albedo_night_and_day():
    day = np.array([0, 300, 5000, 9000, 65535, 65531], dtype=np.float32)          # 0 = no data in daytime; 65531 = -5 wrapped
    a = satellite.vis_albedo(day)
    assert np.isnan(a[0]) and np.isnan(a[4]) and a[1] == pytest.approx(0.03) and a[3] == pytest.approx(0.9) and a[5] == 0.0
    assert not satellite.is_dark(a, day)
    night = np.array([0, 5, 11, 17, 65531, 65525, 65519, 29, 35], dtype=np.float32)   # noise around zero
    n = satellite.vis_albedo(night)
    assert satellite.is_dark(n) and not np.isnan(n).any() and n.max() < 0.01                 # uniformly dark, no speckles / white
