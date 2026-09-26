"""Frontend log ingestion + log file access for diagnostics."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from backend.services.applog import (
    log_path,
    recent_frontend_events,
    record_frontend_event,
)

router = APIRouter(tags=["logs"])


class FrontendLogEvent(BaseModel):
    level: str = "info"
    message: str = ""
    source: str = "ui"
    extra: Optional[dict[str, Any]] = None


class FrontendLogBatch(BaseModel):
    events: list[FrontendLogEvent] = Field(default_factory=list)


@router.post("/logs")
def ingest_frontend_logs(payload: FrontendLogBatch):
    for ev in payload.events[:50]:
        record_frontend_event(
            level=ev.level,
            message=ev.message,
            source=ev.source or "ui",
            extra=ev.extra,
        )
    return {"ok": True, "accepted": min(len(payload.events), 50)}


@router.get("/logs/recent")
def get_recent_logs(limit: int = Query(50, ge=1, le=200)):
    return {
        "path": str(log_path()),
        "events": recent_frontend_events(limit),
    }


@router.get("/logs/tail")
def tail_log_file(limit: int = Query(100, ge=1, le=500)):
    """Return the last N lines of the rotating app log (for support / QA)."""
    path = log_path()
    if not path.exists():
        return {"path": str(path), "lines": []}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return {"path": str(path), "lines": lines[-limit:]}
    except Exception as e:
        return {"path": str(path), "lines": [], "error": str(e)}
