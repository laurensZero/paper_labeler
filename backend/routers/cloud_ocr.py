"""OCR 校对接口：云端 question_ocr 的队列读取与人工校对回写。

OCR 文本存在云端 question_ocr（迁移 0012），题目原图等展示资源按对齐的
question_id 取本地库。读接口不校验管理 token（与 /cloud/suggestions 一致）；
写接口走 _require_token。boxes_fingerprint 归回写脚本管（规则在重写），
这里一概不读不写。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from backend.database import Question, QuestionBox, QuestionSection
from backend.dependencies import get_db
from backend.routers.cloud import _require_cloud, _require_token
from backend.routers.questions import _paper_qno_map, _question_to_dict

router = APIRouter(prefix="/cloud/ocr", tags=["cloud-ocr"])

_OCR_COLUMNS = (
    "question_id,content,model,status,updated_at,boxes_fingerprint,"
    "questions(question_no,deleted_at,papers(exam_code))"
)

_BOX_COLUMNS = "question_id,page,id,content_hash,image_key"


def _sb():
    from backend.cloud import supabase as sb

    return sb


def _boxes_fingerprint(boxes: list[dict]) -> str:
    """与 0013 RPC pending_ocr_questions / 回写脚本同规则：page:box_id:hash 按页序拼接。"""
    return ",".join(
        f"{b['page']}:{b['id']}:{b.get('content_hash') or b.get('image_key')}"
        for b in sorted(boxes, key=lambda x: (x.get("page", 0), x["id"]))
    )


def _cloud_ref(row: dict) -> dict | None:
    """云端 questions 嵌套行 → {question_no, paper_exam_code}；无嵌套行返回 None。"""
    q = row.get("questions") or {}
    if not q:
        return None
    paper = q.get("papers") or {}
    return {
        "question_no": q.get("question_no"),
        "paper_exam_code": paper.get("exam_code") if isinstance(paper, dict) else None,
    }


def _is_mismatch(local_q: dict | None, cloud: dict) -> bool:
    """本地题号/试卷与云端对不上 → True（id 错位或单侧未同步）。

    题号是最强信号（同步后两侧恒一致）；试卷只在两侧都非空时比对。
    """
    if local_q is None:
        return False
    if cloud["question_no"] is not None and local_q.get("question_no") != cloud["question_no"]:
        return True
    local_exam = (local_q.get("paper") or {}).get("exam_code")
    cloud_exam = cloud["paper_exam_code"]
    return bool(local_exam and cloud_exam and local_exam != cloud_exam)


@router.get("/queue")
def list_ocr_queue(
    status: str = "draft",
    after: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
):
    """校对队列：云端 OCR 行 + 本地题目（题号/原图框）合并。

    after 为游标（按 question_id 升序取其后的行），status=draft/confirmed/all。
    云端软删的题不进队列；cloud/mismatch 字段供前端比对本地与云端题号/试卷，
    防 id 错位（对 A 题的图改 B 题的字）；stale=框指纹不匹配/缺失（框已变更，
    增量 OCR 将重跑并覆盖校对结果）。
    """
    if status not in {"draft", "confirmed", "all"}:
        raise HTTPException(status_code=400, detail="status 必须是 draft/confirmed/all")
    limit = max(1, min(limit, 500))
    sb = _sb()
    cfg = _require_cloud()
    filters = {"question_id": f"gt.{max(0, after)}"}
    if status != "all":
        filters["status"] = f"eq.{status}"
    try:
        rows = sb.select(
            cfg,
            "question_ocr",
            columns=_OCR_COLUMNS,
            filters=filters,
            limit=limit,
            order="question_id",
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None

    qids = [int(r["question_id"]) for r in rows]
    qmap: dict[int, dict] = {}
    if qids:
        questions = db.query(Question).filter(Question.id.in_(qids)).all()
        boxes_by_qid: dict[int, list[QuestionBox]] = {}
        for b in (
            db.query(QuestionBox)
            .filter(QuestionBox.question_id.in_(qids))
            .order_by(QuestionBox.question_id, QuestionBox.page, QuestionBox.id)
            .all()
        ):
            boxes_by_qid.setdefault(b.question_id, []).append(b)
        sections_by_qid: dict[int, list[str]] = {}
        for s in db.query(QuestionSection).filter(QuestionSection.question_id.in_(qids)).all():
            sections_by_qid.setdefault(s.question_id, []).append(s.section_name)
        paper_ids = sorted({q.paper_id for q in questions})
        qno_by_qid = _paper_qno_map(db, paper_ids) if paper_ids else {}
        for q in questions:
            qmap[q.id] = _question_to_dict(
                q,
                boxes_by_qid.get(q.id, []),
                db=db,
                sections_override=sections_by_qid.get(q.id, []),
                paper_qno_override=qno_by_qid.get(q.id),
            )

    # 实时框指纹（云端 question_boxes）→ 与存储指纹比对，供前端标"识别已过期"
    fps: dict[int, str] = {}
    if qids:
        try:
            cloud_boxes = sb.select(
                cfg,
                "question_boxes",
                columns=_BOX_COLUMNS,
                filters={"question_id": f"in.({','.join(str(i) for i in qids)})"},
                order="id",
            )
        except sb.SupabaseError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from None
        boxes_by_q: dict[int, list[dict]] = {}
        for b in cloud_boxes:
            boxes_by_q.setdefault(int(b["question_id"]), []).append(b)
        fps = {qid: _boxes_fingerprint(rows_) for qid, rows_ in boxes_by_q.items()}

    items = []
    for r in rows:
        cloud = _cloud_ref(r)
        if cloud is not None and (r.get("questions") or {}).get("deleted_at"):
            # 云端已软删的题不进校对队列（OCR 行因无硬删级联而残留）
            continue
        qid = int(r["question_id"])
        stored_fp = r.get("boxes_fingerprint")
        stale = stored_fp is None or stored_fp != fps.get(qid, "")
        items.append({
            "question_id": qid,
            "content": r.get("content") or "",
            "model": r.get("model"),
            "status": r.get("status"),
            "updated_at": r.get("updated_at"),
            "question": qmap.get(qid),
            "cloud": cloud,
            "mismatch": _is_mismatch(qmap.get(qid), cloud) if cloud else False,
            "stale": stale,
        })
    return {"items": items, "has_more": len(rows) >= limit}


@router.get("/{question_id}")
def get_ocr_row(question_id: int):
    """单题 OCR 行（保存后刷新 / 冲突核对用）。"""
    sb = _sb()
    cfg = _require_cloud()
    try:
        rows = sb.select(
            cfg,
            "question_ocr",
            columns=_OCR_COLUMNS,
            filters={"question_id": f"eq.{question_id}"},
            limit=1,
        )
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    if not rows:
        raise HTTPException(status_code=404, detail="该题没有 OCR 识别记录")
    return rows[0]


@router.put("/{question_id}")
def update_ocr_row(question_id: int, payload: dict, request: Request):
    """校对回写：只改 content / status / updated_at。"""
    _require_token(request)
    content = payload.get("content")
    status = payload.get("status")
    if content is None and status is None:
        raise HTTPException(status_code=400, detail="content / status 至少提供一项")
    if content is not None and not isinstance(content, str):
        raise HTTPException(status_code=400, detail="content 必须是字符串")
    if content is not None and content != "" and not content.strip():
        # 空串是合法值（纯图形题约定记空内容）；纯空白视为误清空，拒绝
        raise HTTPException(status_code=400, detail="content 不能为纯空白")
    if status is not None and status not in {"draft", "confirmed"}:
        raise HTTPException(status_code=400, detail="status 必须是 draft/confirmed")
    body: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if content is not None:
        body["content"] = content
    if status is not None:
        body["status"] = status
    sb = _sb()
    cfg = _require_cloud()
    try:
        n = sb.patch(cfg, "question_ocr", {"question_id": f"eq.{question_id}"}, body)
    except sb.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    if n == 0:
        raise HTTPException(status_code=404, detail="该题没有 OCR 识别记录")
    return {"ok": True, "status": status}
