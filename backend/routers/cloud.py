"""云端同步接口：配置自检 + 后台同步任务 + 状态轮询。"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from backend.cloud.config import (
    cloud_enabled,
    get_cloud_config,
    get_cloud_token,
    missing_config,
    save_env_values,
)
from backend.cloud.state import load_sync_state, record_sync_result
from backend.cloud.sync import SyncSummary, run_sync
from backend.routers.export import (
    ExportOptions,
    ExportRequest,
    check_export_status,
    create_export_job,
    download_export_file,
)

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
        # 图形化配置表单回显（本机管理端；与直接读 .env 等价，非跨网机密）
        "form": {
            "SUPABASE_URL": cfg.supabase_url,
            "SUPABASE_SERVICE_ROLE_KEY": cfg.service_role_key,
            "R2_ACCOUNT_ID": cfg.r2_account_id,
            "R2_ACCESS_KEY_ID": cfg.r2_access_key_id,
            "R2_SECRET_ACCESS_KEY": cfg.r2_secret_access_key,
            "R2_BUCKET": cfg.r2_bucket,
            "R2_PUBLIC_BASE": cfg.r2_public_base,
            "PAPER_CLOUD_ENABLED": "1" if cloud_enabled() else "0",
            "PAPER_CLOUD_TOKEN": get_cloud_token(),
        },
    }


# 可通过设置页编辑的 .env 键
_EDITABLE_ENV = (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_BASE",
    "PAPER_CLOUD_ENABLED",
    "PAPER_CLOUD_TOKEN",
)


@router.put("/config")
def update_config(payload: dict, request: Request):
    """图形化写配置：upsert 根 .env 并即时生效（免重启）。

    已配置 PAPER_CLOUD_TOKEN 后必须带对；未配置时放行作为首次配置入口
    （同机进程本就能直接改 .env；浏览器跨站请求被 CORS 拦截）。
    """
    if get_cloud_token():
        _require_token(request)
    updates: dict[str, str] = {}
    for key in _EDITABLE_ENV:
        if key not in payload or payload[key] is None:
            continue  # null/缺失 = 不改
        val = str(payload[key]).strip()
        if len(val) > 4096:
            raise HTTPException(status_code=400, detail=f"{key} 过长")
        if key == "PAPER_CLOUD_ENABLED" and val not in {"", "0", "1"}:
            raise HTTPException(status_code=400, detail="PAPER_CLOUD_ENABLED 必须是 0/1")
        updates[key] = val
    if not updates:
        raise HTTPException(status_code=400, detail="没有可更新的字段")
    save_env_values(updates)
    cfg = get_cloud_config()
    return {
        "ok": True,
        "enabled": cloud_enabled(),
        "missing": missing_config(cfg),
        "token_configured": bool(get_cloud_token()),
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
    if disk_state and "ok" not in disk_state:
        # 旧版落盘文件只有 success/failed，归一化给前端统一用 ok
        disk_state["ok"] = bool(disk_state.get("success"))
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


def _parse_ts(value: object) -> datetime | None:
    """Supabase timestamptz 字符串 → UTC datetime（解析失败返回 None）。"""
    if not value:
        return None
    try:
        s = str(value)
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _period_starts(now: datetime | None = None) -> tuple[datetime, datetime]:
    """(本周一 00:00 UTC, 本月1日 00:00 UTC)，与 PG date_trunc('week'/'month', now()) 对齐。"""
    now = now or datetime.now(timezone.utc)
    week = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return week, month


@router.get("/profiles")
def list_profiles():
    """用户列表 + 限额配置 + 已用次数（组卷存量 / 本周·本月导出，供导出管控页展示）。"""
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    week_start, month_start = _period_starts()
    # 只拉本周期相关的导出记录（周窗口可能跨月，取两者较早者）
    jobs_since = min(week_start, month_start)
    try:
        rows = sb.select(
            cfg,
            "profiles",
            columns=(
                "id,email,role,can_see_drafts,created_at,is_active,"
                "max_compositions,max_exports_per_week,max_exports_per_month,max_export_items"
            ),
        )
        comp_rows = sb.select(cfg, "compositions", columns="owner_id")
        job_rows = sb.select(
            cfg,
            "export_jobs",
            columns="requested_by,status,created_at",
            filters={"created_at": f"gte.{jobs_since.isoformat()}"},
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None

    comp_counts: dict[str, int] = {}
    for r in comp_rows:
        oid = str(r.get("owner_id") or "")
        if oid:
            comp_counts[oid] = comp_counts.get(oid, 0) + 1

    export_week: dict[str, int] = {}
    export_month: dict[str, int] = {}
    for r in job_rows:
        if str(r.get("status") or "") == "failed":
            continue
        uid = str(r.get("requested_by") or "")
        ts = _parse_ts(r.get("created_at"))
        if not uid or ts is None:
            continue
        if ts >= week_start:
            export_week[uid] = export_week.get(uid, 0) + 1
        if ts >= month_start:
            export_month[uid] = export_month.get(uid, 0) + 1

    for r in rows:
        uid = str(r.get("id") or "")
        r["composition_count"] = comp_counts.get(uid, 0)
        r["export_count_week"] = export_week.get(uid, 0)
        r["export_count_month"] = export_month.get(uid, 0)
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
    # 邮件链接回跳 = Supabase Auth 的 Site URL（Dashboard 一次性配置，零 .env）。
    # 网页端路由守卫按抢存的链接类型分流到设置密码页。
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


def _parse_quota(value: object, field: str) -> int | None:
    """限额字段：null = 不限；非负整数；其余 400。"""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(status_code=400, detail=f"{field} 必须是非负整数或 null")
    if int(value) != value or int(value) < 0:
        raise HTTPException(status_code=400, detail=f"{field} 必须是非负整数或 null")
    return int(value)


@router.patch("/profiles/{user_id}")
def update_profile(user_id: str, payload: dict, request: Request):
    # 停用用户（封禁）：profiles.is_active 打标 + GoTrue ban_duration 真正禁止登录。
    # 顺序：先落库再封禁；封禁失败返回 502（is_active 已是新值，重试幂等）。
    _require_token(request)
    body: dict = {}
    if "role" in payload:
        if payload["role"] not in {"admin", "teacher"}:
            raise HTTPException(status_code=400, detail="role 必须是 admin/teacher")
        body["role"] = payload["role"]
    if "can_see_drafts" in payload:
        body["can_see_drafts"] = bool(payload["can_see_drafts"])
    if "is_active" in payload:
        body["is_active"] = bool(payload["is_active"])
    for field in (
        "max_compositions",
        "max_exports_per_week",
        "max_exports_per_month",
        "max_export_items",
    ):
        if field in payload:
            body[field] = _parse_quota(payload[field], field)
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

    if "is_active" in body:
        try:
            sb.admin_set_banned(cfg, user_id, banned=not body["is_active"])
        except sb.SupabaseError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"状态已标记，但登录封禁操作失败（可重试）：{exc}",
            ) from None
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


# ---------------------------------------------------------------------------
# 组卷查看（管理端）：全部用户的组卷列表 + 题目明细
# ---------------------------------------------------------------------------

def _embed_one(value: object) -> dict | None:
    """PostgREST 嵌入可能是 dict 或单元素 list，统一取 dict。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return None


@router.get("/compositions")
def list_compositions():
    """全部用户的组卷（含所属邮箱与题目数），按更新时间倒序。"""
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        rows = sb.select(
            cfg,
            "compositions",
            columns=(
                "id,name,title,visibility,created_at,updated_at,owner_id,"
                "profiles(email),composition_items(id,item_type)"
            ),
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    out = []
    for r in rows:
        items = r.get("composition_items") or []
        prof = _embed_one(r.get("profiles"))
        # 题数只算真题，独立空白页条目不计入
        q_count = (
            len([i for i in items if (i or {}).get("item_type") != "blank_page"])
            if isinstance(items, list)
            else 0
        )
        out.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "title": r.get("title"),
                "visibility": r.get("visibility"),
                "created_at": r.get("created_at"),
                "updated_at": r.get("updated_at"),
                "owner_id": r.get("owner_id"),
                "owner_email": (prof or {}).get("email") or "",
                "item_count": q_count,
            }
        )
    out.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
    return out


@router.get("/compositions/{composition_id}")
def composition_detail(composition_id: str):
    """单卷题目明细（题号/试卷/模块），按 sort_order 排序。"""
    import uuid as uuid_mod

    from backend.cloud import supabase as sb

    try:
        uuid_mod.UUID(composition_id)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="composition_id 无效") from None
    cfg = _require_cloud()
    try:
        rows = sb.select(
            cfg,
            "composition_items",
            columns=(
                "id,question_id,sort_order,item_type,blank_pages,score,"
                "questions(question_no,section,paper_id,papers(exam_code,filename))"
            ),
            filters={"composition_id": f"eq.{composition_id}"},
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    out = []
    for r in rows:
        q = _embed_one(r.get("questions"))
        paper = _embed_one((q or {}).get("papers")) if q else None
        out.append(
            {
                "id": r.get("id"),
                "question_id": r.get("question_id"),
                "sort_order": r.get("sort_order"),
                "item_type": r.get("item_type"),
                "blank_pages": r.get("blank_pages"),
                "score": r.get("score"),
                "question_no": (q or {}).get("question_no"),
                "section": (q or {}).get("section"),
                "exam_code": (paper or {}).get("exam_code") or (paper or {}).get("filename"),
            }
        )
    out.sort(key=lambda r: int(r.get("sort_order") or 0))
    return out


@router.get("/compositions/{composition_id}/pdf")
def export_composition_pdf(
    composition_id: str,
    request: Request,
    include_answers: bool | None = None,
):
    """云卷导出：数据取自云端，渲染复用本地组卷导出管线（export.py 的 job 流程 + 本地题图）。"""
    import uuid as uuid_mod

    from backend.cloud import supabase as sb

    _require_token(request)
    try:
        uuid_mod.UUID(composition_id)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="composition_id 无效") from None
    cfg = _require_cloud()

    # 1) 云端拉组卷设置与条目
    try:
        comp_rows = sb.select(
            cfg,
            "compositions",
            columns=(
                "name,title,header_text,footer_text,cover_lines,include_answers,"
                "answers_placement,show_page_numbers,show_question_info"
            ),
            filters={"id": f"eq.{composition_id}"},
        )
        if not comp_rows:
            raise HTTPException(status_code=404, detail="组卷不存在")
        comp = comp_rows[0]
        items = sb.select(
            cfg,
            "composition_items",
            columns="sort_order,item_type,blank_pages,question_id",
            filters={"composition_id": f"eq.{composition_id}"},
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    items.sort(key=lambda r: int(r.get("sort_order") or 0))

    # 2) 条目 → 题目 id 序列 + 每题后空白页（独立空白项并入前一题；
    #    本地导出的 ids 是纯题目序列，无法表达“无题空白”）
    ids: list[int] = []
    blanks: list[int] = []
    for it in items:
        if it.get("item_type") == "blank_page":
            if blanks:
                blanks[-1] += max(1, int(it.get("blank_pages") or 1))
            continue
        qid = it.get("question_id")
        if not qid:
            continue
        ids.append(int(qid))
        blanks.append(max(0, int(it.get("blank_pages") or 0)))
    if not ids:
        raise HTTPException(status_code=400, detail="组卷没有可导出的题目")

    # 3) 云卷设置 → 本地 ExportOptions
    show_info = bool(comp.get("show_question_info", True))
    cover_lines: list[str] | None = None
    if comp.get("cover_lines"):
        try:
            parsed = json.loads(comp["cover_lines"])
            if isinstance(parsed, list):
                cover_lines = [str(x) for x in parsed]
        except (ValueError, TypeError):
            cover_lines = None
    use_answers = bool(comp.get("include_answers")) if include_answers is None else include_answers
    options = ExportOptions(
        include_question_no=show_info,
        include_section=show_info,
        include_paper=show_info,
        include_answers=use_answers,
        answers_placement=str(comp.get("answers_placement") or "end"),
        filename=str(comp.get("name") or "") or None,
        title=comp.get("title") or None,
        header_text=comp.get("header_text") or None,
        footer_text=comp.get("footer_text") or None,
        cover_lines=cover_lines,
        blank_pages_per_question=blanks,
        # 组卷的空白页完全按卷内设置来，关掉“占比≥70%自动补页”（否则与手动空白重复）
        auto_blank_on_tall=False,
        show_page_numbers=bool(comp.get("show_page_numbers", True)),
    )

    # 4) 走本地组卷导出：入队 → 等待完成 → 复用现成下载
    try:
        created = create_export_job(ExportRequest(ids=ids, options=options), BackgroundTasks())
        job_id = str(created["job_id"])
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from None

    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            status = check_export_status(job_id)
        except HTTPException:
            time.sleep(0.3)
            continue
        state = str(status.get("status") or "")
        if state == "done":
            return download_export_file(job_id)
        if state in {"error", "cancelled"}:
            raise HTTPException(status_code=500, detail=str(status.get("message") or "导出失败"))
        time.sleep(0.3)
    raise HTTPException(status_code=504, detail="导出超时，请稍后重试")


# ---------------------------------------------------------------------------
# 全局设置：网页浏览水印 + 导出水印（app_config key = 'export'）
# 结构：{enabled: bool, mode: 'preset'|'custom', text: string}
#   preset：浏览 = {email} 平铺；导出 = {email} {date} 斜向
#   custom：使用 text，支持 {email}/{date} 占位符
# ---------------------------------------------------------------------------

_WM_DEFAULTS = {"export_watermark": False, "browse_watermark": True}
_WM_MODES = {"preset", "custom"}
_WM_MAX_TEXT = 200


def _wm_shape(raw: object, key: str) -> dict:
    """把存储值规整为完整水印配置（缺字段用默认补）。"""
    d = raw if isinstance(raw, dict) else {}
    mode = d.get("mode") if d.get("mode") in _WM_MODES else "preset"
    return {
        "enabled": bool(d.get("enabled", _WM_DEFAULTS[key])),
        "mode": mode,
        "text": str(d.get("text") or "")[:_WM_MAX_TEXT],
    }


def _wm_patch(payload: object, key: str) -> dict:
    """校验 PATCH 传入的水印子对象（部分字段更新）。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail=f"{key} 必须是对象")
    out: dict = {}
    if "enabled" in payload:
        out["enabled"] = bool(payload["enabled"])
    if "mode" in payload:
        if payload["mode"] not in _WM_MODES:
            raise HTTPException(status_code=400, detail="mode 必须是 preset/custom")
        out["mode"] = payload["mode"]
    if "text" in payload:
        text = str(payload["text"] or "")
        if len(text) > _WM_MAX_TEXT:
            raise HTTPException(status_code=400, detail=f"text 最长 {_WM_MAX_TEXT} 字符")
        out["text"] = text
    if not out:
        raise HTTPException(status_code=400, detail="没有可更新的字段")
    return out


def _read_settings_value() -> dict:
    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    try:
        rows = sb.select(cfg, "app_config", columns="value", filters={"key": "eq.export"})
    except sb.SupabaseError as exc:
        # 迁移 0004 尚未执行时给出默认值，避免整页报错
        logger.warning("app_config select failed, using defaults: %s", exc)
        rows = []
    if rows and isinstance(rows[0].get("value"), dict):
        return rows[0]["value"]
    return {}


@router.get("/settings")
def get_settings():
    value = _read_settings_value()
    return {
        "export_watermark": _wm_shape(value.get("export_watermark"), "export_watermark"),
        "browse_watermark": _wm_shape(value.get("browse_watermark"), "browse_watermark"),
    }


@router.patch("/settings")
def update_settings(payload: dict, request: Request):
    _require_token(request)
    updates: dict[str, dict] = {}
    for key in ("export_watermark", "browse_watermark"):
        if key in payload:
            updates[key] = _wm_patch(payload[key], key)
    if not updates:
        raise HTTPException(status_code=400, detail="没有可更新的字段")

    from backend.cloud import supabase as sb

    cfg = _require_cloud()
    current = _read_settings_value()
    merged = dict(current)
    for key, patch in updates.items():
        merged[key] = {**_wm_shape(current.get(key), key), **patch}
    try:
        sb.upsert(cfg, "app_config", [{"key": "export", "value": merged}], on_conflict="key")
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return {"ok": True, **{key: merged[key] for key in updates}}
