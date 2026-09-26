"""Application logging: rotating file under data/logs/ plus console."""
from __future__ import annotations

import logging
import logging.handlers
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from backend.config import DATA_DIR

LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"
_MAX_BYTES = 2 * 1024 * 1024
_BACKUP_COUNT = 5

_configured = False
_config_lock = threading.Lock()

# In-memory ring of recent frontend events (for /logs tail + crash context)
_FRONTEND_RING_MAX = 200
_frontend_events: list[dict[str, Any]] = []
_frontend_lock = threading.Lock()


def setup_logging(level: int = logging.INFO) -> None:
    global _configured
    with _config_lock:
        if _configured:
            return
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        root = logging.getLogger()
        root.setLevel(level)

        fmt = logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

        # Avoid duplicate handlers on reload
        has_file = any(
            isinstance(h, logging.handlers.RotatingFileHandler)
            and getattr(h, "baseFilename", "") == str(LOG_FILE)
            for h in root.handlers
        )
        if not has_file:
            fh = logging.handlers.RotatingFileHandler(
                LOG_FILE,
                maxBytes=_MAX_BYTES,
                backupCount=_BACKUP_COUNT,
                encoding="utf-8",
            )
            fh.setFormatter(fmt)
            root.addHandler(fh)

        if not any(isinstance(h, logging.StreamHandler) and not isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
            sh = logging.StreamHandler()
            sh.setFormatter(fmt)
            root.addHandler(sh)

        _configured = True


def get_logger(name: str) -> logging.Logger:
    setup_logging()
    return logging.getLogger(name)


def log_path() -> Path:
    return LOG_FILE


def record_frontend_event(
    *,
    level: str,
    message: str,
    source: str = "ui",
    extra: Optional[dict[str, Any]] = None,
) -> None:
    """Persist a renderer/console event into the app log + ring buffer."""
    setup_logging()
    level_name = (level or "info").lower()
    logger = logging.getLogger("frontend")
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level_name,
        "source": source,
        "message": str(message or "")[:2000],
        "extra": extra or {},
    }
    with _frontend_lock:
        _frontend_events.append(payload)
        if len(_frontend_events) > _FRONTEND_RING_MAX:
            del _frontend_events[: len(_frontend_events) - _FRONTEND_RING_MAX]

    line = f"[{source}] {payload['message']}"
    if extra:
        line += f" | {extra}"
    if level_name in ("error", "exception", "fatal"):
        logger.error(line)
    elif level_name in ("warn", "warning"):
        logger.warning(line)
    else:
        logger.info(line)


def recent_frontend_events(limit: int = 50) -> list[dict[str, Any]]:
    safe = max(1, min(int(limit or 50), _FRONTEND_RING_MAX))
    with _frontend_lock:
        return list(_frontend_events[-safe:])
