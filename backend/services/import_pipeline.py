"""
CIE import pipeline: download -> register -> render -> analyze -> ocr -> finalize.

Each stage is a small function that emits structured progress events:

    {item, stage, frac, status, error?}

``frac`` is the continuous 0..1 progress of the whole item, derived from the
independent stage weight table below. The router stays thin: it schedules jobs
and turns these events into the polled progress payload.
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.config import MAX_UPLOAD_BYTES, PDF_DIR, PAGE_DIR
from backend.database import Paper
from backend.services.paper_utils import (
    detect_is_answer_by_pdf_text,
    is_answer_filename,
    normalize_exam_code_for_type,
    render_pdf_to_images,
    stem_no_ext,
    try_pair_papers,
)

# ── Stage weights (sum = 1.0) ─────────────────────────────────────────────
# download 0.30 / register 0.05 / render 0.40 / analyze 0.10 / ocr 0.15
STAGE_WEIGHTS: dict[str, float] = {
    "download": 0.30,
    "register": 0.05,
    "render": 0.40,
    "analyze": 0.10,
    "ocr": 0.15,
}
STAGE_ORDER: tuple[str, ...] = ("download", "register", "render", "analyze", "ocr")

# Cumulative offsets: item frac when a stage starts.
STAGE_OFFSETS: dict[str, float] = {}
_acc = 0.0
for _stage in STAGE_ORDER:
    STAGE_OFFSETS[_stage] = _acc
    _acc += STAGE_WEIGHTS[_stage]
del _acc, _stage

# Serialize SQLite writes across parallel CIE workers (reads/renders stay parallel).
DB_WRITE_LOCK = threading.Lock()


def stage_frac(stage: str, local: float) -> float:
    """Map in-stage 0..1 progress to the continuous 0..1 item fraction."""
    weight = STAGE_WEIGHTS.get(stage, 0.0)
    offset = STAGE_OFFSETS.get(stage, 0.0)
    local = max(0.0, min(1.0, float(local)))
    return min(1.0, offset + weight * local)


def _err_text(e: BaseException) -> str:
    detail = getattr(e, "detail", None)
    return str(detail) if detail else str(e) or e.__class__.__name__


@dataclass
class ImportContext:
    """State for one imported PDF across pipeline stages."""

    url: str
    filename: str
    ocr_auto: bool = False
    ocr_min_height_px: int = 70
    ocr_y_padding_px: int = 12
    # paths
    tmp_path: Optional[Path] = None
    pdf_path: Optional[Path] = None
    pages_dir: Optional[Path] = None
    paper_id: Optional[int] = None
    page_count: int = 0
    # OCR outputs
    ocr_questions: list = field(default_factory=list)
    ocr_boxes: list = field(default_factory=list)
    ocr_warn: Optional[str] = None
    # event sink: receives {item, stage, frac, status, error?}
    on_event: Optional[Callable[[dict], None]] = None

    @property
    def item(self) -> str:
        return self.filename or self.url

    def emit(
        self,
        stage: str,
        status: str,
        local: float = 0.0,
        error: Optional[str] = None,
    ) -> None:
        if not self.on_event:
            return
        event: dict[str, Any] = {
            "item": self.item,
            "stage": stage,
            "frac": stage_frac(stage, local),
            "status": status,
        }
        if error is not None:
            event["error"] = error
        try:
            self.on_event(event)
        except Exception:
            pass


def _open_url(url: str, timeout: int = 60):
    """Thin urllib wrapper so tests can mock network access."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    )
    return urllib.request.urlopen(req, timeout=timeout)


# ── Stages ────────────────────────────────────────────────────────────────


def validate_target(ctx: ImportContext, db: Session) -> None:
    """URL/filename checks and duplicate guard. Runs before any download."""
    url = (ctx.url or "").strip()
    ctx.url = url
    if not url:
        raise HTTPException(status_code=400, detail="URL cannot be empty")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL format")

    filename = (ctx.filename or "").strip()
    ctx.filename = filename
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="URL must point to a PDF file")

    with DB_WRITE_LOCK:
        existing = db.query(Paper).filter(Paper.filename == filename).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"文件 '{filename}' 已导入过 (Paper ID: {existing.id})，请勿重复导入",
            )


def download_pdf(ctx: ImportContext) -> None:
    """Stream the remote PDF into a temp file. Emits download progress."""
    ctx.emit("download", "start", 0.0)
    try:
        with _open_url(ctx.url) as response:
            content_type = response.headers.get("Content-Type", "")
            if "pdf" not in content_type.lower() and not ctx.url.lower().endswith(".pdf"):
                raise HTTPException(status_code=400, detail="URL does not point to a PDF file")

            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"File too large (max {MAX_UPLOAD_BYTES // 1024 // 1024}MB)",
                )

            with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
                total_size = 0
                chunk_size = 64 * 1024
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    total_size += len(chunk)
                    if total_size > MAX_UPLOAD_BYTES:
                        tmp_file.close()
                        Path(tmp_file.name).unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=400,
                            detail=f"File too large (max {MAX_UPLOAD_BYTES // 1024 // 1024}MB)",
                        )
                    tmp_file.write(chunk)
                    if content_length:
                        try:
                            ratio = min(0.95, total_size / max(1, int(content_length)))
                            ctx.emit("download", "progress", ratio)
                        except Exception:
                            pass
                ctx.tmp_path = Path(tmp_file.name)
    except HTTPException:
        raise
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        raise HTTPException(status_code=400, detail=f"Failed to download PDF: {_err_text(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {_err_text(e)}")

    ctx.emit("download", "done", 1.0)


def register_paper(ctx: ImportContext, db: Session) -> Paper:
    """Create the Paper row and move the temp file into PDF_DIR."""
    ctx.emit("register", "start", 0.0)
    exam_code = stem_no_ext(ctx.filename)
    try:
        with DB_WRITE_LOCK:
            paper = Paper(
                filename=ctx.filename,
                exam_code=exam_code,
                is_answer=is_answer_filename(ctx.filename),
            )
            db.add(paper)
            db.commit()
            db.refresh(paper)

        ctx.paper_id = int(paper.id)
        ctx.pdf_path = PDF_DIR / f"paper_{paper.id}.pdf"
        shutil.move(str(ctx.tmp_path), str(ctx.pdf_path))
        ctx.tmp_path = None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {_err_text(e)}")

    ctx.emit("register", "done", 1.0)
    return paper


def render_pages(ctx: ImportContext) -> int:
    """Render PDF pages to WebP images. Emits per-page render progress."""
    ctx.emit("render", "start", 0.0)
    ctx.pages_dir = PAGE_DIR / f"paper_{ctx.paper_id}"

    def on_page(done: int, total: int) -> None:
        ratio = (done / total) if total else 1.0
        ctx.emit("render", "progress", ratio)

    try:
        rendered = render_pdf_to_images(ctx.pdf_path, ctx.pages_dir, on_progress=on_page)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {_err_text(e)}")

    ctx.page_count = int(rendered)
    ctx.emit("render", "done", 1.0)
    return ctx.page_count


def analyze_meta(ctx: ImportContext, db: Session) -> None:
    """Persist paths/page_count, detect QP/MS, and pair qp<->ms papers."""
    ctx.emit("analyze", "start", 0.0)
    try:
        with DB_WRITE_LOCK:
            paper = db.query(Paper).filter(Paper.id == ctx.paper_id).first()
            if paper is None:
                raise HTTPException(status_code=500, detail="Import failed: paper row missing")

            paper.pdf_path = str(ctx.pdf_path)
            paper.pages_dir = str(ctx.pages_dir)
            paper.page_count = int(ctx.page_count)

            detected = detect_is_answer_by_pdf_text(ctx.pdf_path)
            if detected is not None and bool(paper.is_answer) != bool(detected):
                paper.is_answer = bool(detected)
                paper.exam_code = normalize_exam_code_for_type(paper.exam_code, bool(detected))

            db.add(paper)
            db.commit()
            try_pair_papers(db, paper)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {_err_text(e)}")

    ctx.emit("analyze", "done", 1.0)


def run_ocr(ctx: ImportContext, db: Session) -> None:
    """Optional question-box suggestion. Skips answers and disabled runs."""
    if not ctx.ocr_auto:
        ctx.emit("ocr", "skip", 1.0)
        return

    is_answer = False
    with DB_WRITE_LOCK:
        paper = db.query(Paper).filter(Paper.id == ctx.paper_id).first()
        is_answer = bool(paper.is_answer) if paper else False

    if is_answer:
        ctx.emit("ocr", "skip", 1.0)
        return

    ctx.emit("ocr", "start", 0.0)
    try:
        from backend.auto_suggest import suggest_question_boxes_from_pdf
        from backend.services.paper_utils import auto_suggest_allowed_by_filename

        allowed, reason = auto_suggest_allowed_by_filename(ctx.filename)
        if not allowed:
            ctx.ocr_warn = reason
        else:
            ctx.ocr_questions, ctx.ocr_warn = suggest_question_boxes_from_pdf(
                ctx.pdf_path,
                int(ctx.page_count or 0),
                min_height_px=int(ctx.ocr_min_height_px or 0),
                y_padding_px=int(ctx.ocr_y_padding_px or 0),
            )
        ctx.emit("ocr", "progress", 0.7)

        try:
            for q in ctx.ocr_questions:
                label = q.get("label")
                for b in q.get("boxes") or []:
                    d = {"page": b.get("page"), "bbox": b.get("bbox")}
                    if label is not None:
                        d["label"] = label
                    ctx.ocr_boxes.append(d)
        except Exception:
            pass
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {_err_text(e)}")

    ctx.emit("ocr", "done", 1.0)


def finalize(ctx: ImportContext, db: Session) -> dict:
    """Assemble the import result and mark the item complete."""
    paper = None
    with DB_WRITE_LOCK:
        paper = db.query(Paper).filter(Paper.id == ctx.paper_id).first()

    result = {
        "paper": {
            "id": ctx.paper_id,
            "filename": ctx.filename,
            "exam_code": paper.exam_code if paper else stem_no_ext(ctx.filename),
            "is_answer": bool(paper.is_answer) if paper else False,
            "page_count": ctx.page_count,
            "paired_paper_id": paper.paired_paper_id if paper else None,
        },
        "ocr_questions": ctx.ocr_questions,
        "ocr_boxes": ctx.ocr_boxes,
        "ocr_warn": ctx.ocr_warn,
    }
    ctx.emit("done", "done", 1.0)
    return result


def rollback_import(ctx: ImportContext, db: Session) -> None:
    """Remove every artifact of a failed item (tmp/pdf/pages/paper row)."""
    try:
        if ctx.tmp_path:
            Path(ctx.tmp_path).unlink(missing_ok=True)
            ctx.tmp_path = None
    except Exception:
        pass

    if ctx.paper_id is None and ctx.pdf_path is None and ctx.pages_dir is None:
        return

    try:
        with DB_WRITE_LOCK:
            if ctx.pdf_path:
                Path(ctx.pdf_path).unlink(missing_ok=True)
            if ctx.pages_dir:
                pages = Path(ctx.pages_dir)
                if pages.exists():
                    shutil.rmtree(pages, ignore_errors=True)
            if ctx.paper_id is not None:
                paper = db.query(Paper).filter(Paper.id == ctx.paper_id).first()
                if paper is not None:
                    db.delete(paper)
                    db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def run_import(ctx: ImportContext, db: Session) -> dict:
    """Run the full stage sequence. On any failure the whole item is rolled back."""
    try:
        validate_target(ctx, db)
        download_pdf(ctx)
        register_paper(ctx, db)
        render_pages(ctx)
        analyze_meta(ctx, db)
        run_ocr(ctx, db)
        return finalize(ctx, db)
    except Exception:
        rollback_import(ctx, db)
        raise
