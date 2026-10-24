"""Download CWA open data files from the official public S3 mirror.

The CWA open data lake (bucket ``cwaopendata``) mirrors the opendata.cwa.gov.tw
file API, needs no API key and allows cross-origin reads.  Files are cached on
disk together with their ETag so unchanged files are not downloaded again.
"""
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

S3_BASE = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com"
USER_AGENT = "tw-hiking-forecast/1.0 (+https://github.com/htw90u/tw-hiking-forecast)"


# Certificates are still verified against the CA bundle; only Python 3.13's
# extra X.509 strictness (e.g. "Missing Subject Key Identifier") is relaxed,
# matching curl/OpenSSL defaults.
SSL_CTX = ssl.create_default_context()
SSL_CTX.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)


class FetchError(RuntimeError):
    pass


class Fetcher:
    def __init__(self, cache_dir: Path, log, base: str = S3_BASE, timeout: int = 90, retries: int = 4):
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.log = log
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.downloaded = 0
        self.reused = 0

    def _request(self, url: str, headers=None) -> tuple:
        delay = 2
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=SSL_CTX) as r:
                    return r.status, dict(r.headers), r.read()
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    return 304, dict(e.headers), b""
                if e.code in (403, 404):
                    raise FetchError(f"HTTP {e.code} for {url}") from e
                err = e
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                err = e
            if attempt < self.retries:
                time.sleep(delay)
                delay *= 2
        raise FetchError(f"giving up on {url}: {err}")

    def path_for(self, key: str) -> Path:
        return self.cache / key

    def get(self, key: str) -> Path:
        """Return a local path for ``key``, downloading it if it changed."""
        dest = self.path_for(key)
        meta = dest.with_name(dest.name + ".etag")
        headers = {}
        if dest.exists() and meta.exists():
            headers["If-None-Match"] = meta.read_text().strip()
        status, hdrs, body = self._request(f"{self.base}/{urllib.parse.quote(key)}", headers)
        if status == 304:
            self.reused += 1
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        tmp.write_bytes(body)
        tmp.replace(dest)
        etag = hdrs.get("ETag") or hdrs.get("Etag")
        if etag:
            meta.write_text(etag)
        self.downloaded += 1
        return dest

    def get_json(self, key: str):
        return json.loads(self.get(key).read_text(encoding="utf-8-sig"))

    def get_many(self, keys, workers: int = 8) -> dict:
        """Download keys in parallel; returns {key: Path or Exception}."""
        out = {}

        def one(k):
            try:
                return k, self.get(k)
            except Exception as e:  # noqa: BLE001 - reported to caller
                return k, e

        with ThreadPoolExecutor(max_workers=workers) as ex:
            for k, v in ex.map(one, keys):
                out[k] = v
        return out

    def list(self, prefix: str) -> list:
        """List objects under prefix -> [(key, last_modified, size)]."""
        items, token = [], None
        while True:
            q = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
            if token:
                q["continuation-token"] = token
            _, _, body = self._request(f"{self.base}/?{urllib.parse.urlencode(q)}")
            text = body.decode("utf-8")
            for m in re.finditer(r"<Contents>(.*?)</Contents>", text, re.S):
                c = m.group(1)
                key = re.search(r"<Key>(.*?)</Key>", c).group(1)
                lm = re.search(r"<LastModified>(.*?)</LastModified>", c).group(1)
                size = int(re.search(r"<Size>(\d+)</Size>", c).group(1))
                items.append((key, lm, size))
            m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", text)
            if not m:
                return items
            token = m.group(1)
