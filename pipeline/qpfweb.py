"""Daily 6-hour QPF images from the CWA website (not on the open data platform).

The website images carry no metadata, so the issue and valid times are read
from the header text: glyphs are segmented on the two header lines and
candidate times (issue at hh:30 within the last 36 h, periods on 02/08/14/20 h
boundaries) are scored against digit templates. Digits without a template yet
(7, 9) are scored as "unlike every known digit". The georeferencing and colour
decoding are shared with pipeline.qpf (identical layout).
"""
import io
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from PIL import Image

WEB_BASE = "https://www.cwa.gov.tw"
IMAGES_6H = [f"Data/fcst_img/QPF_ChFcstPrecip_6_{t:02d}.png" for t in range(6, 49, 6)]
TEMPLATE_DIR = Path(__file__).resolve().parent / "qpf_digits"
LINES = {"issue": (58, 101), "valid": (103, 146)}  # pixel rows of the two header lines
SKIP = 5  # 4 CJK characters + full-width colon
GLYPH = (12, 20)
FMT = "%Y/%m/%d%H:%M"  # header text without spaces, e.g. 2026/10/2411:30


def segments(img_gray: np.ndarray, y0: int, y1: int) -> list:
    """Glyph bitmaps (normalised) of one header line, left to right."""
    band = img_gray[y0:y1, :1000] < 128
    cols = band.any(axis=0)
    out, start = [], None
    for x, c in enumerate(list(cols) + [False]):
        if c and start is None:
            start = x
        elif not c and start is not None:
            g = band[:, start:x]
            out.append(np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize(GLYPH, Image.BILINEAR)) / 255.0)
            start = None
    return out[SKIP:]


def load_templates(extra_dir: Path = None) -> dict:
    tpl = {}
    for d in (TEMPLATE_DIR, extra_dir):
        if d and Path(d).exists():
            for p in Path(d).glob("?.png"):
                tpl[p.stem] = np.asarray(Image.open(p).convert("L")) / 255.0
    return tpl


def _dist(a, b):
    return float(np.mean(np.abs(a - b)))


def score(glyphs: list, text: str, tpl: dict) -> float:
    """Lower is better. Punctuation is skipped; unknown digits must look unlike known ones."""
    if len(glyphs) != len(text):
        return float("inf")
    total = 0.0
    for g, ch in zip(glyphs, text):
        if not ch.isdigit():
            continue
        if ch in tpl:
            total += _dist(g, tpl[ch])
        else:
            nearest = min((_dist(g, t) for t in tpl.values()), default=1.0)
            total += max(0.0, 0.12 - nearest) * 3  # penalise if it resembles a known digit
    return total


def decode(rgba: np.ndarray, now: datetime, hours: int, tpl: dict) -> dict:
    """Read issue / valid times from a QPF image header (``hours`` = period length)."""
    gray = np.asarray(Image.fromarray(rgba).convert("L")).astype(int)
    lines = {k: segments(gray, *v) for k, v in LINES.items()}
    base = now.replace(minute=30, second=0, microsecond=0)
    issues = [base - timedelta(minutes=30 * k) for k in range(0, 76)]
    issues = [t for t in issues if t.minute == 30]
    starts = []
    t = (now - timedelta(hours=36)).replace(minute=0, second=0, microsecond=0)
    while t <= now + timedelta(hours=60):
        if t.hour % 6 == 2:
            starts.append(t)
        t += timedelta(hours=1)
    best_i = sorted((score(lines["issue"], i.strftime(FMT), tpl), i) for i in issues)
    best_v = sorted((score(lines["valid"], f"{s.strftime(FMT)}~{(s + timedelta(hours=hours)).strftime(FMT)}", tpl), s)
                    for s in starts)
    (si, issue), (si2, _) = best_i[0], best_i[1]
    (sv, start), (sv2, _) = best_v[0], best_v[1]
    n_i = sum(c.isdigit() for c in issue.strftime(FMT))
    n_v = sum(c.isdigit() for c in start.strftime(FMT)) * 2
    return {"issue": issue, "start": start, "end": start + timedelta(hours=hours),
            "err": max(si / n_i, sv / n_v), "margin": min(si2 - si, sv2 - sv), "glyphs": lines}


def confident(res: dict) -> bool:
    return res["err"] < 0.06 and res["margin"] > 0.05


def learn_unknown_digits(res: dict, hours: int, store: Path, tpl: dict) -> list:
    """Save glyphs of digits that have no template yet (e.g. 7, 9) from a confident decode."""
    learned = []
    texts = {"issue": res["issue"].strftime(FMT),
             "valid": f"{res['start'].strftime(FMT)}~{res['end'].strftime(FMT)}"}
    store.mkdir(parents=True, exist_ok=True)
    for k, text in texts.items():
        for g, ch in zip(res["glyphs"][k], text):
            if ch.isdigit() and ch not in tpl and ch not in learned:
                Image.fromarray((g * 255).astype(np.uint8)).save(store / f"{ch}.png")
                learned.append(ch)
    return learned


def read_png(data: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"))
