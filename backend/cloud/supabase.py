"""Supabase PostgREST 最小客户端（stdlib urllib，无三方依赖）。

同步专用：全部使用 service role key（绕过 RLS，仅标注端单管理员机器持有）。

过滤器约定：filters 的值是 PostgREST 完整表达式，如
    {"id": "eq.5"}、{"id": "in.(1,2,3)"}、{"deleted_at": "is.null"}
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from backend.cloud.config import CloudConfig

_TIMEOUT_S = 120
_BATCH = 400


class SupabaseError(RuntimeError):
    def __init__(self, status: int, method: str, url: str, body: str):
        super().__init__(f"Supabase {method} {url} -> HTTP {status}: {body[:300]}")
        self.status = status


def _headers(cfg: CloudConfig, extra: dict | None = None) -> dict:
    h = {
        "apikey": cfg.service_role_key,
        "Authorization": f"Bearer {cfg.service_role_key}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def _request(
    cfg: CloudConfig,
    method: str,
    path: str,
    payload: bytes | None = None,
    extra_headers: dict | None = None,
) -> tuple[int, bytes]:
    url = f"{cfg.supabase_url}/rest/v1/{path}"
    req = urllib.request.Request(url, data=payload, method=method, headers=_headers(cfg, extra_headers))
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _raise(cfg: CloudConfig, method: str, path: str, status: int, body: bytes) -> None:
    raise SupabaseError(status, method, path, body.decode("utf-8", "replace"))


def _query(columns: str, filters: dict[str, str] | None, limit: int | None) -> str:
    parts = [f"select={urllib.parse.quote(columns)}"]
    for col, expr in (filters or {}).items():
        parts.append(f"{urllib.parse.quote(col)}={urllib.parse.quote(expr, safe='.(),*')}")
    if limit is not None:
        parts.append(f"limit={int(limit)}")
    return "&".join(parts)


def select(
    cfg: CloudConfig,
    table: str,
    columns: str = "*",
    filters: dict[str, str] | None = None,
    limit: int | None = None,
) -> list[dict]:
    path = f"{table}?{_query(columns, filters, limit)}"
    status, body = _request(cfg, "GET", path)
    if status >= 400:
        _raise(cfg, "GET", path, status, body)
    if not body.strip():
        return []
    return json.loads(body)


def insert(cfg: CloudConfig, table: str, rows: list[dict]) -> None:
    """POST 插入；主键冲突直接报错（调用方保证只插新行）。"""
    if not rows:
        return
    for i in range(0, len(rows), _BATCH):
        chunk = rows[i : i + _BATCH]
        payload = json.dumps(chunk, ensure_ascii=False).encode("utf-8")
        status, body = _request(cfg, "POST", table, payload, {"Prefer": "return=minimal"})
        if status >= 400:
            _raise(cfg, "POST", table, status, body)


def upsert(cfg: CloudConfig, table: str, rows: list[dict], on_conflict: str = "id") -> None:
    """按 on_conflict 列做 merge-duplicates upsert（幂等推送的核心）。"""
    if not rows:
        return
    path = f"{table}?on_conflict={urllib.parse.quote(on_conflict)}"
    headers = {"Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(rows), _BATCH):
        chunk = rows[i : i + _BATCH]
        payload = json.dumps(chunk, ensure_ascii=False).encode("utf-8")
        status, body = _request(cfg, "POST", path, payload, headers)
        if status >= 400:
            _raise(cfg, "POST", path, status, body)


def patch(cfg: CloudConfig, table: str, filters: dict[str, str], body: dict) -> int:
    """按过滤器批量 PATCH，返回受影响行数。拒绝空过滤器（防全表更新）。"""
    if not filters:
        raise ValueError("patch requires at least one filter")
    qs = "&".join(
        f"{urllib.parse.quote(col)}={urllib.parse.quote(expr, safe='.(),*')}"
        for col, expr in filters.items()
    )
    path = f"{table}?{qs}"
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    status, resp = _request(cfg, "PATCH", path, payload, {"Prefer": "return=representation"})
    if status >= 400:
        _raise(cfg, "PATCH", path, status, resp)
    return len(json.loads(resp)) if resp.strip() else 0


def delete_filtered(cfg: CloudConfig, table: str, filters: dict[str, str]) -> int:
    if not filters:
        raise ValueError("delete requires at least one filter")
    qs = "&".join(
        f"{urllib.parse.quote(col)}={urllib.parse.quote(expr, safe='.(),*')}"
        for col, expr in filters.items()
    )
    path = f"{table}?{qs}"
    status, resp = _request(cfg, "DELETE", path, None, {"Prefer": "return=representation"})
    if status >= 400:
        _raise(cfg, "DELETE", path, status, resp)
    return len(json.loads(resp)) if resp.strip() else 0


def _auth_request(
    cfg: CloudConfig,
    method: str,
    path: str,
    payload: dict | None = None,
) -> tuple[int, dict]:
    url = f"{cfg.supabase_url}/auth/v1/{path.lstrip('/')}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=_headers(cfg))
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            parsed = json.loads(body) if body.strip() else {}
        except Exception:
            parsed = {"message": body.decode("utf-8", "replace")[:300]}
        return exc.code, parsed


def admin_create_user(cfg: CloudConfig, email: str, password: str, *, email_confirm: bool = True) -> dict:
    """Create an auth user via GoTrue admin API (service role)."""
    status, body = _auth_request(
        cfg,
        "POST",
        "admin/users",
        {"email": email, "password": password, "email_confirm": email_confirm},
    )
    if status >= 400:
        raise SupabaseError(status, "POST", "auth/v1/admin/users", json.dumps(body, ensure_ascii=False))
    return body


def admin_invite_user(cfg: CloudConfig, email: str, redirect_to: str | None = None) -> dict:
    """Send an invite email; the link lets the user set their own password."""
    payload: dict = {"email": email}
    if redirect_to:
        payload["redirect_to"] = redirect_to
    status, body = _auth_request(cfg, "POST", "invite", payload)
    if status >= 400:
        raise SupabaseError(status, "POST", "auth/v1/invite", json.dumps(body, ensure_ascii=False))
    return body


def admin_generate_invite_link(cfg: CloudConfig, email: str, redirect_to: str | None = None) -> str:
    """Fallback when SMTP is unavailable: return the invite URL for manual send."""
    options: dict = {}
    if redirect_to:
        options["redirect_to"] = redirect_to
    payload: dict = {"type": "invite", "email": email}
    if options:
        payload["options"] = options
    status, body = _auth_request(cfg, "POST", "admin/generate_link", payload)
    if status >= 400:
        raise SupabaseError(status, "POST", "auth/v1/admin/generate_link", json.dumps(body, ensure_ascii=False))
    return str(body.get("action_link") or body.get("action_link".replace("_", "")) or "")


def admin_delete_user(cfg: CloudConfig, user_id: str) -> None:
    status, body = _auth_request(cfg, "DELETE", f"admin/users/{user_id}")
    if status >= 400:
        raise SupabaseError(status, "DELETE", f"auth/v1/admin/users/{user_id}", json.dumps(body, ensure_ascii=False))


def admin_set_banned(cfg: CloudConfig, user_id: str, banned: bool) -> dict:
    """停用/启用账号（GoTrue admin API）。

    banned=True  → ban_duration=876000h（100 年，等效永久封禁）
    banned=False → ban_duration=0s（time.ParseDuration 通用解析，
                   banned_until=now 即立即解封，兼容所有 GoTrue 版本）
    被封禁用户无法登录，refresh token 全部失效。
    """
    payload = {"ban_duration": "876000h" if banned else "0s"}
    status, body = _auth_request(cfg, "PUT", f"admin/users/{user_id}", payload)
    if status >= 400:
        raise SupabaseError(
            status,
            "PUT",
            f"auth/v1/admin/users/{user_id}",
            json.dumps(body, ensure_ascii=False),
        )
    return body
