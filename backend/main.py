from __future__ import annotations

import os
import sys
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

# When packaged with PyInstaller, this file is executed as a script (no package context),
# so relative imports like ".database" would fail. Ensure the project root is on sys.path
# and use absolute imports.
if __package__ is None or __package__ == "":
    _ROOT = Path(__file__).resolve().parents[1]
    if str(_ROOT) not in sys.path:
        sys.path.insert(0, str(_ROOT))

from backend.database import init_db
from backend.config import DATA_DIR, UI_DIR
from backend.services.applog import get_logger, setup_logging
from backend.routers import admin, papers, questions, sections, stats, export, cie_import, compositions, logs


def _migrate_legacy_appdata_data() -> None:
    """v2.0.0 packaged builds stored data in %APPDATA%/PaperLabeler/data.
    If the current DATA_DIR has no database yet but the legacy location does,
    copy the legacy data over so upgrading users keep their work. The AppData
    originals are left untouched as a backup, and files already present in
    DATA_DIR are never overwritten."""
    import shutil

    if (DATA_DIR / "app.db").exists():
        return
    appdata = os.getenv("APPDATA", "").strip()
    if not appdata:
        return
    legacy_dir = Path(appdata) / "PaperLabeler" / "data"
    if not (legacy_dir / "app.db").exists():
        return
    try:
        if legacy_dir.resolve() == DATA_DIR.resolve():
            return
    except Exception:
        return

    def _copy_tree(src: Path, dst: Path) -> None:
        dst.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            child_dst = dst / child.name
            if child.is_dir():
                _copy_tree(child, child_dst)
            elif not child_dst.exists():
                shutil.copy2(child, child_dst)

    print(f"[migrate] found legacy data in {legacy_dir}, copying to {DATA_DIR}")
    try:
        # Copy app.db last: if the copy is interrupted, the missing app.db
        # makes the migration retry on next startup instead of serving
        # partially migrated data.
        for item in sorted(legacy_dir.iterdir(), key=lambda p: p.name == "app.db"):
            target = DATA_DIR / item.name
            if item.is_dir():
                _copy_tree(item, target)
            elif not target.exists():
                shutil.copy2(item, target)
        print(f"[migrate] legacy data migrated from {legacy_dir} to {DATA_DIR} (originals kept as backup)")
    except Exception as e:
        print(f"[migrate] legacy data migration failed: {e}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    setup_logging()
    log = get_logger("app")
    log.info("backend starting DATA_DIR=%s UI_DIR=%s", DATA_DIR, UI_DIR)
    _migrate_legacy_appdata_data()
    init_db()
    log.info("backend ready")
    yield
    log.info("backend shutdown")


class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            # Vite uses history routing under /ui/. Missing asset files should
            # stay 404, while app routes such as /ui/filter serve index.html.
            if Path(path).name and "." in Path(path).name:
                raise
            return await super().get_response("index.html", scope)


app = FastAPI(
    title="Question Labeling System",
    lifespan=lifespan,
    default_response_class=UTF8JSONResponse,
)

cors_origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:3000",
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Rate limiter (in-memory sliding window, no external deps) ──────────
_RATE_LIMIT_MAX = int(os.getenv("RATE_LIMIT_MAX", "120"))  # requests per window
_RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))  # seconds
_rate_hits: dict[str, deque[float]] = defaultdict(deque)
_rate_last_sweep = 0.0


def _rate_limit_exempt(path: str) -> bool:
    # Static assets, health checks and high-frequency read endpoints
    # (question preview images, export status polling) must not count
    # against the limit — in Electron all traffic shares 127.0.0.1.
    if path.startswith("/data/") or path.startswith("/ui/") or path == "/health":
        return True
    if path.endswith("/preview.png"):
        return True
    if path.startswith("/export/questions_pdf_job/"):
        return True
    # CIE subject combo / import job polling is small and user-facing
    if path.startswith("/cie_import/subject_combo") or path.startswith("/cie_import/import_job"):
        return True
    if path.startswith("/logs"):
        return True
    return False


@app.middleware("http")
async def _log_requests(request: Request, call_next):
    start = time.perf_counter()
    status = 500
    try:
        resp = await call_next(request)
        status = getattr(resp, "status_code", 500)
        return resp
    finally:
        elapsed_ms = (time.perf_counter() - start) * 1000
        path = request.url.path
        # Skip noisy static/preview traffic
        if not (path.startswith("/data/") or path.startswith("/ui/") or path.endswith("/preview.png")):
            if status >= 500 or elapsed_ms > 1500:
                get_logger("http").warning(
                    "%s %s -> %s in %.0fms", request.method, path, status, elapsed_ms
                )
            elif status >= 400:
                get_logger("http").info(
                    "%s %s -> %s in %.0fms", request.method, path, status, elapsed_ms
                )


@app.middleware("http")
async def _rate_limit(request: Request, call_next):
    if _rate_limit_exempt(request.url.path):
        return await call_next(request)

    global _rate_last_sweep
    client = request.client
    ip = client.host if client else "unknown"
    now = time.monotonic()
    cutoff = now - _RATE_LIMIT_WINDOW

    # Periodically drop idle clients so _rate_hits cannot grow forever
    if now - _rate_last_sweep >= _RATE_LIMIT_WINDOW:
        _rate_last_sweep = now
        for stale_ip, stale_hits in list(_rate_hits.items()):
            while stale_hits and stale_hits[0] < cutoff:
                stale_hits.popleft()
            if not stale_hits:
                del _rate_hits[stale_ip]

    hits = _rate_hits[ip]

    # Prune expired entries
    while hits and hits[0] < cutoff:
        hits.popleft()

    if len(hits) >= _RATE_LIMIT_MAX:
        return JSONResponse(
            {"detail": "Too many requests, please slow down."},
            status_code=429,
        )

    hits.append(now)
    return await call_next(request)


app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")


@app.middleware("http")
async def _cache_static_assets(request: Request, call_next):
    resp = await call_next(request)
    try:
        p = request.url.path
        if p.startswith("/data/pages/") or p.startswith("/data/pdfs/"):
            # Cache aggressively; URLs contain ?v=<mtime> cache-bust token
            # so the browser fetches fresh content when files change.
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    except Exception:
        pass
    return resp


if UI_DIR.exists():
    app.mount("/ui", SPAStaticFiles(directory=str(UI_DIR), html=True), name="ui")


@app.get("/")
def root():
    return {"message": "Backend is running"}


@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/debug/paths")
def debug_paths():
    from backend.config import DATA_DIR, UI_DIR, APP_DIR, BUNDLE_DIR
    db_path = DATA_DIR / "app.db"
    papers_count = None
    if db_path.exists():
        import sqlite3
        try:
            conn = sqlite3.connect(str(db_path))
            papers_count = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
            conn.close()
        except Exception:
            papers_count = "error"
    return {
        "APP_DIR": str(APP_DIR),
        "BUNDLE_DIR": str(BUNDLE_DIR),
        "DATA_DIR": str(DATA_DIR),
        "UI_DIR": str(UI_DIR),
        "DATA_DIR_exists": DATA_DIR.exists(),
        "app.db_exists": db_path.exists(),
        "app.db_size": db_path.stat().st_size if db_path.exists() else 0,
        "papers_count": papers_count,
        "PAPER_LABELER_ROOT": os.getenv("PAPER_LABELER_ROOT", ""),
        "PAPER_LABELER_BUNDLE_DIR": os.getenv("PAPER_LABELER_BUNDLE_DIR", ""),
    }


@app.get("/version")
def get_version():
    import json
    # Packaged app: Electron passes its own version via environment
    env_ver = os.environ.get("PAPER_LABELER_APP_VERSION", "").strip()
    if env_ver:
        return {"version": env_ver}
    # Fallback to package.json (dev environment)
    pkg = Path(__file__).resolve().parents[1] / "frontend-vite" / "package.json"
    ver = "0.0.0"
    if pkg.exists():
        try:
            ver = json.loads(pkg.read_text(encoding="utf-8")).get("version", ver)
        except Exception:
            pass
    return {"version": ver}


@app.post("/admin/import-data")
async def import_data(request: Request):
    """Import data from a user-selected folder into DATA_DIR."""
    import shutil

    body = await request.json()
    src = body.get("path", "").strip()
    if not src or not Path(src).is_dir():
        return JSONResponse({"error": "无效的文件夹路径"}, status_code=400)

    from backend.config import DATA_DIR
    src_path = Path(src).resolve()
    data_dir = DATA_DIR.resolve()
    if src_path == data_dir or data_dir in src_path.parents or src_path in data_dir.parents:
        return JSONResponse(
            {"error": "导入文件夹不能是当前数据目录本身，也不能是它的上级或下级目录"},
            status_code=400,
        )

    copied = []
    for item in ("app.db", "pdfs", "pages"):
        s = src_path / item
        if not s.exists():
            continue
        d = DATA_DIR / item
        if s.is_dir():
            if d.exists():
                shutil.rmtree(d)
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
        copied.append(item)

    if not copied:
        return JSONResponse({"error": "文件夹中没有找到可导入的数据（需要 app.db、pdfs、pages）"}, status_code=400)

    # Reconnect database to imported data, then ensure schema is up to date
    # (an older app.db may lack newer tables/columns)
    from backend.database import reconnect_db
    reconnect_db()
    init_db()

    return {"ok": True, "imported": copied}


# Include API Routers
app.include_router(papers.router)
app.include_router(questions.router)
app.include_router(sections.router)
app.include_router(stats.router)
app.include_router(admin.router)
app.include_router(export.router, prefix="/export")
app.include_router(cie_import.router)
app.include_router(compositions.router)
app.include_router(logs.router)
try:
    from backend.routers import cloud as _cloud_router
    app.include_router(_cloud_router.router)
except Exception:
    pass


def _run_uvicorn() -> None:
    import uvicorn

    host = os.getenv("PAPER_LABELER_HOST", "127.0.0.1").strip() or "127.0.0.1"
    try:
        port = int(os.getenv("PAPER_LABELER_PORT", "8000"))
    except Exception:
        port = 8000

    print(f"\nPaper Labeler running: http://{host}:{port}/ui/\n")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    _run_uvicorn()



