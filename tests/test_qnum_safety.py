"""Adversarial tests: never blank text on questions that have no printed number.

This is the hard requirement — the bank mixes numbered and unnumbered items.
Prefer missing a number over eating the stem.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.qnum import find_question_number, strip_question_number


def _canvas(w=1900, h=120) -> Image.Image:
    """Realistic crop size (~question crop width) so thresholds match production."""
    return Image.new("RGB", (w, h), (255, 255, 255))


def _bar(d: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int):
    d.rectangle([x0, y0, x1, y1], fill=(20, 20, 20))


def _has_ink_in(img: Image.Image, box: tuple[int, int, int, int]) -> bool:
    region = img.crop(box).convert("L")
    return any(p < 200 for p in region.getdata())


def test_number_with_wide_gap__should_wipe():
    """Printed '12' + wide gap + stem (realistic 2k-wide crop)."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 40, 35, 58, 75)  # 1
    _bar(d, 68, 35, 86, 75)  # 2
    _bar(d, 94, 68, 102, 75)  # .
    _bar(d, 180, 35, 1400, 75)  # stem
    hit = find_question_number(img)
    assert hit is not None, f"should detect printed number, got {hit}"
    out = strip_question_number(img)
    assert not _has_ink_in(out, (hit.x0, hit.y0, hit.x1 + 1, hit.y1 + 1))
    assert _has_ink_in(out, (180, 35, 1400, 75)), "stem must not be wiped"


def test_unnumbered_stem_at_left_margin__must_not_wipe():
    """No printed number — stem starts at the left margin. This is the danger case."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 40, 35, 160, 75)  # first word ~120px
    _bar(d, 190, 35, 280, 75)
    _bar(d, 310, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"wide first word is not a qnum, got {hit}"


def test_unnumbered_single_letter_at_left__must_not_wipe():
    """'A particle moves...' — 'A' is narrow but the gap is only a word space."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 40, 35, 62, 75)  # 'A' ~22px
    _bar(d, 82, 35, 160, 75)  # gap ~20px then next word
    _bar(d, 190, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"letter + small word-gap is not a qnum, got {hit}"


def test_unnumbered_letter_with_20px_word_space__must_not_wipe():
    """Wider word space (~28px) still must not count as a number gap."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 40, 35, 62, 75)  # 'A'
    _bar(d, 90, 35, 400, 75)  # gap 28px — upper end of a word space
    _bar(d, 430, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"28px word-gap after a letter is not a qnum, got {hit}"
    out = strip_question_number(img)
    assert _has_ink_in(out, (40, 35, 62, 75)), "'A' must remain"
    assert _has_ink_in(out, (90, 35, 400, 75)), "stem must remain"


def test_two_digit_number_with_narrow_gap__prefer_miss():
    """Gap just under 32px is ambiguous — skip rather than risk the stem."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 40, 35, 58, 75)
    _bar(d, 68, 35, 86, 75)
    _bar(d, 118, 35, 900, 75)  # gap 32px from 86 → borderline; stem must stay
    hit = find_question_number(img)
    out = strip_question_number(img)
    assert _has_ink_in(out, (118, 35, 900, 75)), "stem must remain"


def test_unnumbered_indented_stem__must_not_wipe():
    """Stem only, starting mid-crop (continuation box)."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 220, 35, 320, 75)
    _bar(d, 360, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"indented cluster is not a qnum, got {hit}"


def test_stem_only_no_left_ink__must_not_wipe():
    """Just a bar as stem with empty left — nothing to do."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 120, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"no left cluster, got {hit}"


def test_already_wiped_number_gutter__must_not_wipe_stem():
    """After wiping the number, stem first word sits at ~100px — must not blank."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    # empty gutter (number already removed), stem starts at 100
    _bar(d, 100, 35, 220, 75)
    _bar(d, 260, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"stem after empty gutter is not a qnum, got {hit}"
    out = strip_question_number(img)
    assert _has_ink_in(out, (100, 35, 220, 75)), "stem must remain intact"


def test_figure_like_left_block__must_not_wipe():
    """Large dark block at left (figure / shading) is not a digit."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 40, 15, 200, 100)  # 160x85 block
    _bar(d, 260, 35, 1400, 75)
    hit = find_question_number(img)
    assert hit is None, f"large left block is not a qnum, got {hit}"


def test_real_backup_samples_still_detect():
    """If backup exists, originals should still hit; already-wiped current should not."""
    backup = ROOT / "backups" / "data_test_20260930_155628"
    db = ROOT / "data" / "app.db"
    if not backup.exists() or not db.exists():
        print("skip real backup sample (no backup/db)")
        return
    sys.path.insert(0, str(ROOT / "scripts"))
    import json

    from remove_qnum import iter_first_boxes

    from backend.services.qnum import find_question_number as fqn

    b_hit = n_hit = 0
    for qid, box, _ in iter_first_boxes(db):
        bbox = box["bbox"]
        if isinstance(bbox, str):
            bbox = json.loads(bbox)
        rel = Path(box["image_path"]).relative_to(ROOT / "data")
        bpath = backup / rel
        if bpath.exists():
            img = Image.open(bpath)
            w, h = img.size
            x0, y0, x1, y1 = bbox
            c = img.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
            if fqn(c) is not None:
                b_hit += 1
        cur = Image.open(box["image_path"])
        w, h = cur.size
        x0, y0, x1, y1 = bbox
        c2 = cur.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
        if fqn(c2) is not None:
            n_hit += 1
    print(f"backup hits={b_hit} current hits={n_hit}")
    assert n_hit == 0, f"already-wiped pages must not re-detect, got {n_hit}"


def test_inset_number_x89_must_wipe():
    """Some papers inset the printed number (x≈90) inside the crop."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 89, 35, 103, 75)  # single digit, empty gutter 0–88
    _bar(d, 173, 35, 1400, 75)  # gap ~69px to stem
    hit = find_question_number(img)
    assert hit is not None, f"inset number should be detected, got {hit}"
    out = strip_question_number(img)
    assert not _has_ink_in(out, (89, 35, 104, 76))
    assert _has_ink_in(out, (173, 35, 1400, 75)), "stem must remain"


def test_far_wide_cluster_must_not_wipe():
    """After a wipe, stem words sit at x≈100 and are wider than a digit."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    _bar(d, 105, 35, 152, 75)  # w=48 — too wide for far-tier digit
    _bar(d, 190, 35, 1400, 75)  # gap 38
    hit = find_question_number(img)
    assert hit is None, f"wide far cluster is not a qnum, got {hit}"


if __name__ == "__main__":
    test_number_with_wide_gap__should_wipe()
    test_inset_number_x89_must_wipe()
    test_far_wide_cluster_must_not_wipe()
    test_unnumbered_stem_at_left_margin__must_not_wipe()
    test_unnumbered_single_letter_at_left__must_not_wipe()
    test_unnumbered_letter_with_20px_word_space__must_not_wipe()
    test_two_digit_number_with_narrow_gap__prefer_miss()
    test_unnumbered_indented_stem__must_not_wipe()
    test_stem_only_no_left_ink__must_not_wipe()
    test_already_wiped_number_gutter__must_not_wipe_stem()
    test_figure_like_left_block__must_not_wipe()
    test_real_backup_samples_still_detect()
    print("all qnum safety tests passed")
