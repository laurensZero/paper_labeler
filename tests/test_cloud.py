"""云端同步模块的离线测试（不触网）。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.cloud.config import CloudConfig, missing_config
from backend.cloud.sync import (
    SyncSummary,
    _is_dirty,
    _iso,
    _parse_ts,
    _sync_link_rows,
    crop_fingerprint,
    crop_webp,
)


def _cfg(**overrides) -> CloudConfig:
    base = dict(
        supabase_url="https://x.supabase.co",
        service_role_key="svc",
        r2_account_id="acc",
        r2_access_key_id="kid",
        r2_secret_access_key="secret",
        r2_bucket="paper-labeler",
        r2_public_base="https://pub.x.r2.dev",
    )
    base.update(overrides)
    return CloudConfig(**base)


# ---------- config ----------


def test_missing_config_lists_empty_fields():
    cfg = _cfg(r2_account_id="", r2_public_base="")
    assert missing_config(cfg) == ["R2_ACCOUNT_ID", "R2_PUBLIC_BASE"]


def test_missing_config_all_present():
    assert missing_config(_cfg()) == []


def test_save_env_values_upsert_quote_and_clear(tmp_path, monkeypatch):
    import os

    from backend.cloud import config as cfgmod

    env_file = tmp_path / ".env"
    env_file.write_text(
        "# keep me\nSUPABASE_URL=https://old.example\nR2_BUCKET=paper-labeler\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(cfgmod, "_ROOT", tmp_path)
    # 预置 env 让 monkeypatch 在 teardown 恢复
    monkeypatch.setenv("SUPABASE_URL", "https://old.example")
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://old.pub")

    cfgmod.save_env_values({"SUPABASE_URL": "https://new.example", "R2_PUBLIC_BASE": "https://img x y"})
    text = env_file.read_text(encoding="utf-8")
    assert "# keep me" in text
    assert "SUPABASE_URL=https://new.example" in text
    assert 'R2_PUBLIC_BASE="https://img x y"' in text  # 含空格 → 加引号
    assert os.environ["SUPABASE_URL"] == "https://new.example"

    cfgmod.save_env_values({"SUPABASE_URL": ""})
    text = env_file.read_text(encoding="utf-8")
    assert "SUPABASE_URL=" in text
    assert "old.example" not in text and "new.example" not in text
    assert "SUPABASE_URL" not in os.environ


# ---------- 时间戳 ----------


def test_iso_parse_roundtrip_preserves_microseconds():
    dt = datetime(2026, 9, 25, 12, 30, 45, 123456, tzinfo=timezone.utc)
    s = _iso(dt)
    assert s is not None and s.endswith("Z")
    back = _parse_ts(s)
    assert back is not None and back == dt


def test_is_dirty_naive_local_treated_as_utc():
    local = datetime(2026, 9, 25, 8, 0, 0, 500000)  # naive = 本地库存法
    same = _iso(local)
    assert not _is_dirty(local, same)  # 完全相等 → 干净
    older = (local - timedelta(seconds=1)).isoformat() + "Z"
    newer = (local + timedelta(seconds=1)).isoformat() + "Z"
    assert _is_dirty(local, older)
    assert not _is_dirty(local, newer)


def test_is_dirty_when_cloud_missing_or_unparseable():
    assert _is_dirty(datetime(2026, 1, 1), None)
    assert _is_dirty(datetime(2026, 1, 1), "not-a-date")


# ---------- 裁剪 ----------


class _Box:
    def __init__(self, path, bbox):
        self.image_path = str(path)
        self.bbox = bbox
        self.id = 1
        self.page = 1


def test_crop_fingerprint_stable_then_changes_with_bbox(tmp_path):
    from PIL import Image

    img_path = tmp_path / "page_1.webp"
    Image.new("RGB", (40, 40), (255, 255, 255)).save(img_path)

    b1 = _Box(img_path, [0.1, 0.1, 0.9, 0.9])
    fp1 = crop_fingerprint(b1)
    fp2 = crop_fingerprint(_Box(img_path, [0.1, 0.1, 0.9, 0.9]))
    assert fp1 == fp2

    fp3 = crop_fingerprint(_Box(img_path, [0.1, 0.1, 0.9, 0.8]))
    assert fp3 != fp1


def test_crop_fingerprint_missing_file_is_stable(tmp_path):
    b = _Box(tmp_path / "nope.webp", [0, 0, 1, 1])
    assert crop_fingerprint(b) == crop_fingerprint(b)


def test_crop_webp_produces_webp_bytes(tmp_path):
    from PIL import Image

    img_path = tmp_path / "page_1.webp"
    Image.new("RGB", (100, 80), (10, 20, 30)).save(img_path)
    data = crop_webp(_Box(img_path, [0.0, 0.0, 0.5, 0.5]))
    assert data is not None and data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def test_crop_webp_missing_source_returns_none(tmp_path):
    assert crop_webp(_Box(tmp_path / "missing.webp", [0, 0, 1, 1])) is None


# ---------- R2 编码 / 签名 ----------


def test_r2_public_url_encodes_key():
    from backend.cloud.r2 import public_url

    url = public_url(_cfg(), "questions/12/box 1.webp")
    assert url == "https://pub.x.r2.dev/questions/12/box%201.webp"


def test_r2_signing_key_deterministic():
    from backend.cloud.r2 import _signing_key

    k1 = _signing_key("secret", "20260925")
    k2 = _signing_key("secret", "20260925")
    k3 = _signing_key("secret", "20260926")
    assert k1 == k2 and k1 != k3 and len(k1) == 32


# ---------- PostgREST query 构造 ----------


def test_supabase_query_encodes_filters():
    from backend.cloud.supabase import _query

    q = _query("id,source_updated_at", {"deleted_at": "is.null", "id": "in.(1,2,3)"}, None)
    # 括号/逗号是 PostgREST 语法字符，必须保留；列名逗号被编码
    assert q == "select=id%2Csource_updated_at&deleted_at=is.null&id=in.(1,2,3)"


# ---------- 链接表 diff ----------


def test_sync_link_rows_noop_when_identical(monkeypatch):
    from backend.cloud import sync as sync_mod

    calls = {"delete": 0, "insert": 0}
    monkeypatch.setattr(sync_mod.supabase, "delete_filtered", lambda *a, **k: calls.__setitem__("delete", calls["delete"] + 1))
    monkeypatch.setattr(sync_mod.supabase, "insert", lambda *a, **k: calls.__setitem__("insert", calls["insert"] + 1))

    summary = SyncSummary()
    _sync_link_rows(
        None,
        summary,
        table="question_sections",
        parent_col="question_id",
        desired=[(1, "A"), (2, "B")],
        cloud_rows=[(1, "A"), (2, "B")],
        row_factory=lambda p: {"question_id": p[0], "section_name": p[1]},
    )
    assert calls == {"delete": 0, "insert": 0}


def test_sync_link_rows_replaces_changed_parent(monkeypatch):
    from backend.cloud import sync as sync_mod

    deleted = []
    inserted = []
    monkeypatch.setattr(sync_mod.supabase, "delete_filtered", lambda cfg, table, filters: deleted.append(filters) or 0)
    monkeypatch.setattr(sync_mod.supabase, "insert", lambda cfg, table, rows: inserted.extend(rows))

    summary = SyncSummary()
    # 问题 1 的标签从 A 改为 C；问题 2 不变
    _sync_link_rows(
        None,
        summary,
        table="question_sections",
        parent_col="question_id",
        desired=[(1, "C"), (2, "B")],
        cloud_rows=[(1, "A"), (2, "B")],
        row_factory=lambda p: {"question_id": p[0], "section_name": p[1]},
    )
    assert deleted == [{"question_id": "eq.1"}]
    assert inserted == [{"question_id": 1, "section_name": "C"}]


def test_sync_summary_serializes_progress():
    summary = SyncSummary(phase="question_boxes")
    summary.set_progress(12, 7)

    payload = summary.to_dict()

    assert payload["progress_current"] == 7
    assert payload["progress_total"] == 12


# ---------- token / state ----------


def test_require_token_rejects_when_unset(monkeypatch):
    from fastapi import HTTPException
    from backend.routers import cloud as cloud_router

    monkeypatch.setattr(cloud_router, "get_cloud_token", lambda: "")

    class Req:
        headers = {}

    with pytest.raises(HTTPException) as ei:
        cloud_router._require_token(Req())
    assert ei.value.status_code == 403


def test_require_token_rejects_bad_or_missing(monkeypatch):
    from fastapi import HTTPException
    from backend.routers import cloud as cloud_router

    monkeypatch.setattr(cloud_router, "get_cloud_token", lambda: "secret")

    class Req:
        def __init__(self, headers):
            self.headers = headers

    with pytest.raises(HTTPException) as ei:
        cloud_router._require_token(Req({}))
    assert ei.value.status_code == 401

    with pytest.raises(HTTPException):
        cloud_router._require_token(Req({"X-Paper-Token": "wrong"}))

    with pytest.raises(HTTPException):
        cloud_router._require_token(Req({"Authorization": "Bearer wrong"}))


def test_require_token_accepts_bearer_and_header(monkeypatch):
    from backend.routers import cloud as cloud_router

    monkeypatch.setattr(cloud_router, "get_cloud_token", lambda: "secret")

    class Req:
        def __init__(self, headers):
            self.headers = headers

    cloud_router._require_token(Req({"X-Paper-Token": "secret"}))
    cloud_router._require_token(Req({"Authorization": "Bearer secret"}))


def test_sync_state_roundtrip(tmp_path, monkeypatch):
    from backend.cloud import state as cloud_state

    monkeypatch.setenv("PAPER_CLOUD_STATE_PATH", str(tmp_path / "state.json"))
    assert cloud_state.load_sync_state() == {}

    summary = {
        "ok": True,
        "phase": "done",
        "started_at": "2026-01-01T00:00:00Z",
        "finished_at": "2026-01-01T00:01:00Z",
        "duration_s": 60,
        "counts": {"papers_upserted": 2},
        "errors": ["x"],
        "error_count": 1,
        "resurrected": [3],
    }
    saved = cloud_state.record_sync_result(summary)
    assert saved["success"] is True
    assert saved["counts"]["papers_upserted"] == 2

    loaded = cloud_state.load_sync_state()
    assert loaded["success"] is True
    assert loaded["errors"] == ["x"]
    assert loaded["last_run"]
