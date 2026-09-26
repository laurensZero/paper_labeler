"""
CIE Paper Import from https://cie.fraft.cn/
"""
from __future__ import annotations

import re
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from datetime import datetime
from typing import Callable, Optional, List
import urllib.request
import urllib.parse
import urllib.error

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend.database import SessionLocal
from backend.dependencies import get_db
from backend.config import DATA_DIR
from backend.services.paper_utils import stem_no_ext

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
            frac_sum = sum(item_frac)
            done = sum(1 for f in item_frac if f >= 1.0)
            active = [
                {"index": i, "filename": item_name[i], "step": item_step[i]}
                for i in range(total)
                if 0.0 < item_frac[i] < 1.0
            ]
            percent = round((frac_sum / total) * 100.0, 1) if total else 100.0
            filename = active[0]["filename"] if active else (item_name[-1] if item_name else "")
            step = active[0]["step"] if active else ("done" if done >= total else "queued")
            # Continuous current so parallel imports do not sit at "0/6".
            current_display = round(frac_sum, 1) if any(0.0 < f < 1.0 for f in item_frac) else done
            _set_job(
                job_id,
                current=current_display,
                filename=filename,
                step=step,
                percent=percent,
                active=active[:6],
                msg=f"{current_display}/{total}"
                + (f" · {len(active)} 份并行中" if active else ""),
            )

    def work_one(idx: int) -> dict:
        item = items[idx]
        filename = item_name[idx]

        def on_event(event: dict) -> None:
            # Pipeline stages use "register"; frontend step list still says "save".
            stage = str(event.get("stage") or "")
            if stage == "register":
                stage = "save"
            elif stage == "done":
                stage = "done"
            frac = float(event.get("frac") or 0.0)
            with progress_lock:
                item_step[idx] = stage or item_step[idx]
                item_frac[idx] = max(item_frac[idx], min(1.0, frac))
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
                    on_event=on_event,
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
    on_event: Optional[Callable[[dict], None]] = None,
) -> dict:
    """Download + import one PDF via the staged pipeline. Raises on failure."""
    from backend.services.import_pipeline import ImportContext, run_import

    filename = (filename_hint or "").strip() or extract_filename_from_url(url)
    ctx = ImportContext(
        url=(url or "").strip(),
        filename=filename,
        ocr_auto=bool(ocr_auto),
        ocr_min_height_px=int(ocr_min_height_px or 0),
        ocr_y_padding_px=int(ocr_y_padding_px or 0),
        on_event=on_event,
    )
    return run_import(ctx, db)


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
        on_event=None,
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
                on_event=None,
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
