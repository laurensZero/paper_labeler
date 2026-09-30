"""Batch strip printed question numbers from question crops (CLI + library).

Uses ``backend.services.qnum`` for detection/blanking. Walks the local SQLite
question bank, takes each question's first (top-most) box, and writes
before/after crops for QA plus a JSON report.

Usage:
  python scripts/remove_qnum.py --limit 20
  python scripts/remove_qnum.py --report scripts/qnum_out/report.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.qnum import strip_question_number_hit  # noqa: E402


def _bbox_y0(box) -> float:
    bbox = box["bbox"]
    if isinstance(bbox, str):
        bbox = json.loads(bbox)
    return float(bbox[1])


def iter_first_boxes(db_path: Path):
    """Yield (qid, first_box_row, all_box_rows) for each question.

    First box = earliest page, then top-most bbox (that's where the printed
    question number lives).
    """
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute(
        """
        SELECT q.id AS qid, q.question_no, b.id AS bid, b.page, b.bbox, b.image_path
        FROM questions q
        JOIN question_boxes b ON b.question_id = q.id
        ORDER BY q.id, b.page, b.id
        """
    )
    rows = cur.fetchall()
    by_q: dict[int, list] = {}
    for r in rows:
        by_q.setdefault(int(r["qid"]), []).append(r)
    for qid, boxes in by_q.items():
        boxes_sorted = sorted(boxes, key=lambda r: (int(r["page"]), _bbox_y0(r)))
        yield qid, boxes_sorted[0], boxes_sorted
    con.close()


def crop_from_box(box) -> Image.Image:
    ipath = Path(box["image_path"])
    bbox = box["bbox"]
    if isinstance(bbox, str):
        bbox = json.loads(bbox)
    img = Image.open(ipath)
    w, h = img.size
    x0, y0, x1, y1 = bbox
    return img.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))


def process_test_bank(
    db_path: Path,
    out_dir: Path,
    *,
    limit: int | None = None,
    write_after: bool = True,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    before_dir = out_dir / "before"
    after_dir = out_dir / "after"
    before_dir.mkdir(exist_ok=True)
    after_dir.mkdir(exist_ok=True)

    stats: dict = {"total": 0, "hit": 0, "miss": 0, "details": []}
    for i, (qid, box, _all) in enumerate(iter_first_boxes(db_path)):
        if limit is not None and i >= limit:
            break
        stats["total"] += 1
        crop = crop_from_box(box)
        out, hit = strip_question_number_hit(crop, question_no=str(box["question_no"] or ""))
        name = f"q{qid}_no{box['question_no']}_p{box['page']}_b{box['bid']}.png"
        crop.save(before_dir / name)
        if write_after:
            out.save(after_dir / name)
        rec = {
            "qid": qid,
            "question_no": box["question_no"],
            "page": box["page"],
            "box_id": box["bid"],
            "hit": hit.__dict__ if hit else None,
            "crop_size": list(crop.size),
        }
        stats["details"].append(rec)
        if hit:
            stats["hit"] += 1
            print(f"[{i+1}] q{qid} no={box['question_no']} hit={hit}")
        else:
            stats["miss"] += 1
            print(f"[{i+1}] q{qid} no={box['question_no']} MISS crop={crop.size}")
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description="Remove printed question numbers from question crops")
    ap.add_argument("--db", default=str(ROOT / "data" / "app.db"))
    ap.add_argument("--out", default=str(ROOT / "scripts" / "qnum_out"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--report", default=None, help="write JSON stats to this path")
    args = ap.parse_args()

    stats = process_test_bank(Path(args.db), Path(args.out), limit=args.limit)
    print(f"\nDone. total={stats['total']} hit={stats['hit']} miss={stats['miss']}")
    if args.report:
        Path(args.report).write_text(
            json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print("report ->", args.report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
