"""云端同步接口：配置自检 + 后台同步任务 + 状态轮询。"""
from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, HTTPException, Request

from backend.cloud.config import cloud_enabled, get_cloud_config, get_cloud_token, missing_config
from backend.cloud.state import load_sync_state, record_sync_result
from backend.cloud.sync import SyncSummary, run_sync

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/cloud", tags=["cloud"])

_lock = threading.Lock()
_state: dict = {"running": False, "current": None, "last": None}
# current: 运行中的 SyncSummary 对象（读时转 dict，phase 实时可见）

# Allow overriding the state file location (used by tests).
STATE_PATH_OVERRIDE: str | None = None


def _require_token(request: Request) -> None:
    """Guard /cloud/* write endpoints with a local management token.

    Reads ``PAPER_CLOUD_TOKEN`` from the environment.  When the variable is
    unset / empty the management surface is disabled and every write is
    rejected with 403.  When configured, the caller must present the token
    via ``Authorization: Bearer <token>`` or ``X-Paper-Token: <token>``.
    """
    expected = get_cloud_token()
    if not expected:
        raise HTTPException(status_code=403, detail="云同步管理写操作已禁用（未配置 PAPER_CLOUD_TOKEN）")
    provided = ""
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        provided = auth[7:].strip()
    if not provided:
        provided = request.headers.get("X-Paper-Token", "").strip()
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="token 无效或缺失")
# last:    最近一次结束的 dict 快照


def _run_in_background(summary: SyncSummary) -> None:
    cfg = get_cloud_config()
    try:
        run_sync(cfg, summary)
    except Exception as exc:  # 网络/云端错误统一收敛到状态里
        logger.exception("cloud sync failed")
        summary.ok = False
        summary.phase = "failed"
        summary.errors.append(str(exc))
    finally:
        with _lock:
            _state["running"] = False
            d = summary.to_dict()
            _state["last"] = d
            _state["current"] = None
        try:
            record_sync_result(d)
        except Exception:  # noqa: BLE001
            logger.exception("failed to persist cloud sync state")


@router.get("/config")
def config_info():
    cfg = get_cloud_config()
    token_configured = bool(get_cloud_token())
    return {
        "enabled": cloud_enabled(),
        "missing": missing_config(cfg),
        "supabase_url": cfg.supabase_url,
        "r2_bucket": cfg.r2_bucket,
        "token_configured": token_configured,
        "management_disabled": not token_configured,
    }


@router.post("/sync")
def start_sync(request: Request):
    _require_token(request)
    cfg = get_cloud_config()
    if not cloud_enabled():
        raise HTTPException(status_code=400, detail="云端同步未开启（.env 中 PAPER_CLOUD_ENABLED=1）")
    missing = missing_config(cfg)
    if missing:
        raise HTTPException(status_code=400, detail=f"缺少配置: {', '.join(missing)}")

    summary = SyncSummary(phase="queued")
    with _lock:
        if _state["running"]:
            raise HTTPException(status_code=409, detail="同步正在进行中")
        _state["running"] = True
        _state["current"] = summary

    thread = threading.Thread(
        target=_run_in_background, args=(summary,), daemon=True, name="cloud-sync"
    )
    thread.start()
    return {"started": True}


@router.get("/sync/status")
def sync_status():
    with _lock:
        current = _state["current"]
        last = _state["last"]
        running = _state["running"]
    disk_state = load_sync_state()
    token_configured = bool(get_cloud_token())
    return {
        "running": running,
        "current": current.to_dict() if current is not None else None,
        "last": last,
        "disk_state": disk_state or None,
        "token_configured": token_configured,
        "management_disabled": not token_configured,
    }


# ---------------------------------------------------------------------------
# 云端管理（管理端专用）：反馈处理 + 权限管理，走 service role
# ---------------------------------------------------------------------------

def _require_cloud() -> tuple:
    cfg = get_cloud_config()
    if not cloud_enabled():
        raise HTTPException(status_code=400, detail="云端功能未开启（PAPER_CLOUD_ENABLED=1）")
    missing = missing_config(cfg)
    if missing:
        raise HTTPException(status_code=400, detail=f"缺少配置: {', '.join(missing)}")
    return cfg


@router.get("/suggestions")
def list_suggestions():
    """反馈列表（含题号/试卷/提交人），供管理端处理。"""
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        rows = sb.select(
            cfg,
            "suggestions",
            columns=(
                "id,body,status,created_at,question_id,user_id,"
                "profiles(email),"
                "questions(question_no,paper_id,papers(exam_code))"
            ),
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return rows


@router.patch("/suggestions/{suggestion_id}")
def update_suggestion(suggestion_id: int, payload: dict, request: Request):
    _require_token(request)
    status = str(payload.get("status") or "")
    if status not in {"open", "accepted", "rejected"}:
        raise HTTPException(status_code=400, detail="status 必须是 open/accepted/rejected")
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        n = sb.patch(cfg, "suggestions", {"id": f"eq.{suggestion_id}"}, {"status": status})
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    if n == 0:
        raise HTTPException(status_code=404, detail="suggestion not found")
    return {"ok": True, "status": status}


@router.delete("/suggestions/{suggestion_id}")
def delete_suggestion(suggestion_id: int, request: Request):
    """Permanently remove one feedback row."""
    _require_token(request)
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        n = sb.delete_filtered(cfg, "suggestions", {"id": f"eq.{suggestion_id}"})
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    if n == 0:
        raise HTTPException(status_code=404, detail="suggestion not found")
    return {"ok": True}


@router.get("/profiles")
def list_profiles():
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        rows = sb.select(
            cfg,
            "profiles",
            columns="id,email,role,can_see_drafts,created_at",
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return sorted(rows, key=lambda r: str(r.get("email") or ""))


@router.post("/users")
def create_user(payload: dict, request: Request):
    """Invite a user by email. They set their own password via the email link."""
    _require_token(request)
    email = str(payload.get("email") or "").strip()
    role = str(payload.get("role") or "teacher")
    can_see_drafts = bool(payload.get("can_see_drafts", False))
    if not email or "@" not in email or " " in email:
        raise HTTPException(status_code=400, detail="email 无效")
    if role not in {"admin", "teacher"}:
        raise HTTPException(status_code=400, detail="role 必须是 admin/teacher")

    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    invite_url = None
    user_id = ""
    try:
        user = sb.admin_invite_user(cfg, email)
        user_id = str(user.get("id") or "")
    except sb.SupabaseError as exc:
        msg = str(exc)
        if "already registered" in msg or "already been registered" in msg or "email_exists" in msg:
            raise HTTPException(status_code=409, detail="该邮箱已存在") from None
        # SMTP not configured / invite failed → hand the admin a manual link.
        try:
            invite_url = sb.admin_generate_invite_link(cfg, email)
            if invite_url:
                # generate_link also creates the auth user
                existing = sb.select(cfg, "profiles", columns="id,email", filters={"email": f"eq.{email}"})
                if existing:
                    user_id = str(existing[0].get("id") or "")
        except sb.SupabaseError as exc2:
            raise HTTPException(status_code=502, detail=f"{msg} / link: {exc2}") from None
        if not invite_url:
            raise HTTPException(status_code=502, detail=msg) from None

    if user_id:
        try:
            existing = sb.select(cfg, "profiles", columns="id", filters={"id": f"eq.{user_id}"})
            if existing:
                sb.patch(cfg, "profiles", {"id": f"eq.{user_id}"}, {"role": role, "can_see_drafts": can_see_drafts})
            else:
                sb.insert(cfg, "profiles", [{"id": user_id, "email": email, "role": role, "can_see_drafts": can_see_drafts}])
        except sb.SupabaseError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from None

    return {
        "ok": True,
        "email": email,
        "role": role,
        "invited": invite_url is None,
        "invite_url": invite_url,
    }


@router.patch("/profiles/{user_id}")
def update_profile(user_id: str, payload: dict, request: Request):
    _require_token(request)
    body: dict = {}
    if "role" in payload:
        if payload["role"] not in {"admin", "teacher"}:
            raise HTTPException(status_code=400, detail="role 必须是 admin/teacher")
        body["role"] = payload["role"]
    if "can_see_drafts" in payload:
        body["can_see_drafts"] = bool(payload["can_see_drafts"])
    if not body:
        raise HTTPException(status_code=400, detail="没有可更新的字段")
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        n = sb.patch(cfg, "profiles", {"id": f"eq.{user_id}"}, body)
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    if n == 0:
        raise HTTPException(status_code=404, detail="profile not found")
    return {"ok": True, **body}


@router.get("/grants")
def list_grants(user_id: str):
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        rows = sb.select(
            cfg,
            "question_grants",
            columns="id,user_id,scope,scope_value,created_at",
            filters={"user_id": f"eq.{user_id}"},
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return rows


@router.post("/grants")
def create_grant(payload: dict, request: Request):
    _require_token(request)
    user_id = str(payload.get("user_id") or "")
    scope = str(payload.get("scope") or "")
    value = str(payload.get("scope_value") or "").strip()
    if not user_id or scope not in {"section", "section_group", "paper", "question"} or not value:
        raise HTTPException(status_code=400, detail="user_id/scope/scope_value 无效")
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        # 幂等：已存在则直接成功
        existing = sb.select(
            cfg,
            "question_grants",
            columns="id",
            filters={"user_id": f"eq.{user_id}", "scope": f"eq.{scope}", "scope_value": f"eq.{value}"},
        )
        if not existing:
            sb.insert(cfg, "question_grants", [{"user_id": user_id, "scope": scope, "scope_value": value}])
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return {"ok": True}


@router.delete("/grants/{grant_id}")
def delete_grant(grant_id: int, request: Request):
    _require_token(request)
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        n = sb.delete_filtered(cfg, "question_grants", {"id": f"eq.{grant_id}"})
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    if n == 0:
        raise HTTPException(status_code=404, detail="grant not found")
    return {"ok": True}
