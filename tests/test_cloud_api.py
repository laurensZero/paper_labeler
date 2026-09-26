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
    res = client.delete("/cloud/grants/1")
    assert res.status_code in (401, 403), f"DELETE /cloud/grants -> {res.status_code}"
