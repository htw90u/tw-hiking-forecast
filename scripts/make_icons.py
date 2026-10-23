"""Generate the PWA icons (run once): python scripts/make_icons.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline.bootstrap import ensure_requirements  # noqa: E402

ensure_requirements()
from PIL import Image, ImageDraw  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "site" / "icons"


def icon(size: int) -> Image.Image:
    s = size / 512
    im = Image.new("RGBA", (size, size), (29, 78, 95, 255))
    d = ImageDraw.Draw(im)
    d.polygon([(40 * s, 420 * s), (210 * s, 150 * s), (300 * s, 290 * s), (360 * s, 210 * s), (480 * s, 420 * s)], fill=(236, 240, 238, 255))
    d.polygon([(210 * s, 150 * s), (250 * s, 214 * s), (175 * s, 205 * s)], fill=(255, 255, 255, 255))
    for i, x in enumerate((330, 380, 430)):
        y = 80 + i * 18
        d.line([(x * s, y * s), ((x - 22) * s, (y + 60) * s)], fill=(86, 180, 233, 255), width=max(2, int(14 * s)))
    return im


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for n in (192, 512):
        icon(n).save(OUT / f"icon-{n}.png", optimize=True)
        print(f"PASS wrote {OUT / f'icon-{n}.png'}")
