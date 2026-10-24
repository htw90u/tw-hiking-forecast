"""Unit tests for the data pipeline, using trimmed real CWA files as fixtures."""
import gzip
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from pipeline import forecast, geo, grids, hazards, qpf, stations
from pipeline.build import to_mercator
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
