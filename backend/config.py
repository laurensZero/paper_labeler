import os
import sys
from pathlib import Path

def _resolve_app_dir() -> Path:
    # 1) Electron 传入的路径（打包后最重要）
    env_root = os.getenv("PAPER_LABELER_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root)
        if (candidate / "data").is_dir():
            return candidate

    # 2) EXE 同级目录有 data/ 就用它
    exe_dir = Path(sys.executable).resolve().parent
    if (exe_dir / "data").is_dir():
        return exe_dir

    # 3) 开发模式兜底
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
