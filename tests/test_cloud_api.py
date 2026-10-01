"""API-level tests for /cloud/* (token gate + status shape)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import cloud as cloud_router


client = TestClient(app)


@pytest.fixture()
def no_token(monkeypatch):
    monkeypatch.setattr(cloud_router, "get_cloud_token", lambda: "")
    monkeypatch.setattr("backend.cloud.config.get_cloud_token", lambda: "")


@pytest.fixture()
def with_token(monkeypatch):
    monkeypatch.setattr(cloud_router, "get_cloud_token", lambda: "secret")
    monkeypatch.setattr("backend.cloud.config.get_cloud_token", lambda: "secret")


def test_config_exposes_token_flag(with_token):
    res = client.get("/cloud/config")
    assert res.status_code == 200
    body = res.json()
    assert "enabled" in body
    assert "token_configured" in body
    assert body["token_configured"] is True
    assert body["management_disabled"] is False
    # 图形化配置表单回显字段齐全
    assert set(body["form"]) == {
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET",
        "R2_PUBLIC_BASE",
        "PAPER_CLOUD_ENABLED",
        "PAPER_CLOUD_TOKEN",
    }


def test_config_without_token_marks_management_disabled(no_token):
    res = client.get("/cloud/config")
    assert res.status_code == 200
    body = res.json()
    assert body["token_configured"] is False
    assert body["management_disabled"] is True


def test_sync_status_public_read():
    res = client.get("/cloud/sync/status")
    assert res.status_code == 200
    body = res.json()
    assert "running" in body
    assert "token_configured" in body


def test_sync_status_disk_state_normalized(monkeypatch):
    # 重启后前端靠 disk_state 回显「上次同步」；旧落盘文件只有 success，需归一化出 ok
    monkeypatch.setattr(
        cloud_router,
        "load_sync_state",
        lambda: {"success": True, "duration_s": 12, "counts": {}, "errors": [], "error_count": 0},
    )
    res = client.get("/cloud/sync/status")
    assert res.status_code == 200
    disk = res.json()["disk_state"]
    assert disk is not None
    assert disk["ok"] is True


def test_start_sync_requires_token_when_unset(no_token):
    res = client.post("/cloud/sync")
    assert res.status_code == 403


def test_start_sync_rejects_wrong_token(with_token):
    res = client.post("/cloud/sync", headers={"X-Paper-Token": "nope"})
    assert res.status_code == 401


def test_start_sync_accepts_token_but_may_400_when_disabled(with_token, monkeypatch):
    monkeypatch.setattr("backend.routers.cloud.cloud_enabled", lambda: False)
    res = client.post("/cloud/sync", headers={"X-Paper-Token": "secret"})
    # token passed; sync itself may be disabled without cloud env
    assert res.status_code in (200, 400, 409)
    if res.status_code == 400:
        assert "开启" in res.json().get("detail", "") or "PAPER_CLOUD" in res.json().get("detail", "")


def test_start_sync_dry_run_flag_reaches_background(with_token, monkeypatch):
    """/cloud/sync?dry_run=true 必须把试算标志传到后台线程。"""
    import backend.routers.cloud as router

    monkeypatch.setattr(router, "cloud_enabled", lambda: True)
    monkeypatch.setattr(router, "missing_config", lambda cfg: [])
    monkeypatch.setattr(router, "get_cloud_config", lambda: object())
    seen: list = []

    class _FakeThread:
        def __init__(self, target=None, args=(), daemon=None, name=None):
            seen.append(args)

        def start(self):
            pass

    monkeypatch.setattr(router.threading, "Thread", _FakeThread)
    # 清掉可能残留的运行中状态，避免 409
    router._state["running"] = False

    res = client.post("/cloud/sync?dry_run=true", headers={"X-Paper-Token": "secret"})

    assert res.status_code == 200
    assert res.json()["dry_run"] is True
    assert seen and seen[0][1] is True  # (summary, dry_run)
    assert seen[0][0].dry_run is True
    router._state["running"] = False


def test_admin_write_endpoints_rejected_without_token(no_token):
    res = client.post("/cloud/grants", json={"scope": "paper", "scope_value": "1", "user_id": "00000000-0000-0000-0000-000000000000"})
    assert res.status_code in (401, 403), f"POST /cloud/grants -> {res.status_code}"
    res = client.patch("/cloud/profiles/00000000-0000-0000-0000-000000000000", json={"role": "admin"})
    assert res.status_code in (401, 403), f"PATCH /cloud/profiles -> {res.status_code}"
    res = client.patch("/cloud/suggestions/1", json={"status": "accepted"})
    assert res.status_code in (401, 403), f"PATCH /cloud/suggestions -> {res.status_code}"
    res = client.delete("/cloud/suggestions/1")
    assert res.status_code in (401, 403), f"DELETE /cloud/suggestions -> {res.status_code}"
    res = client.delete("/cloud/grants/1")
    assert res.status_code in (401, 403), f"DELETE /cloud/grants -> {res.status_code}"
    res = client.post("/cloud/users", json={"email": "a@b.com", "password": "12345678"})
    assert res.status_code in (401, 403), f"POST /cloud/users -> {res.status_code}"


def test_delete_suggestion_requires_token(no_token):
    res = client.delete("/cloud/suggestions/9")
    assert res.status_code == 403


def test_create_user_validates_payload(with_token, monkeypatch):
    monkeypatch.setattr("backend.routers.cloud.cloud_enabled", lambda: True)

    class _Cfg:
        supabase_url = "https://x.supabase.co"
        service_role_key = "svc"
        r2_account_id = "a"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "b"
        r2_public_base = "https://pub"

    monkeypatch.setattr("backend.routers.cloud.get_cloud_config", lambda: _Cfg())

    res = client.post(
        "/cloud/users",
        json={"email": "bad", "role": "teacher"},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 400

    res = client.post(
        "/cloud/users",
        json={"email": "ok@example.com", "role": "root"},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 400


def test_create_user_invite_flow_with_token(with_token, monkeypatch):
    monkeypatch.setattr("backend.routers.cloud.cloud_enabled", lambda: True)

    class _Cfg:
        supabase_url = "https://x.supabase.co"
        service_role_key = "svc"
        r2_account_id = "a"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "b"
        r2_public_base = "https://pub"

    monkeypatch.setattr("backend.routers.cloud.get_cloud_config", lambda: _Cfg())

    from backend.cloud import supabase as sb

    monkeypatch.setattr(sb, "admin_invite_user", lambda cfg, email, redirect_to=None: {"id": "uid-1", "email": email})
    monkeypatch.setattr(sb, "select", lambda cfg, table, **k: [{"id": "uid-1"}])
    monkeypatch.setattr(sb, "patch", lambda cfg, table, filters, body: 1)

    res = client.post(
        "/cloud/users",
        json={"email": "ok@example.com", "role": "teacher", "can_see_drafts": True},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["email"] == "ok@example.com"
    assert body["invited"] is True
    assert body["invite_url"] is None


# ---------------------------------------------------------------------------
# 限额（profiles.max_*）与全局设置（app_config 水印开关）
# ---------------------------------------------------------------------------

_UID = "00000000-0000-0000-0000-000000000000"


def _enable_cloud(monkeypatch):
    monkeypatch.setattr("backend.routers.cloud.cloud_enabled", lambda: True)

    class _Cfg:
        supabase_url = "https://x.supabase.co"
        service_role_key = "svc"
        r2_account_id = "a"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "b"
        r2_public_base = "https://pub"
        web_url = "https://web.example.com"

    monkeypatch.setattr("backend.routers.cloud.get_cloud_config", lambda: _Cfg())


def test_patch_profile_quota_validation(with_token, monkeypatch):
    _enable_cloud(monkeypatch)
    from backend.cloud import supabase as sb

    patched: list[dict] = []
    monkeypatch.setattr(sb, "patch", lambda cfg, table, filters, body: (patched.append(body) or 1))

    res = client.patch(
        f"/cloud/profiles/{_UID}", json={"max_compositions": -1}, headers={"X-Paper-Token": "secret"}
    )
    assert res.status_code == 400

    res = client.patch(
        f"/cloud/profiles/{_UID}", json={"max_exports_per_week": "10"}, headers={"X-Paper-Token": "secret"}
    )
    assert res.status_code == 400

    res = client.patch(
        f"/cloud/profiles/{_UID}",
        json={"max_compositions": None, "max_exports_per_month": 10, "max_export_items": 30},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 200, res.text
    assert patched == [
        {"max_compositions": None, "max_exports_per_month": 10, "max_export_items": 30}
    ]


def test_settings_requires_token(no_token):
    res = client.patch("/cloud/settings", json={"export_watermark": {"enabled": True}})
    assert res.status_code in (401, 403)


def test_settings_validates_and_roundtrips(with_token, monkeypatch):
    _enable_cloud(monkeypatch)
    from backend.cloud import supabase as sb

    res = client.patch("/cloud/settings", json={}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 400

    res = client.patch(
        "/cloud/settings",
        json={"export_watermark": {"mode": "fancy"}},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 400

    upserts: list[list[dict]] = []
    monkeypatch.setattr(
        sb, "upsert", lambda cfg, table, rows, on_conflict="id": upserts.append(list(rows))
    )
    # 未建行时：先读到空，merge 后落库
    monkeypatch.setattr(sb, "select", lambda cfg, table, **k: [])
    res = client.patch(
        "/cloud/settings",
        json={"export_watermark": {"enabled": True, "mode": "custom", "text": "{email} 机密"}},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 200, res.text
    wm = res.json()["export_watermark"]
    assert wm == {"enabled": True, "mode": "custom", "text": "{email} 机密"}
    stored = upserts[0][0]["value"]["export_watermark"]
    assert stored["enabled"] is True and stored["mode"] == "custom"

    # 部分字段更新：只改 enabled，保留 mode/text
    upserts.clear()
    monkeypatch.setattr(
        sb,
        "select",
        lambda cfg, table, **k: [
            {
                "value": {
                    "export_watermark": {"enabled": True, "mode": "custom", "text": "abc"},
                    "browse_watermark": {"enabled": False, "mode": "preset", "text": ""},
                }
            }
        ],
    )
    res = client.patch(
        "/cloud/settings",
        json={"browse_watermark": {"enabled": True}},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["browse_watermark"] == {"enabled": True, "mode": "preset", "text": ""}

    # 模拟落库后的状态再读
    monkeypatch.setattr(
        sb,
        "select",
        lambda cfg, table, **k: [
            {
                "value": {
                    "export_watermark": {"enabled": True, "mode": "custom", "text": "abc"},
                    "browse_watermark": {"enabled": True, "mode": "preset", "text": ""},
                }
            }
        ],
    )
    res = client.get("/cloud/settings")
    assert res.status_code == 200
    body = res.json()
    assert body["export_watermark"]["mode"] == "custom"
    assert body["browse_watermark"]["enabled"] is True

    # 无行时返回默认：导出水印关、浏览水印开、均为预设
    monkeypatch.setattr(sb, "select", lambda cfg, table, **k: [])
    res = client.get("/cloud/settings")
    body = res.json()
    assert body["export_watermark"] == {"enabled": False, "mode": "preset", "text": ""}
    assert body["browse_watermark"] == {"enabled": True, "mode": "preset", "text": ""}


def test_profiles_include_quota_usage(with_token, monkeypatch):
    _enable_cloud(monkeypatch)
    from datetime import datetime, timezone

    from backend.cloud import supabase as sb

    now_iso = datetime.now(timezone.utc).isoformat()
    old_iso = "2020-01-01T00:00:00+00:00"

    def fake_select(cfg, table, columns="", **k):
        if table == "profiles":
            return [
                {
                    "id": _UID,
                    "email": "a@b.com",
                    "role": "teacher",
                    "can_see_drafts": False,
                    "created_at": "2026-01-01T00:00:00Z",
                    "max_compositions": 3,
                    "max_exports_per_week": 5,
                    "max_exports_per_month": None,
                    "max_export_items": 30,
                }
            ]
        if table == "compositions":
            return [{"owner_id": _UID}, {"owner_id": _UID}]
        if table == "export_jobs":
            return [
                {"requested_by": _UID, "status": "done", "created_at": now_iso},
                {"requested_by": _UID, "status": "failed", "created_at": now_iso},
                {"requested_by": _UID, "status": "done", "created_at": old_iso},
            ]
        raise AssertionError(f"unexpected table {table}")

    monkeypatch.setattr(sb, "select", fake_select)
    res = client.get("/cloud/profiles")
    assert res.status_code == 200, res.text
    row = res.json()[0]
    assert row["max_compositions"] == 3
    assert row["max_exports_per_week"] == 5
    assert row["max_exports_per_month"] is None
    assert row["max_export_items"] == 30
    assert row["composition_count"] == 2
    assert row["export_count_week"] == 1  # failed 不计；去年的不进本周期
    assert row["export_count_month"] == 1


# ---------------------------------------------------------------------------
# 组卷查看（列表 + 明细）
# ---------------------------------------------------------------------------

def test_compositions_list_sorted_with_owner(with_token, monkeypatch):
    _enable_cloud(monkeypatch)
    from backend.cloud import supabase as sb

    rows = [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "old",
            "title": None,
            "visibility": "private",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "owner_id": _UID,
            "profiles": {"email": "a@b.com"},
            "composition_items": [{"id": 1}, {"id": 2}],
        },
        {
            "id": "22222222-2222-2222-2222-222222222222",
            "name": "new",
            "title": "T",
            "visibility": "shared",
            "created_at": "2026-02-01T00:00:00Z",
            "updated_at": "2026-02-01T00:00:00Z",
            "owner_id": _UID,
            "profiles": [{"email": "c@d.com"}],
            "composition_items": [],
        },
    ]
    monkeypatch.setattr(sb, "select", lambda cfg, table, **k: rows)
    res = client.get("/cloud/compositions")
    assert res.status_code == 200, res.text
    body = res.json()
    assert [r["name"] for r in body] == ["new", "old"]  # updated_at 倒序
    assert body[1]["item_count"] == 2
    assert body[1]["owner_email"] == "a@b.com"
    assert body[0]["owner_email"] == "c@d.com"


def test_composition_detail_validates_uuid(with_token):
    res = client.get("/cloud/compositions/not-a-uuid")
    assert res.status_code == 400


def test_composition_detail_sorted(with_token, monkeypatch):
    _enable_cloud(monkeypatch)
    from backend.cloud import supabase as sb

    rows = [
        {
            "id": 2,
            "sort_order": 20,
            "item_type": "question",
            "blank_pages": 0,
            "score": 5,
            "questions": {"question_no": "12", "section": "函数", "paper_id": 1, "papers": {"exam_code": "2024A"}},
        },
        {
            "id": 1,
            "sort_order": 10,
            "item_type": "blank_page",
            "blank_pages": 2,
            "score": None,
            "questions": None,
        },
    ]
    monkeypatch.setattr(sb, "select", lambda cfg, table, **k: rows)
    res = client.get("/cloud/compositions/11111111-1111-1111-1111-111111111111")
    assert res.status_code == 200, res.text
    body = res.json()
    assert [r["id"] for r in body] == [1, 2]  # sort_order 升序
    assert body[1]["exam_code"] == "2024A"
    assert body[0]["item_type"] == "blank_page"


def test_composition_pdf_requires_token(no_token):
    res = client.get("/cloud/compositions/11111111-1111-1111-1111-111111111111/pdf")
    assert res.status_code in (401, 403)


def test_composition_pdf_reuses_local_export(with_token, monkeypatch):
    """云卷导出必须复用本地组卷导出 job（create → status → download）。"""
    from fastapi import Response

    from backend.cloud import supabase as sb

    _enable_cloud(monkeypatch)
    cid = "11111111-1111-1111-1111-111111111111"

    def fake_select(cfg, table, columns="", filters=None, **k):
        if table == "compositions":
            return [
                {
                    "name": "月考卷",
                    "title": "标题",
                    "header_text": None,
                    "footer_text": "页脚",
                    "cover_lines": '["姓名：____"]',
                    "include_answers": True,
                    "answers_placement": "end",
                    "show_page_numbers": True,
                    "show_question_info": True,
                }
            ]
        if table == "composition_items":
            return [
                {"sort_order": 1, "item_type": "question", "blank_pages": 0, "question_id": 7},
                {"sort_order": 2, "item_type": "blank_page", "blank_pages": 1, "question_id": None},
                {"sort_order": 3, "item_type": "question", "blank_pages": 2, "question_id": 8},
            ]
        raise AssertionError(f"unexpected table {table}")

    monkeypatch.setattr(sb, "select", fake_select)

    captured: dict = {}

    def fake_create(req, _bt):
        captured["req"] = req
        return {"job_id": "job_test"}

    monkeypatch.setattr(cloud_router, "create_export_job", fake_create)
    monkeypatch.setattr(cloud_router, "check_export_status", lambda jid: {"status": "done"})
    monkeypatch.setattr(
        cloud_router,
        "download_export_file",
        lambda jid: Response(content=b"%PDF-1.4 cloud", media_type="application/pdf"),
    )

    res = client.get(f"/cloud/compositions/{cid}/pdf", headers={"X-Paper-Token": "secret"})
    assert res.status_code == 200, res.text
    assert res.content[:4] == b"%PDF"

    req = captured["req"]
    # 题目顺序保留；独立空白页并入前一题（7 号题后 +1 页，8 号题自带 2 页）
    assert req.ids == [7, 8]
    assert req.options.blank_pages_per_question == [1, 2]
    assert req.options.include_answers is True
    assert req.options.title == "标题"
    assert req.options.cover_lines == ["姓名：____"]
    assert req.options.filename == "月考卷"
    # 组卷导出关闭“占比≥70%自动补空白页”（否则与卷内手动空白页重复）
    assert req.options.auto_blank_on_tall is False


# ---------------------------------------------------------------------------
# 停用用户（is_active + GoTrue ban）与邀请回跳
# ---------------------------------------------------------------------------


def test_update_profile_ban_unban(with_token, monkeypatch):
    _enable_cloud(monkeypatch)
    from backend.cloud import supabase as sb

    monkeypatch.setattr(sb, "patch", lambda cfg, table, filters, body: 1)
    bans: list[bool] = []
    monkeypatch.setattr(sb, "admin_set_banned", lambda cfg, uid, banned: bans.append(banned) or {})

    res = client.patch(
        f"/cloud/profiles/{_UID}", json={"is_active": False}, headers={"X-Paper-Token": "secret"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["is_active"] is False

    res = client.patch(
        f"/cloud/profiles/{_UID}", json={"is_active": True}, headers={"X-Paper-Token": "secret"}
    )
    assert res.status_code == 200
    assert bans == [True, False]


def test_update_profile_ban_failure_502(with_token, monkeypatch):
    from backend.cloud import supabase as sb

    _enable_cloud(monkeypatch)
    monkeypatch.setattr(sb, "patch", lambda cfg, table, filters, body: 1)

    def _boom(cfg, uid, banned):
        raise sb.SupabaseError(400, "PUT", "auth/v1/admin/users/x", "bad")

    monkeypatch.setattr(sb, "admin_set_banned", _boom)
    res = client.patch(
        f"/cloud/profiles/{_UID}", json={"is_active": False}, headers={"X-Paper-Token": "secret"}
    )
    assert res.status_code == 502
    assert "封禁" in res.json()["detail"]


def test_profiles_include_is_active(with_token, monkeypatch):
    from backend.cloud import supabase as sb

    _enable_cloud(monkeypatch)
    monkeypatch.setattr(
        sb,
        "select",
        lambda cfg, table, **k: (
            [
                {
                    "id": _UID,
                    "email": "a@b.com",
                    "role": "teacher",
                    "can_see_drafts": False,
                    "is_active": False,
                    "created_at": "2026-01-01T00:00:00Z",
                    "max_compositions": None,
                    "max_exports_per_week": None,
                    "max_exports_per_month": None,
                    "max_export_items": None,
                }
            ]
            if table == "profiles"
            else []
        ),
    )
    res = client.get("/cloud/profiles")
    assert res.status_code == 200
    assert res.json()[0]["is_active"] is False


# ---------------------------------------------------------------------------
# 图形化配置（PUT /cloud/config 写 .env）
# ---------------------------------------------------------------------------


def test_put_config_first_setup_open_without_token(monkeypatch):
    # token 未配置：放行作为首次配置入口
    monkeypatch.setattr(cloud_router, "get_cloud_token", lambda: "")
    monkeypatch.setattr("backend.cloud.config.get_cloud_token", lambda: "")
    saved: dict = {}
    monkeypatch.setattr(cloud_router, "save_env_values", lambda v: saved.update(v))
    res = client.put("/cloud/config", json={"PAPER_CLOUD_ENABLED": "1"})
    assert res.status_code == 200, res.text
    assert saved == {"PAPER_CLOUD_ENABLED": "1"}


def test_put_config_protected_when_token_set(with_token, monkeypatch):
    saved: dict = {}
    monkeypatch.setattr(cloud_router, "save_env_values", lambda v: saved.update(v))
    res = client.put("/cloud/config", json={"SUPABASE_URL": "https://x.supabase.co"})
    assert res.status_code in (401, 403)
    res = client.put(
        "/cloud/config",
        json={"SUPABASE_URL": "https://x.supabase.co"},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 200, res.text
    assert saved["SUPABASE_URL"] == "https://x.supabase.co"
    assert res.json()["ok"] is True


def test_put_config_validates(with_token, monkeypatch):
    def _no_save(v):
        raise AssertionError("should not save")

    monkeypatch.setattr(cloud_router, "save_env_values", _no_save)
    res = client.put("/cloud/config", json={}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 400
    res = client.put(
        "/cloud/config", json={"PAPER_CLOUD_ENABLED": "2"}, headers={"X-Paper-Token": "secret"}
    )
    assert res.status_code == 400
