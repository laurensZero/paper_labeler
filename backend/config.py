import os
import sys
from pathlib import Path

# Determine BUNDLE_DIR (where bundled assets like frontend/ live)
if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR)).resolve()
else:
    APP_DIR = Path(__file__).resolve().parents[1]
    BUNDLE_DIR = APP_DIR

# Determine DATA_DIR (writable user data — must persist across updates)
# If PAPER_LABELER_DATA_DIR is set (by Electron), use it.
# Otherwise, use <project>/data for dev, or AppData for packaged apps.
_data_override = os.getenv("PAPER_LABELER_DATA_DIR", "").strip()
if _data_override:
    DATA_DIR = Path(_data_override).expanduser().resolve()
elif os.getenv("PAPER_LABELER_ELECTRON"):
    # Electron packaged app → use AppData
    _appdata = os.getenv("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    DATA_DIR = Path(_appdata) / "PaperLabeler" / "data"
else:
    DATA_DIR = APP_DIR / "data"
PDF_DIR = DATA_DIR / "pdfs"
PAGE_DIR = DATA_DIR / "pages"
EXPORT_DIR = DATA_DIR / "_export_jobs"

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100MB per file

import logging as _logging
_logging.warning(f"[config] DATA_DIR={DATA_DIR} exists={DATA_DIR.exists()} contents={list(DATA_DIR.iterdir()) if DATA_DIR.exists() else 'N/A'}")

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
PDF_DIR.mkdir(parents=True, exist_ok=True)
PAGE_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

# UI_DIR: 前端构建输出目录
# 默认优先使用 Vite 迁移版；如果尚未构建，则回退到旧版 frontend 目录。
_ui_dir_override = os.getenv("PAPER_LABELER_UI_DIR", "").strip()
if _ui_dir_override:
    UI_DIR = Path(_ui_dir_override).expanduser().resolve()
elif os.getenv("PAPER_LABELER_ELECTRON"):
    # Electron: prefer hot-updated UI in AppData, fall back to bundled
    _appdata_ui = Path(os.getenv("APPDATA") or str(Path.home() / "AppData" / "Roaming")) / "PaperLabeler" / "ui"
    if _appdata_ui.exists():
        UI_DIR = _appdata_ui
    else:
        _vite_ui_dir = BUNDLE_DIR / "frontend-vite" / "dist"
        _legacy_ui_dir = BUNDLE_DIR / "frontend"
        UI_DIR = _vite_ui_dir if _vite_ui_dir.exists() else _legacy_ui_dir
else:
    _vite_ui_dir = BUNDLE_DIR / "frontend-vite" / "dist"
    _legacy_ui_dir = BUNDLE_DIR / "frontend"
    UI_DIR = _vite_ui_dir if _vite_ui_dir.exists() else _legacy_ui_dir
