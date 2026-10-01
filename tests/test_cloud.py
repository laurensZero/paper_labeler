"""云端同步模块的离线测试（不触网）。"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend.cloud.config import CloudConfig, missing_config
from backend.cloud.sync import (
    SyncSummary,
    _is_dirty,
    _iso,
    _parse_ts,
    _sync_boxes,
    _sync_link_rows,
    crop_fingerprint,
    crop_fingerprint_legacy,
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


def test_crop_fingerprint_ignores_directory(tmp_path):
    """指纹不含绝对路径：同内容同 mtime 的页图放在不同目录应得到同一指纹。"""
    import os

    a_dir = tmp_path / "lib_a"
    b_dir = tmp_path / "lib_b"
    a_dir.mkdir()
    b_dir.mkdir()
    a = a_dir / "page_3.webp"
    b = b_dir / "page_3.webp"
    a.write_bytes(b"same-bytes")
    b.write_bytes(b"same-bytes")
    os.utime(a, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    os.utime(b, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

    assert crop_fingerprint(_Box(a, [0.1, 0.1, 0.5, 0.5])) == crop_fingerprint(
        _Box(b, [0.1, 0.1, 0.5, 0.5])
    )
    # 文件名仍参与指纹：换一个源文件不应被视为未变更
    c = b_dir / "page_4.webp"
    c.write_bytes(b"same-bytes")
    os.utime(c, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    assert crop_fingerprint(_Box(a, [0.1, 0.1, 0.5, 0.5])) != crop_fingerprint(
        _Box(c, [0.1, 0.1, 0.5, 0.5])
    )


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


def test_supabase_query_encodes_order_and_offset():
    from backend.cloud.supabase import _query

    assert _query("id", None, 1000, "id", 2000) == "select=id&order=id&limit=1000&offset=2000"


# ---------- select 分页（PostgREST 单次 1000 行上限） ----------


def _fake_request_factory(pages: list[list[dict]], paths: list[str]):
    def fake_request(cfg, method, path, payload=None, extra_headers=None):
        paths.append(path)
        idx = len(paths) - 1
        chunk = pages[idx] if idx < len(pages) else []
        return 200, json.dumps(chunk).encode("utf-8")

    return fake_request


def test_select_pages_through_postgrest_row_cap(monkeypatch):
    from backend.cloud import supabase as sb

    pages = [
        [{"id": i} for i in range(1, 1001)],
        [{"id": i} for i in range(1001, 1689)],
    ]
    paths: list[str] = []
    monkeypatch.setattr(sb, "_request", _fake_request_factory(pages, paths))

    rows = sb.select(_cfg(), "question_boxes", "id", order="id")

    assert len(rows) == 1688
    assert paths == [
        "question_boxes?select=id&order=id&limit=1000",
        "question_boxes?select=id&order=id&limit=1000&offset=1000",
    ]


def test_select_stops_on_exact_multiple_of_page(monkeypatch):
    from backend.cloud import supabase as sb

    pages = [[{"id": i} for i in range(1, 1001)], []]
    paths: list[str] = []
    monkeypatch.setattr(sb, "_request", _fake_request_factory(pages, paths))

    rows = sb.select(_cfg(), "papers", "id", order="id")

    assert len(rows) == 1000
    assert len(paths) == 2  # 满页后再探一次，拿到空页才收手


def test_select_with_explicit_limit_does_not_page(monkeypatch):
    from backend.cloud import supabase as sb

    paths: list[str] = []
    monkeypatch.setattr(sb, "_request", _fake_request_factory([[{"id": 1}]], paths))

    rows = sb.select(_cfg(), "question_boxes", "id", filters={"id": "eq.1"}, limit=5)

    assert rows == [{"id": 1}]
    assert paths == ["question_boxes?select=id&id=eq.1&limit=5"]


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
    monkeypatch.setattr(
        sync_mod.supabase,
        "upsert",
        lambda cfg, table, rows, **kwargs: inserted.extend(rows),
    )

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
    assert deleted == [{"question_id": "eq.1", "section_name": "eq.A"}]
    assert inserted == [{"question_id": 1, "section_name": "C"}]


def test_sync_link_rows_first_upload_does_not_delete(monkeypatch):
    from backend.cloud import sync as sync_mod

    deleted = []
    inserted = []
    monkeypatch.setattr(sync_mod.supabase, "delete_filtered", lambda *args: deleted.append(args))
    monkeypatch.setattr(
        sync_mod.supabase,
        "upsert",
        lambda cfg, table, rows, **kwargs: inserted.extend(rows),
    )

    summary = SyncSummary()
    _sync_link_rows(
        None,
        summary,
        table="question_sections",
        parent_col="question_id",
        desired=[(1, "A"), (2, "B")],
        cloud_rows=[],
        row_factory=lambda p: {"question_id": p[0], "section_name": p[1]},
    )

    assert deleted == []
    assert sorted(inserted, key=lambda row: row["question_id"]) == [
        {"question_id": 1, "section_name": "A"},
        {"question_id": 2, "section_name": "B"},
    ]


class _SyncBox:
    """_sync_boxes 需要的最小框图（指纹只读 stat + bbox，不解码图片）。"""

    def __init__(self, box_id, image_path, bbox, question_id=1, paper_id=7, page=1):
        self.id = box_id
        self.image_path = str(image_path)
        self.bbox = bbox
        self.question_id = question_id
        self.paper_id = paper_id
        self.page = page


def test_sync_boxes_reports_skip_and_retry_reasons(monkeypatch, tmp_path):
    """跳过/重传必须分类计数：云端缺行 / 图内容变 / 路径变。"""
    from backend.cloud import sync as sync_mod

    img = tmp_path / "page.png"
    img.write_bytes(b"placeholder")

    boxes = [
        _SyncBox(1, img, [0.1, 0.1, 0.9, 0.9]),  # 指纹与 key 都一致 → 跳过
        _SyncBox(2, img, [0.2, 0.2, 0.8, 0.8]),  # 云端没有 → cloud_missing
        _SyncBox(3, img, [0.3, 0.3, 0.7, 0.7]),  # hash 变了 → hash_changed
        _SyncBox(4, img, [0.4, 0.4, 0.6, 0.6]),  # hash 一致但 key 变了 → key_changed
    ]

    def key_of(b):
        return f"papers/{b.paper_id}/q{b.question_id}_{b.id}.webp"

    cloud_rows = {
        1: {"id": 1, "image_key": key_of(boxes[0]), "content_hash": crop_fingerprint(boxes[0])},
        3: {"id": 3, "image_key": key_of(boxes[2]), "content_hash": "stale-hash"},
        4: {"id": 4, "image_key": "papers/7/legacy-key.webp", "content_hash": crop_fingerprint(boxes[3])},
        99: {"id": 99, "image_key": "papers/7/gone.webp", "content_hash": "x"},  # 本地已删
    }

    uploaded: list[str] = []
    upserted: list[dict] = []
    deleted: list[dict] = []
    monkeypatch.setattr(
        sync_mod, "_upload_box", lambda cfg, b, k: uploaded.append(k) or (True, None)
    )
    monkeypatch.setattr(
        sync_mod.supabase, "upsert", lambda cfg, table, rows, **kw: upserted.extend(rows)
    )
    monkeypatch.setattr(
        sync_mod.supabase,
        "delete_filtered",
        lambda cfg, table, filters: deleted.append(filters) or 1,
    )

    summary = SyncSummary()
    _sync_boxes(
        None,
        summary,
        table="question_boxes",
        cloud_rows=cloud_rows,
        local_boxes=boxes,
        key_of=key_of,
        count_prefix="qbox",
    )

    assert summary.counts["qbox_skipped"] == 1
    assert summary.counts["qbox_pending_cloud_missing"] == 1
    assert summary.counts["qbox_pending_hash_changed"] == 1
    assert summary.counts["qbox_pending_key_changed"] == 1
    assert summary.counts["qbox_uploaded"] == 3
    assert summary.counts["qbox_upserted"] == 3
    assert summary.counts["qbox_deleted"] == 1
    assert len(uploaded) == 3
    assert {row["id"] for row in upserted} == {2, 3, 4}
    assert deleted == [{"id": "in.(99)"}]


def test_sync_boxes_migrates_legacy_hash_without_reupload(monkeypatch, tmp_path):
    """指纹公式改版：页图自上传以来没变过时，只升级云端 hash，不重传 R2。"""
    from backend.cloud import sync as sync_mod

    img = tmp_path / "page.png"
    img.write_bytes(b"placeholder")
    box = _SyncBox(7, img, [0.1, 0.1, 0.9, 0.9])

    def key_of(b):
        return f"papers/{b.paper_id}/q{b.question_id}_{b.id}.webp"

    cloud_rows = {
        7: {"id": 7, "image_key": key_of(box), "content_hash": crop_fingerprint_legacy(box)}
    }

    uploaded: list[str] = []
    upserted: list[dict] = []
    monkeypatch.setattr(
        sync_mod, "_upload_box", lambda cfg, b, k: uploaded.append(k) or (True, None)
    )
    monkeypatch.setattr(
        sync_mod.supabase, "upsert", lambda cfg, table, rows, **kw: upserted.extend(rows)
    )
    monkeypatch.setattr(sync_mod.supabase, "delete_filtered", lambda *a, **k: 0)

    summary = SyncSummary()
    _sync_boxes(
        None,
        summary,
        table="question_boxes",
        cloud_rows=cloud_rows,
        local_boxes=[box],
        key_of=key_of,
        count_prefix="qbox",
    )

    assert uploaded == []  # 关键：没有重新传 R2
    assert summary.counts["qbox_uploaded"] == 0
    assert summary.counts["qbox_pending_hash_migrated"] == 1
    assert len(upserted) == 1
    assert upserted[0]["content_hash"] == crop_fingerprint(box)  # 云端 hash 升级到新版
    assert upserted[0]["image_key"] == key_of(box)


def test_sync_boxes_failed_first_upload_keeps_no_hash(monkeypatch, tmp_path):
    """首次上传失败不能写指纹，否则下一轮会误判为已同步。"""
    from backend.cloud import sync as sync_mod

    img = tmp_path / "page.png"
    img.write_bytes(b"placeholder")
    box = _SyncBox(8, img, [0.1, 0.1, 0.9, 0.9])

    def key_of(b):
        return f"papers/{b.paper_id}/q{b.question_id}_{b.id}.webp"

    upserted: list[dict] = []
    monkeypatch.setattr(sync_mod, "_upload_box", lambda cfg, b, k: (False, "R2 上传失败: boom"))
    monkeypatch.setattr(
        sync_mod.supabase, "upsert", lambda cfg, table, rows, **kw: upserted.extend(rows)
    )
    monkeypatch.setattr(sync_mod.supabase, "delete_filtered", lambda *a, **k: 0)

    summary = SyncSummary()
    _sync_boxes(
        None,
        summary,
        table="question_boxes",
        cloud_rows={},
        local_boxes=[box],
        key_of=key_of,
        count_prefix="qbox",
    )

    assert summary.counts["qbox_pending_cloud_missing"] == 1
    assert summary.counts["qbox_uploaded"] == 0
    assert upserted[0]["content_hash"] is None
    assert summary.errors


def test_sync_boxes_dry_run_writes_nothing(monkeypatch, tmp_path):
    """试算模式：不传 R2、不 upsert、不删除，只报告会传/会删多少。"""
    from backend.cloud import sync as sync_mod

    img = tmp_path / "page.png"
    img.write_bytes(b"placeholder")
    boxes = [_SyncBox(1, img, [0.1, 0.1, 0.9, 0.9]), _SyncBox(2, img, [0.2, 0.2, 0.8, 0.8])]

    def key_of(b):
        return f"papers/{b.paper_id}/q{b.question_id}_{b.id}.webp"

    cloud_rows = {
        1: {"id": 1, "image_key": key_of(boxes[0]), "content_hash": "stale"},
        9: {"id": 9, "image_key": "papers/7/gone.webp", "content_hash": "x"},  # 本地已删
    }

    calls = {"upload": 0, "upsert": 0, "delete": 0}
    monkeypatch.setattr(
        sync_mod, "_upload_box", lambda cfg, b, k: calls.__setitem__("upload", calls["upload"] + 1)
    )
    monkeypatch.setattr(
        sync_mod.supabase,
        "upsert",
        lambda *a, **k: calls.__setitem__("upsert", calls["upsert"] + 1),
    )
    monkeypatch.setattr(
        sync_mod.supabase,
        "delete_filtered",
        lambda *a, **k: calls.__setitem__("delete", calls["delete"] + 1),
    )

    summary = SyncSummary(dry_run=True)
    _sync_boxes(
        None,
        summary,
        table="question_boxes",
        cloud_rows=cloud_rows,
        local_boxes=boxes,
        key_of=key_of,
        count_prefix="qbox",
        dry_run=True,
    )

    assert calls == {"upload": 0, "upsert": 0, "delete": 0}
    assert summary.counts["qbox_would_upload"] == 2
    assert summary.counts["qbox_would_delete"] == 1
    assert summary.counts["qbox_pending_hash_changed"] == 1
    assert summary.counts["qbox_pending_cloud_missing"] == 1
    assert "qbox_uploaded" not in summary.counts


def test_tombstone_dry_run_counts_without_patching(monkeypatch):
    from backend.cloud import sync as sync_mod

    calls: list = []
    monkeypatch.setattr(
        sync_mod.supabase, "patch", lambda cfg, table, filters, body: calls.append(filters) or 1
    )
    cloud_rows = [
        {"id": 1, "deleted_at": None},
        {"id": 2, "deleted_at": None},
        {"id": 3, "deleted_at": "2026-01-01T00:00:00Z"},
    ]

    assert sync_mod._tombstone(None, "questions", cloud_rows, {1}, "now", dry_run=True) == 1
    assert calls == []
    assert sync_mod._tombstone(None, "questions", cloud_rows, {1}, "now") == 1
    assert calls == [{"id": "in.(2)"}]


def test_sync_link_rows_dry_run_writes_nothing(monkeypatch):
    from backend.cloud import sync as sync_mod

    calls: list = []
    monkeypatch.setattr(
        sync_mod.supabase, "delete_filtered", lambda *a, **k: calls.append(("del", a[2]))
    )
    monkeypatch.setattr(sync_mod.supabase, "upsert", lambda *a, **k: calls.append(("up", a[1])))

    summary = SyncSummary(dry_run=True)
    _sync_link_rows(
        None,
        summary,
        table="question_sections",
        parent_col="question_id",
        desired=[(1, "A")],
        cloud_rows=[(2, "B")],
        row_factory=lambda p: {"question_id": p[0], "section_name": p[1]},
        dry_run=True,
    )

    assert calls == []
    assert summary.counts["question_sections_deleted"] == 1
    assert summary.counts["question_sections_inserted"] == 1


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
