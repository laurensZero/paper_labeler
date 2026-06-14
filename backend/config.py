import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR)).resolve()
else:
    APP_DIR = Path(__file__).resolve().parents[1]
    BUNDLE_DIR = APP_DIR

DATA_DIR = APP_DIR / "data"
PDF_DIR = DATA_DIR / "pdfs"
PAGE_DIR = DATA_DIR / "pages"
EXPORT_DIR = DATA_DIR / "_export_jobs"

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100MB per file

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
PDF_DIR.mkdir(parents=True, exist_ok=True)
PAGE_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

# UI_DIR: 前端构建输出目录
_vite_ui_dir = BUNDLE_DIR / "frontend-vite" / "dist"
_legacy_ui_dir = BUNDLE_DIR / "frontend"
UI_DIR = _vite_ui_dir if _vite_ui_dir.exists() else _legacy_ui_dir
