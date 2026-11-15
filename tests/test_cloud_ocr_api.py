"""API-level tests for /cloud/ocr/*（OCR 校对队列 + 回写）。"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from backend.database import Paper, Question, QuestionBox, QuestionSection, SessionLocal
from backend.main import app
from backend.routers import cloud_ocr as ocr_router

client = TestClient(app)


@pytest.fixture()
def local_question():
    """一道带两框、单 section 的本地题目（filename/question_no 随机，避开唯一索引）。"""
    tag = uuid.uuid4().hex[:8]
    db = SessionLocal()
    try:
        paper = Paper(filename=f"9701_s24_qp_42_{tag}.pdf")
        db.add(paper)
        db.commit()
        q = Question(paper_id=paper.id, question_no=f"Q{tag}", status="draft")
        db.add(q)
        db.commit()
        db.add_all([
            QuestionBox(question_id=q.id, paper_id=paper.id, page=1, bbox=[10, 20, 300, 120], image_path="x"),
            QuestionBox(question_id=q.id, paper_id=paper.id, page=2, bbox=[5, 5, 200, 90], image_path="y"),
        ])
        db.add(QuestionSection(question_id=q.id, section_name="物理"))
        db.commit()
        yield {"id": q.id, "no": q.question_no}
        # 先清子表（section 是 (question_id, section_name) 复合主键，残留会撞下一题）
        db.query(QuestionSection).filter(QuestionSection.question_id == q.id).delete()
        db.query(QuestionBox).filter(QuestionBox.question_id == q.id).delete()
        db.delete(q)
        db.commit()
    finally:
        db.close()


def ocr_row(qid: int, content: str = "$x^2$", *, question_no: str | None = "3", deleted_at: str | None = None, exam_code: str | None = "9701/42", fingerprint: str | None = None) -> dict:
    """云端 question_ocr 行假件（带 questions/papers 嵌套）。"""
    row = {
        "question_id": qid,
        "content": content,
        "model": "xiaomi-ocr-0",
        "status": "draft",
        "updated_at": "2026-10-31T00:00:00+00:00",
    }
    if fingerprint is not None:
        row["boxes_fingerprint"] = fingerprint
    if question_no is not None or deleted_at is not None or exam_code is not None:
        row["questions"] = {
            "question_no": question_no,
            "deleted_at": deleted_at,
            "papers": {"exam_code": exam_code} if exam_code is not None else None,
        }
    return row


def cloud_box(qid: int, page: int, box_id: int, *, content_hash: str | None = None, image_key: str | None = None) -> dict:
    return {"question_id": qid, "page": page, "id": box_id, "content_hash": content_hash, "image_key": image_key}


@pytest.fixture()
def fake_cloud(monkeypatch):
    """绕过云端配置自检（读接口不再真实联网）；select/patch 替换为可编程假件。"""
    calls: dict = {"select": [], "patch": [], "select_rows": [], "boxes_rows": [], "patch_count": 1}

    def fake_select(cfg, table, columns="*", filters=None, limit=None, order=None):
        calls["select"].append({"table": table, "columns": columns, "filters": filters, "limit": limit, "order": order})
        return calls["boxes_rows"] if table == "question_boxes" else calls["select_rows"]

    def fake_patch(cfg, table, filters, body):
        calls["patch"].append({"table": table, "filters": filters, "body": body})
        return calls["patch_count"]

    monkeypatch.setattr(ocr_router, "_require_cloud", lambda: object())
    monkeypatch.setattr("backend.cloud.supabase.select", fake_select)
    monkeypatch.setattr("backend.cloud.supabase.patch", fake_patch)
    return calls


@pytest.fixture()
def with_token(monkeypatch):
    # _require_token 是 cloud.py 的函数对象，须 patch 其模块内绑定
    monkeypatch.setattr("backend.routers.cloud.get_cloud_token", lambda: "secret")
    monkeypatch.setattr("backend.cloud.config.get_cloud_token", lambda: "secret")


# ── 配置自检 ──

def test_queue_rejected_when_cloud_disabled(monkeypatch):
    monkeypatch.setattr("backend.routers.cloud.cloud_enabled", lambda: False)
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 400
    assert "云端" in res.json()["detail"]


# ── 队列 ──

def test_queue_merges_local_question(fake_cloud, local_question):
    fake_cloud["select_rows"] = [
        ocr_row(local_question["id"], question_no=local_question["no"]),
    ]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    body = res.json()
    assert body["has_more"] is False
    item = body["items"][0]
    assert item["question_id"] == local_question["id"]
    assert item["content"] == "$x^2$"
    q = item["question"]
    assert q["question_no"].startswith("Q")
    assert len(q["boxes"]) == 2
    assert q["boxes"][0]["page"] == 1
    assert q["preview_image_url"]
    assert q["paper"]["filename"].endswith(".pdf")
    assert item["cloud"] == {"question_no": local_question["no"], "paper_exam_code": "9701/42"}
    assert item["mismatch"] is False


def test_queue_flags_local_cloud_mismatch(fake_cloud, local_question):
    """云端题号与本地不一致（id 错位信号）→ mismatch=true。"""
    fake_cloud["select_rows"] = [ocr_row(local_question["id"], question_no="999")]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    item = res.json()["items"][0]
    assert item["mismatch"] is True


def test_queue_stale_when_fingerprint_missing(fake_cloud, local_question):
    """回写侧失败省略指纹 → 增量会重跑，视为 stale。"""
    fake_cloud["select_rows"] = [ocr_row(local_question["id"], fingerprint=None)]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    item = res.json()["items"][0]
    assert item["stale"] is True


def test_queue_stale_compares_fingerprint_with_cloud_boxes(fake_cloud, local_question):
    """存储指纹 vs 云端 question_boxes 实时指纹：一致不 stale，框变更 stale。"""
    qid = local_question["id"]
    fake_cloud["boxes_rows"] = [
        cloud_box(qid, page=2, box_id=2, content_hash="h2"),
        cloud_box(qid, page=1, box_id=1, image_key="k1"),
    ]
    # 与回写同规则按 (page, id) 拼接；乱序传入也应算出同一指纹
    fake_cloud["select_rows"] = [ocr_row(qid, fingerprint="1:1:k1,2:2:h2")]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    assert res.json()["items"][0]["stale"] is False

    fake_cloud["select_rows"] = [ocr_row(qid, fingerprint="1:1:k1,2:2:OLD")]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    assert res.json()["items"][0]["stale"] is True

    # 框指纹查询：in. 过滤 + 稳定排序（offset 翻页不漏行）
    box_sel = next(c for c in fake_cloud["select"] if c["table"] == "question_boxes")
    assert box_sel["filters"] == {"question_id": f"in.({qid})"}
    assert box_sel["order"] == "id"


def test_queue_skips_cloud_soft_deleted(fake_cloud, local_question):
    """云端软删的题不进校对队列（OCR 行因无硬删级联而残留）。"""
    fake_cloud["select_rows"] = [
        ocr_row(local_question["id"], deleted_at="2026-10-30T00:00:00+00:00"),
        ocr_row(local_question["id"] + 1000),
    ]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    items = res.json()["items"]
    assert [it["question_id"] for it in items] == [local_question["id"] + 1000]


def test_queue_cloud_question_missing(fake_cloud, local_question):
    """云端 questions 嵌套缺失（异常态）：仍返回，cloud=null 供前端提示。"""
    fake_cloud["select_rows"] = [ocr_row(local_question["id"], question_no=None, exam_code=None)]
    res = client.get("/cloud/ocr/queue")
    assert res.status_code == 200
    item = res.json()["items"][0]
    assert item["cloud"] is None
    assert item["mismatch"] is False


def test_queue_passes_status_and_cursor(fake_cloud, local_question):
    fake_cloud["select_rows"] = []
    res = client.get("/cloud/ocr/queue?status=confirmed&after=42&limit=10")
    assert res.status_code == 200
    sel = fake_cloud["select"][0]
    assert sel["filters"] == {"question_id": "gt.42", "status": "eq.confirmed"}
    assert sel["limit"] == 10
    assert sel["order"] == "question_id"


def test_queue_invalid_status(fake_cloud):
    res = client.get("/cloud/ocr/queue?status=bogus")
    assert res.status_code == 400


def test_queue_has_more_when_full_page(fake_cloud, local_question):
    fake_cloud["select_rows"] = [
        ocr_row(local_question["id"], content="")
    ]
    res = client.get("/cloud/ocr/queue?limit=1")
    assert res.status_code == 200
    assert res.json()["has_more"] is True


def test_queue_all_status_has_no_status_filter(fake_cloud, local_question):
    fake_cloud["select_rows"] = []
    res = client.get("/cloud/ocr/queue?status=all")
    assert res.status_code == 200
    assert "status" not in fake_cloud["select"][0]["filters"]


# ── 单题读取 ──

def test_get_row_found(fake_cloud, local_question):
    fake_cloud["select_rows"] = [ocr_row(local_question["id"], content="abc")]
    res = client.get(f"/cloud/ocr/{local_question['id']}")
    assert res.status_code == 200
    assert res.json()["content"] == "abc"


def test_get_row_404(fake_cloud):
    fake_cloud["select_rows"] = []
    res = client.get("/cloud/ocr/999999")
    assert res.status_code == 404


# ── 回写 ──

def test_put_requires_token(fake_cloud, monkeypatch):
    # token 未配置 = 管理写操作禁用（真实 .env 里有 token，须显式置空走该分支）
    monkeypatch.setattr("backend.routers.cloud.get_cloud_token", lambda: "")
    res = client.put("/cloud/ocr/1", json={"content": "x"})
    assert res.status_code == 403


def test_put_rejects_empty_payload(fake_cloud, with_token):
    res = client.put("/cloud/ocr/1", json={}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 400
    res = client.put("/cloud/ocr/1", json={"content": "  "}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 400
    res = client.put("/cloud/ocr/1", json={"status": "bogus"}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 400
    assert fake_cloud["patch"] == []


def test_put_updates_content_and_never_touches_fingerprint(fake_cloud, with_token):
    res = client.put(
        "/cloud/ocr/7",
        json={"content": "校对后的 $x$", "status": "confirmed"},
        headers={"X-Paper-Token": "secret"},
    )
    assert res.status_code == 200
    call = fake_cloud["patch"][0]
    assert call["table"] == "question_ocr"
    assert call["filters"] == {"question_id": "eq.7"}
    assert call["body"]["content"] == "校对后的 $x$"
    assert call["body"]["status"] == "confirmed"
    assert "updated_at" in call["body"]
    assert "boxes_fingerprint" not in call["body"]


def test_put_allows_empty_content_for_pure_figure(fake_cloud, with_token):
    """纯图形题在回写侧记空内容；校对确认不应被"非空"校验卡住。"""
    res = client.put("/cloud/ocr/7", json={"content": "", "status": "confirmed"}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 200
    assert fake_cloud["patch"][0]["body"]["content"] == ""


def test_put_404_when_row_missing(fake_cloud, with_token):
    fake_cloud["patch_count"] = 0
    res = client.put("/cloud/ocr/7", json={"status": "confirmed"}, headers={"X-Paper-Token": "secret"})
    assert res.status_code == 404
