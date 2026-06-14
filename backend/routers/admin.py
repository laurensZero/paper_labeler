import shutil
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from PIL import Image
from sqlalchemy.orm import Session
from backend.database import SessionLocal, Paper, Question, QuestionBox, Answer, AnswerBox, SectionDef
from backend.schemas.schemas import PurgeAllRequest
from backend.config import PDF_DIR, PAGE_DIR
from backend.dependencies import get_db

router = APIRouter(tags=["admin"])

# --- WebP conversion progress tracking ---
_convert_state = {
    "running": False,
    "total": 0,
    "done": 0,
    "converted": 0,
    "errors": 0,
    "before_bytes": 0,
    "after_bytes": 0,
    "finished": False,
    "message": "",
}
_convert_lock = threading.Lock()


def _reset_convert_state():
    with _convert_lock:
        _convert_state.update({
            "running": False, "total": 0, "done": 0,
            "converted": 0, "errors": 0,
            "before_bytes": 0, "after_bytes": 0,
            "finished": False, "message": "",
        })


def _run_convert(quality: int):
    """Background worker: convert PNGs to WebP one by one, updating progress."""
    db = SessionLocal()
    try:
        pngs = sorted(PAGE_DIR.rglob("page_*.png"))
        # Filter out those that already have a webp counterpart
        pngs = [p for p in pngs if not p.with_suffix(".webp").exists()]
        total = len(pngs)

        with _convert_lock:
            _convert_state["total"] = total
            _convert_state["done"] = 0
            _convert_state["running"] = True
            _convert_state["finished"] = False

        if total == 0:
            with _convert_lock:
                _convert_state["finished"] = True
                _convert_state["running"] = False
                _convert_state["message"] = "没有需要转换的 PNG 文件"
            db.close()
            return

        safe_quality = max(1, min(100, quality))

        for i, png_path in enumerate(pngs):
            webp_path = png_path.with_suffix(".webp")
            png_size = png_path.stat().st_size

            try:
                with Image.open(png_path) as img:
                    img.save(str(webp_path), "WEBP", quality=safe_quality)
                webp_size = webp_path.stat().st_size
                png_path.unlink()

                with _convert_lock:
                    _convert_state["converted"] += 1
                    _convert_state["before_bytes"] += png_size
                    _convert_state["after_bytes"] += webp_size
            except Exception:
                with _convert_lock:
                    _convert_state["errors"] += 1

            with _convert_lock:
                _convert_state["done"] = i + 1

        # Update DB paths
        converted = _convert_state["converted"]
        if converted > 0:
            for box_cls in (QuestionBox, AnswerBox):
                rows = db.query(box_cls).all()
                for row in rows:
                    if row.image_path and row.image_path.endswith(".png"):
                        p = Path(row.image_path)
                        webp_alt = p.with_suffix(".webp")
                        if webp_alt.exists():
                            row.image_path = str(webp_alt)
                            db.add(row)
            db.commit()

        with _convert_lock:
            _convert_state["finished"] = True
            _convert_state["running"] = False
            _convert_state["message"] = "转换完成"
    except Exception as e:
        with _convert_lock:
            _convert_state["finished"] = True
            _convert_state["running"] = False
            _convert_state["message"] = f"转换失败: {e}"
    finally:
        db.close()


@router.post("/admin/convert_webp")
def start_convert_webp(quality: int = 85):
    """Start a background PNG→WebP conversion job. Poll /admin/convert_webp/status for progress."""
    with _convert_lock:
        if _convert_state["running"]:
            raise HTTPException(status_code=409, detail="转换任务已在运行中")

    _reset_convert_state()

    with _convert_lock:
        _convert_state["running"] = True

    t = threading.Thread(target=_run_convert, args=(quality,), daemon=True)
    t.start()

    return {"ok": True, "message": "转换已开始"}


@router.get("/admin/convert_webp/status")
def convert_webp_status():
    """Poll conversion progress."""
    with _convert_lock:
        return dict(_convert_state)


@router.post("/admin/purge_all")
def admin_purge_all(payload: PurgeAllRequest, db: Session = Depends(get_db)):
    """极其危险：一键清空所有试卷/题目/答案/文件。需要双重确认。"""
    if payload.confirm1 != "DELETE_ALL" or payload.confirm2 != "I_UNDERSTAND":
        raise HTTPException(status_code=400, detail="confirmation mismatch")

    # DB: delete children first
    db.query(AnswerBox).delete(synchronize_session=False)
    db.query(Answer).delete(synchronize_session=False)
    db.query(QuestionBox).delete(synchronize_session=False)
    db.query(Question).delete(synchronize_session=False)
    if payload.wipe_sections:
        db.query(SectionDef).delete(synchronize_session=False)
    db.query(Paper).delete(synchronize_session=False)
    db.commit()

    # Files: wipe pdfs/pages
    try:
        if PDF_DIR.exists():
            for p in PDF_DIR.glob("paper_*.pdf"):
                try:
                    p.unlink()
                except Exception:
                    pass
    except Exception:
        pass

    try:
        if PAGE_DIR.exists():
            for d in PAGE_DIR.glob("paper_*"):
                try:
                    if d.is_dir():
                        shutil.rmtree(d, ignore_errors=True)
                except Exception:
                    pass
    except Exception:
        pass

    return {"ok": True}
