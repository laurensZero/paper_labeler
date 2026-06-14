import os
import sys
from pathlib import Path


def _resolve_app_dir() -> Path:
    """Determine the application root directory.

    Priority:
    1. PAPER_LABELER_ROOT env var (set by Electron main.cjs)
    2. Directory containing the running executable (PyInstaller / direct .exe)
    3. Parent of this config.py file (development mode)
    """
    # 1) Explicit env var (Electron sets this)
    env_root = os.getenv("PAPER_LABELER_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root)
        if (candidate / "data").is_dir():
            return candidate

    # 2) EXE directory — if data/ sits next to the executable, use it
    exe_dir = Path(sys.executable).resolve().parent
    if (exe_dir / "data").is_dir():
        return exe_dir

    # 3) Development fallback: project root (parent of backend/)
    return Path(__file__).resolve().parents[1]


APP_DIR = _resolve_app_dir()
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
