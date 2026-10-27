"""Debris-flow alerts (ARDSWC) and river / reservoir water data (WRA): endpoint probe.

The first version only reports what each candidate endpoint answers (status, size, top-level keys and
the first records) so the parsers can be written against real responses.
"""
import json
import urllib.error
import urllib.request

from .fetch import SSL_CTX, USER_AGENT

CANDIDATES = {
    "debris": ["https://246.ardswc.gov.tw/webService/GetAlertData.ashx",
               "https://246.swcb.gov.tw/webService/GetAlertData.ashx"],
    "river-level": ["https://opendata.wra.gov.tw/api/v2/1602CA19-B224-4CC3-AA31-11B6D9F8D4A2?format=JSON",
                    "https://opendata.wra.gov.tw/Service/OpenData.aspx?format=json&id=1602CA19-B224-4CC3-AA31-11B6D9F8D4A2",
                    "https://fhy.wra.gov.tw/Api/v2/Water/RealTimeInfo",
                    "https://fhy.wra.gov.tw/WraApi/v1/Water/RealTimeInfo"],
    "river-station": ["https://fhy.wra.gov.tw/Api/v2/Water/Station",
                      "https://fhy.wra.gov.tw/WraApi/v1/Water/Station"],
    "reservoir": ["https://opendata.wra.gov.tw/api/v2/2be9044c-6e44-4856-aad5-dd108c2e6679?format=JSON",
                  "https://opendata.wra.gov.tw/Service/OpenData.aspx?format=json&id=2be9044c-6e44-4856-aad5-dd108c2e6679"],
    "reservoir-station": ["https://fhy.wra.gov.tw/Api/v2/Reservoir/Station",
                          "https://fhy.wra.gov.tw/WraApi/v1/Reservoir/Station?$top=200"],
}


def probe(log, timeout=40):
    for name, urls in CANDIDATES.items():
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                    body = r.read()
                    log.info(f"probe {name}: HTTP {r.status} {len(body)} bytes {url}")
            except urllib.error.HTTPError as e:
                log.info(f"probe {name}: HTTP {e.code} {url}")
                continue
            except Exception as e:  # noqa: BLE001
                log.info(f"probe {name}: {type(e).__name__} {e} {url}")
                continue
            text = body.decode("utf-8-sig", errors="replace")
            try:
                data = json.loads(text)
                if isinstance(data, dict):
                    log.info(f"probe {name}: dict keys {list(data)[:12]}")
                    for k, v in list(data.items())[:3]:
                        log.info(f"probe {name}:   {k} -> {json.dumps(v, ensure_ascii=False)[:500]}")
                else:
                    log.info(f"probe {name}: list of {len(data)}; first {json.dumps(data[:2], ensure_ascii=False)[:700]}")
            except ValueError:
                log.info(f"probe {name}: not JSON: {text[:300]!r}")
