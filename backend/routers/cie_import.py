"""
CIE Paper Import from https://cie.fraft.cn/
"""
from __future__ import annotations

import re
import shutil
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from datetime import datetime
from typing import Callable, Optional, List
import tempfile
import urllib.request
import urllib.parse
import urllib.error

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend.database import Paper, SessionLocal
from backend.dependencies import get_db
from backend.config import PDF_DIR, PAGE_DIR, MAX_UPLOAD_BYTES, DATA_DIR
from backend.services.paper_utils import (
    render_pdf_to_images,
    stem_no_ext,
    is_answer_filename,
    detect_is_answer_by_pdf_text,
    normalize_exam_code_for_type,
    try_pair_papers,
)

router = APIRouter(prefix="/cie_import", tags=["cie_import"])

# Serialize SQLite writes across parallel CIE workers (reads/renders stay parallel)
_cie_db_lock = threading.Lock()


def _err_text(e: BaseException) -> str:
    detail = getattr(e, "detail", None)
    return str(detail) if detail else str(e) or e.__class__.__name__


class ImportRequest(BaseModel):
    url: str
    ocr_auto: bool = False
    ocr_min_height_px: int = 70
    ocr_y_padding_px: int = 12


class ImportJobItem(BaseModel):
    url: str
    filename: Optional[str] = None


class ImportJobRequest(BaseModel):
    items: List[ImportJobItem]
    ocr_auto: bool = False
    ocr_min_height_px: int = 70
    ocr_y_padding_px: int = 12


class BatchImportRequest(BaseModel):
    urls: List[str]
    ocr_auto: bool = False
    ocr_min_height_px: int = 70
    ocr_y_padding_px: int = 12


class FetchPapersRequest(BaseModel):
    subject: str
    year: str
    season: str  # Mar, Jun, Nov


# ── In-memory import jobs (progress polled by frontend) ──────────────────
_cie_jobs: dict[str, dict] = {}
_cie_jobs_lock = threading.Lock()
_cie_job_queue: list[str] = []
_cie_worker_started = False


def _set_job(job_id: str, **fields) -> None:
    with _cie_jobs_lock:
        job = _cie_jobs.get(job_id)
        if not job:
            return
        job.update(fields)


def _get_job(job_id: str) -> Optional[dict]:
    with _cie_jobs_lock:
        job = _cie_jobs.get(job_id)
        return dict(job) if job else None


def _ensure_cie_worker() -> None:
    global _cie_worker_started
    if _cie_worker_started:
        return
    with _cie_jobs_lock:
        if _cie_worker_started:
            return
        t = threading.Thread(target=_cie_worker_loop, daemon=True)
        t.start()
        _cie_worker_started = True


def _cie_worker_loop() -> None:
    while True:
        job_id = None
        with _cie_jobs_lock:
            if _cie_job_queue:
                job_id = _cie_job_queue.pop(0)
        if not job_id:
            time.sleep(0.08)
            continue
        job = _get_job(job_id)
        if not job or job.get("status") == "cancelled":
            continue
        _run_cie_import_job(job_id)


def _run_cie_import_job(job_id: str) -> None:
    """Process papers with a small worker pool so download and render overlap."""
    job = _get_job(job_id)
    if not job:
        return
    items = job.get("items") or []
    total = len(items)
    ocr_auto = bool(job.get("ocr_auto"))
    ocr_min_height_px = int(job.get("ocr_min_height_px") or 70)
    ocr_y_padding_px = int(job.get("ocr_y_padding_px") or 12)

    _set_job(
        job_id,
        status="processing",
        total=total,
        current=0,
        percent=0.0,
        success=0,
        failed=0,
        msg="",
        active=[],
    )

    item_frac = [0.0] * total
    item_step = ["queued"] * total
    item_name = [
        (it.get("filename") or extract_filename_from_url(it.get("url") or "")) for it in items
    ]
    progress_lock = threading.Lock()
    results: list[dict] = []
    results_lock = threading.Lock()

    def publish() -> None:
        with progress_lock:
            done = sum(1 for f in item_frac if f >= 1.0)
            active = [
                {"index": i, "filename": item_name[i], "step": item_step[i]}
                for i in range(total)
                if 0.0 < item_frac[i] < 1.0
            ]
            percent = round((sum(item_frac) / total) * 100.0, 1) if total else 100.0
            filename = active[0]["filename"] if active else (item_name[-1] if item_name else "")
            step = active[0]["step"] if active else ("done" if done >= total else "queued")
            _set_job(
                job_id,
                current=done,
                filename=filename,
                step=step,
                percent=percent,
                active=active[:6],
                msg=f"{done}/{total}" + (f" · {len(active)} 份并行中" if active else ""),
            )

    def work_one(idx: int) -> dict:
        item = items[idx]
        filename = item_name[idx]

        def on_step(step: str, step_progress: float = 0.0) -> None:
            with progress_lock:
                item_step[idx] = step
                if step == "download":
                    item_frac[idx] = 0.30 * max(0.0, min(1.0, step_progress))
                elif step == "save":
                    item_frac[idx] = 0.35
                elif step == "render":
                    item_frac[idx] = 0.35 + 0.40 * max(0.0, min(1.0, step_progress))
                elif step == "analyze":
                    item_frac[idx] = 0.85
                elif step == "ocr":
                    item_frac[idx] = 0.85 + 0.15 * max(0.0, min(1.0, step_progress))
                elif step == "done":
                    item_frac[idx] = 1.0
            publish()

        try:
            db = SessionLocal()
            try:
                result = _import_pdf_from_url(
                    url=item.get("url") or "",
                    filename_hint=filename,
                    ocr_auto=ocr_auto,
                    ocr_min_height_px=ocr_min_height_px,
                    ocr_y_padding_px=ocr_y_padding_px,
                    db=db,
                    on_step=on_step,
                )
            finally:
                db.close()
            with progress_lock:
                item_frac[idx] = 1.0
                item_step[idx] = "done"
            publish()
            return {
                "filename": filename,
                "ok": True,
                "paper": result.get("paper"),
                "ocr_questions": result.get("ocr_questions") or [],
                "ocr_boxes": result.get("ocr_boxes") or [],
                "ocr_warn": result.get("ocr_warn"),
            }
        except Exception as e:
            with progress_lock:
                item_frac[idx] = 1.0
                item_step[idx] = "error"
            publish()
            return {"filename": filename, "ok": False, "error": _err_text(e)}

    # 4 workers: QP/MS and downloads/renders overlap on low-end machines too
    workers = min(4, max(1, total))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work_one, i) for i in range(total)]
        for fut in as_completed(futures):
            r = fut.result()
            with results_lock:
                results.append(r)

    success = sum(1 for r in results if r.get("ok"))
    failed = total - success
    _set_job(
        job_id,
        status="done",
        step="done",
        current=total,
        percent=100.0,
        success=success,
        failed=failed,
        msg=f"导入完成：成功 {success}，失败 {failed}",
        results=results,
        active=[],
    )


def _subject_combo_cache_path() -> Path:
    return DATA_DIR / ".cie_subject_combo.json"


def _load_subject_combo_cache():
    try:
        p = _subject_combo_cache_path()
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, list) and data:
                return data
    except Exception:
        pass
    return None


def _save_subject_combo_cache(data) -> None:
    try:
        p = _subject_combo_cache_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _clean_subject_text(raw: str, value: str) -> str:
    # Strip ad suffix like " - 🔥视频课速通🔥", keep "9231 - 高等数学 (AS/A2)"
    cleaned = re.sub(r"\s*-\s*\U0001F525.*$", "", raw).strip()
    if not cleaned or cleaned == (value or "").strip():
        before_ad = re.split(r"\s*-\s*\U0001F525", raw, maxsplit=1)[0].strip()
        cleaned = before_ad or (value or "")
    return cleaned


@router.get("/subject_combo")
def get_subject_combo():
    """Get subject combo list from cie.fraft.cn (proxy to avoid CORS).

    Falls back to a disk cache so a flaky remote doesn't break the UI.
    """
    try:
        req = urllib.request.Request(
            "https://cie.fraft.cn/obj/Common/Subject/combo",
            method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json",
            },
        )

        with urllib.request.urlopen(req, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))

        if isinstance(result, list) and result:
            for item in result:
                if "text" in item and isinstance(item["text"], str):
                    item["text"] = _clean_subject_text(item["text"], str(item.get("value") or ""))
            _save_subject_combo_cache(result)
            return result

        cached = _load_subject_combo_cache()
        if cached is not None:
            return cached
        raise HTTPException(status_code=502, detail="subject combo returned unexpected payload")

    except HTTPException:
        raise
    except Exception:
        cached = _load_subject_combo_cache()
        if cached is not None:
            return cached
        raise HTTPException(status_code=500, detail="Failed to fetch subject combo")


@router.post("/fetch_papers")
def fetch_papers(request: FetchPapersRequest):
    """Fetch paper list from cie.fraft.cn."""
    try:
        data = urllib.parse.urlencode(
            {
                "subject": request.subject,
                "year": request.year,
                "season": request.season,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            "https://cie.fraft.cn/obj/Common/Fetch/renum",
            data=data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json",
            },
        )

        with urllib.request.urlopen(req, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))

        papers = []
        if "rows" in result:
            for row in result["rows"]:
                filename = row.get("file", "")
                if filename.endswith(".pdf"):
                    papers.append(
                        {
                            "filename": filename,
                            "url": f"https://cie.fraft.cn/obj/Common/Fetch/redir/{filename}",
                        }
                    )

        return {"success": True, "total": len(papers), "papers": papers}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch papers: {_err_text(e)}")


def extract_filename_from_url(url: str) -> str:
    """Extract filename from CIE URL."""
    match = re.search(r"/([^/]+\.pdf)$", url, re.IGNORECASE)
    if match:
        return match.group(1)
    return f"imported_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"


def _import_pdf_from_url(
    *,
    url: str,
    filename_hint: Optional[str],
    ocr_auto: bool,
    ocr_min_height_px: int,
    ocr_y_padding_px: int,
    db: Session,
    on_step: Optional[Callable[[str, float], None]] = None,
) -> dict:
    """Download + import one PDF. Raises on failure. Calls on_step(step, 0..1)."""

    def step(name: str, progress: float = 0.0) -> None:
        if on_step:
            on_step(name, progress)

    url = (url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL cannot be empty")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL format")

    filename = filename_hint or extract_filename_from_url(url)
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="URL must point to a PDF file")

    with _cie_db_lock:
        existing = db.query(Paper).filter(Paper.filename == filename).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"文件 '{filename}' 已导入过 (Paper ID: {existing.id})，请勿重复导入",
            )

    step("download", 0.0)
    tmp_path: Optional[Path] = None
    paper: Optional[Paper] = None

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )

        with urllib.request.urlopen(req, timeout=60) as response:
            content_type = response.headers.get("Content-Type", "")
            if "pdf" not in content_type.lower() and not url.lower().endswith(".pdf"):
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
                            step("download", min(0.95, total_size / max(1, int(content_length))))
                        except Exception:
                            pass
                tmp_path = Path(tmp_file.name)
        step("download", 1.0)

        step("save", 0.0)
        exam_code = stem_no_ext(filename)
        with _cie_db_lock:
            paper = Paper(
                filename=filename,
                exam_code=exam_code,
                is_answer=is_answer_filename(filename),
            )
            db.add(paper)
            db.commit()
            db.refresh(paper)

        pdf_path = PDF_DIR / f"paper_{paper.id}.pdf"
        shutil.move(str(tmp_path), str(pdf_path))
        tmp_path = None
        step("save", 1.0)

        step("render", 0.0)
        page_output_dir = PAGE_DIR / f"paper_{paper.id}"
        rendered_pages = render_pdf_to_images(pdf_path, page_output_dir)
        step("render", 1.0)

        step("analyze", 0.0)
        with _cie_db_lock:
            paper.pdf_path = str(pdf_path)
            paper.pages_dir = str(page_output_dir)
            paper.page_count = int(rendered_pages)

            detected = detect_is_answer_by_pdf_text(pdf_path)
            if detected is not None and bool(paper.is_answer) != bool(detected):
                paper.is_answer = bool(detected)
                paper.exam_code = normalize_exam_code_for_type(paper.exam_code, bool(detected))

            db.add(paper)
            db.commit()
            try_pair_papers(db, paper)
        step("analyze", 1.0)

        ocr_questions = []
        ocr_boxes = []
        ocr_warn = None

        if ocr_auto and not bool(paper.is_answer):
            step("ocr", 0.0)
            from backend.auto_suggest import suggest_question_boxes_from_pdf
            from backend.services.paper_utils import auto_suggest_allowed_by_filename

            allowed, reason = auto_suggest_allowed_by_filename(filename)
            if not allowed:
                ocr_warn = reason
            else:
                ocr_questions, ocr_warn = suggest_question_boxes_from_pdf(
                    pdf_path,
                    int(paper.page_count or 0),
                    min_height_px=int(ocr_min_height_px or 0),
                    y_padding_px=int(ocr_y_padding_px or 0),
                )

            try:
                for q in ocr_questions:
                    label = q.get("label")
                    for b in q.get("boxes") or []:
                        d = {"page": b.get("page"), "bbox": b.get("bbox")}
                        if label is not None:
                            d["label"] = label
                        ocr_boxes.append(d)
            except Exception:
                pass
            step("ocr", 1.0)
        else:
            step("ocr", 1.0)

        step("done", 1.0)
        return {
            "paper": {
                "id": paper.id,
                "filename": paper.filename,
                "exam_code": paper.exam_code,
                "is_answer": paper.is_answer,
                "page_count": paper.page_count,
                "paired_paper_id": paper.paired_paper_id,
            },
            "ocr_questions": ocr_questions,
            "ocr_boxes": ocr_boxes,
            "ocr_warn": ocr_warn,
        }

    except HTTPException:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)
        if paper is not None and paper.id:
            _cleanup_partial_paper(db, paper)
        raise
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)
        if paper is not None and paper.id:
            _cleanup_partial_paper(db, paper)
        raise HTTPException(status_code=400, detail=f"Failed to download PDF: {_err_text(e)}")
    except Exception as e:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)
        if paper is not None and paper.id:
            _cleanup_partial_paper(db, paper)
        raise HTTPException(status_code=500, detail=f"Import failed: {_err_text(e)}")


def _cleanup_partial_paper(db: Session, paper: Paper) -> None:
    try:
        with _cie_db_lock:
            pdf_path = PDF_DIR / f"paper_{paper.id}.pdf"
            page_dir = PAGE_DIR / f"paper_{paper.id}"
            pdf_path.unlink(missing_ok=True)
            if page_dir.exists():
                shutil.rmtree(page_dir, ignore_errors=True)
            db.delete(paper)
            db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


@router.post("/from_url")
async def import_from_url(request: ImportRequest, db: Session = Depends(get_db)):
    """Import paper from CIE website URL (single request, no progress polling)."""
    return _import_pdf_from_url(
        url=request.url,
        filename_hint=None,
        ocr_auto=request.ocr_auto,
        ocr_min_height_px=request.ocr_min_height_px,
        ocr_y_padding_px=request.ocr_y_padding_px,
        db=db,
        on_step=None,
    )


@router.post("/import_job")
def create_import_job(request: ImportJobRequest):
    """Start a batch CIE import job. Poll GET /cie_import/import_job/{id} for progress."""
    items = []
    for it in request.items:
        url = (it.url or "").strip()
        if not url:
            continue
        filename = (it.filename or "").strip() or extract_filename_from_url(url)
        items.append({"url": url, "filename": filename})
    if not items:
        raise HTTPException(status_code=400, detail="No valid items to import")

    job_id = uuid.uuid4().hex[:12]
    with _cie_jobs_lock:
        _cie_jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "total": len(items),
            "current": 0,
            "filename": "",
            "step": "download",
            "percent": 0.0,
            "success": 0,
            "failed": 0,
            "msg": "",
            "items": items,
            "ocr_auto": request.ocr_auto,
            "ocr_min_height_px": request.ocr_min_height_px,
            "ocr_y_padding_px": request.ocr_y_padding_px,
            "results": [],
            "created_at": time.time(),
        }
        _cie_job_queue.append(job_id)
    _ensure_cie_worker()
    return {"job_id": job_id, "total": len(items)}


@router.get("/import_job/{job_id}")
def get_import_job(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "id": job.get("id"),
        "status": job.get("status"),
        "total": job.get("total"),
        "current": job.get("current"),
        "filename": job.get("filename"),
        "step": job.get("step"),
        "percent": job.get("percent"),
        "success": job.get("success"),
        "failed": job.get("failed"),
        "msg": job.get("msg"),
        "active": job.get("active") or [],
        "results": job.get("results") or [],
    }


@router.post("/batch_from_urls")
async def batch_import_from_urls(request: BatchImportRequest, db: Session = Depends(get_db)):
    """Batch import papers from multiple URLs (synchronous, legacy)."""
    if not request.urls:
        raise HTTPException(status_code=400, detail="URLs list cannot be empty")

    results = []
    errors = []

    for url in request.urls:
        try:
            result = _import_pdf_from_url(
                url=url,
                filename_hint=None,
                ocr_auto=request.ocr_auto,
                ocr_min_height_px=request.ocr_min_height_px,
                ocr_y_padding_px=request.ocr_y_padding_px,
                db=db,
                on_step=None,
            )
            results.append(
                {
                    "url": url,
                    "success": True,
                    "paper": result["paper"],
                    "ocr_questions": result.get("ocr_questions", []),
                    "ocr_boxes": result.get("ocr_boxes", []),
                    "ocr_warn": result.get("ocr_warn"),
                }
            )
        except Exception as e:
            errors.append({"url": url, "success": False, "error": _err_text(e)})

    return {
        "total": len(request.urls),
        "successful": len(results),
        "failed": len(errors),
        "results": results,
        "errors": errors,
    }
