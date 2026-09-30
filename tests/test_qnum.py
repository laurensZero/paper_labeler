"""Smoke tests for backend.services.qnum (Pillow only)."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.qnum import find_question_number, strip_question_number


def _make_stem(*, qnum_text: str | None, width: int = 800, height: int = 80) -> Image.Image:
    """Synthetic exam line: [number][gap][stem text as dark bars]."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    d = ImageDraw.Draw(img)
    y0, y1 = 25, 55
    x = 20
    if qnum_text:
        for _ in qnum_text:
            d.rectangle([x, y0, x + 12, y1], fill=(20, 20, 20))
            x += 16
        d.rectangle([x, y1 - 8, x + 6, y1], fill=(20, 20, 20))
        x += 6
        x += 70
    d.rectangle([x, y0, x + 400, y1], fill=(20, 20, 20))
    return img


def _region_is_white(img: Image.Image, box: tuple[int, int, int, int]) -> bool:
    region = img.crop(box).convert("L")
    pixels = list(region.getdata())
    return sum(1 for p in pixels if p > 200) / max(len(pixels), 1) > 0.95


def test_detects_leading_number():
    img = _make_stem(qnum_text="12")
    hit = find_question_number(img)
    assert hit is not None, "should detect 12."
    assert hit.x0 < 80, f"number should be near left, got {hit}"
    out = strip_question_number(img)
    assert _region_is_white(out, (hit.x0, hit.y0, hit.x1 + 1, hit.y1 + 1)), "number region not blanked"


def test_skips_stem_only():
    img = _make_stem(qnum_text=None)
    hit = find_question_number(img)
    assert hit is None, f"stem-only crop should not blank, got {hit}"


def test_skips_indented_cluster():
    img = Image.new("RGB", (800, 80), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([300, 25, 320, 55], fill=(20, 20, 20))
    d.rectangle([330, 25, 700, 55], fill=(20, 20, 20))
    hit = find_question_number(img)
    assert hit is None, f"indented cluster is not a qnum, got {hit}"


def test_real_crop_sample():
    sample = ROOT / "scripts" / "qnum_out" / "before"
    files = sorted(sample.glob("*.png")) if sample.exists() else []
    if not files:
        print("skip real crop sample (no before/ dir)")
        return
    img = Image.open(files[0])
    out = strip_question_number(img)
    assert out.size == img.size
    assert out.mode == "RGB"


if __name__ == "__main__":
    test_detects_leading_number()
    test_skips_stem_only()
    test_skips_indented_cluster()
    test_real_crop_sample()
    print("all qnum tests passed")
