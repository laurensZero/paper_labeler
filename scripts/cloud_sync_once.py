"""直接跑一轮云同步（不经过 HTTP），输出 JSON 摘要到 stdout。

用法：venv\\Scripts\\python.exe scripts/cloud_sync_once.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.cloud.config import cloud_enabled, get_cloud_config, missing_config  # noqa: E402
from backend.cloud.sync import SyncSummary, run_sync  # noqa: E402


def main() -> int:
    cfg = get_cloud_config()
    if not cloud_enabled() or missing_config(cfg):
        print(json.dumps({"ok": False, "errors": ["配置未就绪"]}, ensure_ascii=False))
        return 1
    summary = SyncSummary()
    run_sync(cfg, summary)
    print(json.dumps(summary.to_dict(), ensure_ascii=False, indent=2))
    return 0 if summary.ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
