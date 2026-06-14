import os
import sys
from pathlib import Path

# PAPER_LABELER_ROOT = exe directory (set by Electron main.cjs)
_root = os.getenv("PAPER_LABELER_ROOT", "").strip()
if _root:
    APP_DIR = Path(_root)
else:
    APP_DIR = Path(__file__).resolve().parents[1]

BUNDLE_DIR = APP_DIR
DATA_DIR = APP_DIR / "data"
PDF_DIR = DATA_DIR / "pdfs"
PAGE_DIR = DATA_DIR / "pages"
EXPORT_DIR = DATA_DIR / "_export_jobs"
_ui_res = BUNDLE_DIR / "resources" / "frontend-vite" / "dist"
_ui_dev = BUNDLE_DIR / "frontend-vite" / "dist"
UI_DIR = _ui_res if _ui_res.exists() else _ui_dev

MAX_UPLOAD_BYTES = 100 * 1024 * 1024

for d in (DATA_DIR, PDF_DIR, PAGE_DIR, EXPORT_DIR):
    d.mkdir(parents=True, exist_ok=True)
