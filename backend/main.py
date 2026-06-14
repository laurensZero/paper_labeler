from __future__ import annotations

import os
import sys
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
from backend.routers import admin, papers, questions, sections, stats, export, cie_import


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


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
    return {
        "APP_DIR": str(APP_DIR),
        "BUNDLE_DIR": str(BUNDLE_DIR),
        "DATA_DIR": str(DATA_DIR),
        "UI_DIR": str(UI_DIR),
        "DATA_DIR_exists": DATA_DIR.exists(),
        "UI_DIR_exists": UI_DIR.exists(),
        "PAPER_LABELER_DATA_DIR": os.getenv("PAPER_LABELER_DATA_DIR", ""),
        "PAPER_LABELER_ELECTRON": os.getenv("PAPER_LABELER_ELECTRON", ""),
    }


@app.get("/data/version")
def get_version():
    import json
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
    src_path = Path(src)

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

    return {"ok": True, "imported": copied, "restartRequired": True}


@app.post("/admin/apply-update")
async def apply_update(request: Request):
    """Receive a ZIP with ui/ and backend/ dirs, extract to APP_DIR.
    ZIP structure:
      ui/...       → APP_DIR/frontend-vite/dist/
      backend/...  → APP_DIR/backend/
    """
    import io, shutil, zipfile
    from backend.config import APP_DIR, BUNDLE_DIR

    body = await request.body()
    if not body:
        return JSONResponse({"error": "empty body"}, status_code=400)

    try:
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            for name in zf.namelist():
                if name.startswith('ui/'):
                    # ui/ → frontend-vite/dist/
                    rel = name[3:]
                    if not rel:
                        continue
                    target = BUNDLE_DIR / "frontend-vite" / "dist" / rel
                    if name.endswith('/'):
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with zf.open(name) as src, open(target, 'wb') as dst:
                            shutil.copyfileobj(src, dst)
                elif name.startswith('backend/'):
                    rel = name[8:]
                    if not rel:
                        continue
                    target = APP_DIR / "backend" / rel
                    if name.endswith('/'):
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with zf.open(name) as src, open(target, 'wb') as dst:
                            shutil.copyfileobj(src, dst)
    except Exception as e:
        return JSONResponse({"error": f"bad zip: {e}"}, status_code=400)

    return {"ok": True}


# Include API Routers
app.include_router(papers.router)
app.include_router(questions.router)
app.include_router(sections.router)
app.include_router(stats.router)
app.include_router(admin.router)
app.include_router(export.router, prefix="/export")
app.include_router(cie_import.router)


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



