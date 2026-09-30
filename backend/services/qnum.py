"""Strip printed original question numbers from cropped question images.

Exam papers print a number (1 / 12 / 1.) at the left margin of each question
stem. The labeling app keeps those pixels inside the crop. This module detects
that left-margin cluster and paints it out so exports / web / R2 all show a
clean question body.

Detection (no OCR, Pillow only):
  - first text line of the crop
  - leftmost ink cluster near the margin, narrow (1–3 digits + punctuation)
  - followed by a wide gap before the question stem

Note: this is a one-shot cleaner for *original* page images. Do not run it on
already-wiped crops — the stem's first word can look like a number cluster.
Keep pipeline auto-strip off; call this explicitly when importing new papers.
"""
from __future__ import annotations

from dataclasses import dataclass

from PIL import Image, ImageDraw

DEFAULT_FILL = (255, 255, 255)
_INK_THRESH = 140


@dataclass(frozen=True)
class QnumHit:
    x0: int
    y0: int
    x1: int
    y1: int
    score: float
    reason: str


def _gray_bytes(crop: Image.Image) -> tuple[int, int, bytes]:
    gray = crop.convert("L")
    w, h = gray.size
    return w, h, gray.tobytes()


def _column_runs(w: int, h: int, data: bytes, y0: int, y1: int, min_gap: int = 1) -> list[tuple[int, int]]:
    """Inclusive (start, end) column runs of ink within rows [y0, y1]."""
    col_has = bytearray(w)
    for y in range(y0, y1 + 1):
        base = y * w
        for x in range(w):
            if data[base + x] < _INK_THRESH:
                col_has[x] = 1
    runs: list[tuple[int, int]] = []
    start = prev = None
    for x in range(w):
        if col_has[x]:
            if start is None:
                start = prev = x
            elif x - prev > min_gap:
                runs.append((start, prev))
                start = prev = x
            else:
                prev = x
    if start is not None:
        runs.append((start, prev))
    return runs


def _row_has_ink(w: int, data: bytes, y: int) -> bool:
    base = y * w
    for x in range(w):
        if data[base + x] < _INK_THRESH:
            return True
    return False


def find_question_number(
    crop: Image.Image,
    *,
    question_no: str | None = None,
) -> QnumHit | None:
    """Locate the printed question number in a cropped question image.

    ``question_no`` is the app's global id, NOT the printed paper number, so
    it is unused (kept for caller API symmetry).
    """
    del question_no
    w, h, data = _gray_bytes(crop)
    if w < 40 or h < 16:
        return None

    # First ink row
    first_ink_y = None
    for y in range(h):
        if _row_has_ink(w, data, y):
            first_ink_y = y
            break
    if first_ink_y is None:
        return None

    # Contiguous ink run starting at first_ink_y → estimate line height
    y = first_ink_y
    while y < h and _row_has_ink(w, data, y):
        y += 1
    first_run_h = max(y - first_ink_y, 14)
    line_h = int(first_run_h * 1.6)
    if first_run_h <= 18:
        line_h = max(line_h, 40)
    y0_line = first_ink_y
    y1_line = min(h - 1, first_ink_y + line_h - 1)

    runs = _column_runs(w, h, data, y0_line, y1_line, min_gap=1)
    if not runs:
        return None

    # Merge tight runs: multi-digit numbers and trailing '.' / ')'
    merged: list[list[int]] = []
    for s, e in runs:
        if merged and s - merged[-1][1] <= 12:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    cand_s, cand_e = merged[0]
    gap_after = (merged[1][0] - cand_e) if len(merged) > 1 else (w - cand_e)
    cluster_w = cand_e - cand_s + 1

    # 1–3 digits + optional '.' / ')' — keep tight so multi-letter stems fail.
    # Two-tier left gutter: some papers inset the number (x≈90), while
    # already-wiped stems also start at x≈100. Farther clusters must look
    # even more like a single digit and sit farther from the stem.
    near_lim = min(70, max(48, int(w * 0.035)))
    far_lim = min(160, max(100, int(w * 0.09)))
    max_num_w_near = min(85, max(50, int(w * 0.05)))
    max_num_w_far = 32

    if cand_s <= near_lim:
        max_num_w = max_num_w_near
        min_gap = 32
    elif cand_s <= far_lim:
        max_num_w = max_num_w_far
        min_gap = 48
    else:
        return None

    if cluster_w > max_num_w:
        return None

    # HARD RULE (unnumbered items must survive):
    # a real printed number is isolated — the gap to the stem is a margin
    # (empirically ≥38px, typically 46–70px). Word spaces are ~10–22px and
    # must never count. Prefer missing a number over eating the stem.
    if gap_after < min_gap:
        return None

    # Vertical span of the cluster
    y0 = y1 = None
    for y in range(y0_line, y1_line + 1):
        base = y * w
        for x in range(cand_s, cand_e + 1):
            if data[base + x] < _INK_THRESH:
                if y0 is None:
                    y0 = y
                y1 = y
                break
    if y0 is None:
        return None

    pad_x, pad_y = 2, 2
    x0 = max(0, cand_s - pad_x)
    x1 = min(w - 1, cand_e + pad_x)
    y0 = max(0, y0 - pad_y)
    y1 = min(h - 1, y1 + pad_y)

    # Swallow a tight trailing '.' or ')' just after the number
    if len(merged) > 1:
        s2, e2 = merged[1]
        if 3 <= (s2 - cand_e) <= 14 and (e2 - s2 + 1) <= 12:
            x1 = min(w - 1, e2 + pad_x)

    # Score is informational; min_score default 0.8 still applies.
    score = 1.0
    return QnumHit(x0, y0, x1, y1, score, f"w={cluster_w} gap={gap_after} left={cand_s}")


def strip_question_number(
    crop: Image.Image,
    *,
    question_no: str | None = None,
    fill: tuple[int, int, int] = DEFAULT_FILL,
    min_score: float = 0.8,
) -> Image.Image:
    """Return a copy of ``crop`` with the printed question number painted out.

    Safe to call on every box: continuation / stem-only boxes usually have no
    left-margin isolated cluster and are returned unchanged.
    """
    out, _ = strip_question_number_hit(
        crop, question_no=question_no, fill=fill, min_score=min_score
    )
    return out


def strip_question_number_hit(
    crop: Image.Image,
    *,
    question_no: str | None = None,
    fill: tuple[int, int, int] = DEFAULT_FILL,
    min_score: float = 0.8,
) -> tuple[Image.Image, QnumHit | None]:
    """Like :func:`strip_question_number` but also returns the detected hit."""
    if crop.mode not in ("RGB", "RGBA"):
        out = crop.convert("RGB")
    else:
        out = crop.copy()
    hit = find_question_number(out, question_no=question_no)
    if hit is None or hit.score < min_score:
        return out, None
    ImageDraw.Draw(out).rectangle([hit.x0, hit.y0, hit.x1, hit.y1], fill=fill)
    return out, hit
