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
