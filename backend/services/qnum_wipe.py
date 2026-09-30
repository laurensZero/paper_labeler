"""One-shot wipe of printed question numbers from source page images.

Invoked from Settings → 数据维护 (manual only; not hooked into export/sync).
Detection lives in ``backend.services.qnum``. Page images are modified in
place — take a backup first.

Papers already processed are recorded on ``papers.qnum_stripped_at`` and
skipped on later runs. New/changed boxes should clear that flag (see
``mark_paper_qnum_dirty``).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw
from sqlalchemy.orm import Session

from backend.database import Paper, Question, QuestionBox
from backend.services.qnum import find_question_number


def _bbox_xyxy(bbox) -> tuple[float, float, float, float]:
    vals = list(bbox or [])
    if len(vals) != 4:
        raise ValueError("bbox must have 4 numbers")
    x0, y0, x1, y1 = (float(v) for v in vals)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def mark_paper_qnum_dirty(db: Session, paper_id: int | None) -> None:
    """Clear the stripped flag when this paper's boxes change.

    Call after creating/replacing question boxes so a later strip pass
    re-examines the paper.
    """
    if not paper_id:
        return
    paper = db.query(Paper).filter(Paper.id == int(paper_id)).first()
    if paper is not None and paper.qnum_stripped_at is not None:
        paper.qnum_stripped_at = None
        db.add(paper)


def _first_box_per_question(db: Session) -> list[tuple[Question, QuestionBox]]:
    rows = (
        db.query(Question, QuestionBox)
        .join(QuestionBox, QuestionBox.question_id == Question.id)
        .order_by(Question.id.asc(), QuestionBox.page.asc(), QuestionBox.id.asc())
        .all()
    )
    by_q: dict[int, list[tuple[Question, QuestionBox]]] = defaultdict(list)
    for q, b in rows:
        by_q[int(q.id)].append((q, b))

    out: list[tuple[Question, QuestionBox]] = []
    for qid in sorted(by_q):
        # top-most box on the earliest page carries the printed qnum
        items = by_q[qid]
        items.sort(key=lambda pair: (int(pair[1].page), float(_bbox_xyxy(pair[1].bbox)[1])))
        out.append(items[0])
    return out


def wipe_printed_qnums(db: Session, *, dry_run: bool = True) -> dict:
    """Detect printed qnums on each question's first box and white them out.

    Papers with ``qnum_stripped_at`` set are skipped entirely.
    Returns a report dict. When ``dry_run`` is True, pages/DB are not written.
    """
    report = {
        "dry_run": bool(dry_run),
        "questions": 0,
        "hit": 0,
        "miss": 0,
        "pages_touched": 0,
        "miss_question_nos": [],
        "papers_total": 0,
        "papers_skipped": 0,
        "papers_processed": 0,
        "papers_skipped_ids": [],
        "papers_marked": 0,
    }

    papers = {int(p.id): p for p in db.query(Paper).all()}
    report["papers_total"] = len(papers)

    # paper_id -> questions' first boxes
    page_ops: dict[str, list[tuple[int, str, tuple[int, int, int, int]]]] = defaultdict(list)
    papers_in_play: set[int] = set()

    for q, box in _first_box_per_question(db):
        paper_id = int(getattr(q, "paper_id", 0) or getattr(box, "paper_id", 0) or 0)
        paper = papers.get(paper_id)
        if paper is not None and paper.qnum_stripped_at is not None:
            report["papers_skipped"] += 1
            report["papers_skipped_ids"].append(paper_id)
            continue

        papers_in_play.add(paper_id)
        report["questions"] += 1
        src = Path(str(box.image_path or ""))
        if not src.exists():
            report["miss"] += 1
            report["miss_question_nos"].append(str(q.question_no or q.id))
            continue

        bbox = _bbox_xyxy(box.bbox)
        with Image.open(src) as img:
            img = img.convert("RGB")
            w, h = img.size
            x0, y0, x1, y1 = bbox
            px0, py0 = int(x0 * w), int(y0 * h)
            px1, py1 = int(x1 * w), int(y1 * h)
            px0 = max(0, min(w - 1, px0))
            py0 = max(0, min(h - 1, py0))
            px1 = max(px0 + 1, min(w, px1))
            py1 = max(py0 + 1, min(h, py1))
            crop = img.crop((px0, py0, px1, py1))

        hit = find_question_number(crop)
        if hit is None:
            report["miss"] += 1
            report["miss_question_nos"].append(str(q.question_no or q.id))
            continue

        report["hit"] += 1
        page_box = (px0 + hit.x0, py0 + hit.y0, px0 + hit.x1, py0 + hit.y1)
        page_ops[str(src)].append((int(q.id), str(q.question_no or ""), page_box))

    # papers_skipped counted per-question above; dedupe to paper count
    skipped_unique = set(report["papers_skipped_ids"])
    report["papers_skipped"] = len(skipped_unique)
    report["papers_skipped_ids"] = sorted(skipped_unique)
    report["papers_processed"] = len(papers_in_play)
    report["pages_touched"] = len(page_ops)

    if dry_run:
        return report

    for path_str, ops in page_ops.items():
        src = Path(path_str)
        with Image.open(src) as img:
            out = img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img.copy()
            draw = ImageDraw.Draw(out)
            for _qid, _qno, page_box in ops:
                draw.rectangle(list(page_box), fill=(255, 255, 255))
            if src.suffix.lower() == ".webp":
                out.save(src, "WEBP", quality=90, method=3)
            else:
                out.save(src)

    # Only mark papers where we actually painted something. hit=0 means
    # "nothing found this pass" (layout not recognized / no numbers) — leave
    # unmarked so a later run can retry. Boxes changing also clears the flag.
    now = datetime.utcnow()
    if report["hit"] > 0:
        for pid in papers_in_play:
            paper = papers.get(pid) or db.query(Paper).filter(Paper.id == pid).first()
            if paper is not None:
                paper.qnum_stripped_at = now
                db.add(paper)
        db.commit()
        report["papers_marked"] = len(papers_in_play)
    else:
        report["papers_marked"] = 0

    return report
