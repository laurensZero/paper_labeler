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

# UI 文件位置：热更新后在 APP_DIR，首次运行在原始打包目录
_env_res = os.getenv("PAPER_LABELER_RESOURCES_DIR", "").strip()
_resources_dir = Path(_env_res) if _env_res else APP_DIR
_ui_hot = APP_DIR / "frontend-vite" / "dist"
_ui_bundled = _resources_dir / "frontend-vite" / "dist"
_ui_bundled_res = _resources_dir / "resources" / "frontend-vite" / "dist"
if _ui_hot.exists():
    UI_DIR = _ui_hot
elif _ui_bundled.exists():
    UI_DIR = _ui_bundled
elif _ui_bundled_res.exists():
    UI_DIR = _ui_bundled_res
else:
    UI_DIR = _ui_hot

MAX_UPLOAD_BYTES = 100 * 1024 * 1024

for d in (DATA_DIR, PDF_DIR, PAGE_DIR, EXPORT_DIR):
    d.mkdir(parents=True, exist_ok=True)
