"""Cloud sync state persistence.

Writes last-run result to ``data/cloud_sync_state.json`` so the UI can show
sync status across restarts. Never stores secrets.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backend.config import DATA_DIR

logger = logging.getLogger(__name__)

STATE_FILENAME = "cloud_sync_state.json"


def _state_path() -> Path:
    override = os.getenv("PAPER_CLOUD_STATE_PATH", "").strip()
    if override:
        return Path(override)
    return DATA_DIR / STATE_FILENAME


def load_sync_state() -> dict:
    """Return the persisted sync state dict, or ``{}`` if missing/invalid."""
    path = _state_path()
    try:
        if not path.is_file():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        logger.warning("Failed to read cloud sync state from %s", path, exc_info=True)
        return {}


def save_sync_state(state: dict) -> None:
    """Atomically write *state* to the state file."""
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".cloud_sync_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2, default=str)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        logger.warning("Failed to write cloud sync state to %s", path, exc_info=True)


def record_sync_result(summary_dict: dict) -> dict:
    """Persist a SyncSummary dict as the latest sync state and return it."""
    state = {
        "ok": bool(summary_dict.get("ok")),
        "last_run": summary_dict.get("finished_at") or datetime.now(timezone.utc).isoformat(),
        "success": bool(summary_dict.get("ok")),
        "failed": not bool(summary_dict.get("ok")),
        "phase": summary_dict.get("phase", ""),
        "started_at": summary_dict.get("started_at", ""),
        "finished_at": summary_dict.get("finished_at", ""),
        "duration_s": summary_dict.get("duration_s", 0),
        "counts": summary_dict.get("counts", {}),
        "errors": (summary_dict.get("errors") or [])[:50],
        "error_count": summary_dict.get("error_count", 0),
        "resurrected": (summary_dict.get("resurrected") or [])[:50],
    }
    save_sync_state(state)
    return state
