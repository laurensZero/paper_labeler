from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.database import (
    Composition,
    CompositionItem,
    Question,
    QuestionBox,
    QuestionSection,
    Paper,
    Answer,
    AnswerBox,
)
from backend.schemas.schemas import (
    CompositionCreate,
    CompositionUpdate,
    CompositionItemAdd,
    CompositionItemBatchAdd,
    CompositionItemUpdate,
    CompositionReorder,
)
from backend.dependencies import get_db
from backend.utils import _with_cache_bust, _file_mtime_token
from backend.services.question_preview import question_preview_version

router = APIRouter(tags=["compositions"])


def _composition_to_dict(comp: Composition, item_count: int = 0) -> dict:
    return {
        "id": comp.id,
        "name": comp.name,
        "title": comp.title,
        "header_text": comp.header_text,
        "footer_text": comp.footer_text,
        "include_answers": comp.include_answers,
        "answers_placement": comp.answers_placement,
        "group_by_section": comp.group_by_section,
        "show_section_headers": comp.show_section_headers,
        "show_question_info": comp.show_question_info,
        "show_page_numbers": comp.show_page_numbers,
        "created_at": comp.created_at,
        "updated_at": comp.updated_at,
        "item_count": item_count,
    }


def _item_to_dict(
    item: CompositionItem,
    q: Question | None = None,
    sections: list[str] | None = None,
    paper_exam_code: str | None = None,
    preview_url: str | None = None,
) -> dict:
    d: dict = {
        "id": item.id,
        "composition_id": item.composition_id,
        "question_id": item.question_id,
        "sort_order": item.sort_order,
        "blank_pages": item.blank_pages,
        "item_type": item.item_type,
        "score": item.score,
        "custom_header": item.custom_header,
        "created_at": item.created_at,
    }
    if q is not None:
        d["question_no"] = q.question_no
        d["sections"] = sections or []
        d["paper_exam_code"] = paper_exam_code
        d["preview_image_url"] = preview_url
        d["is_favorite"] = bool(getattr(q, "is_favorite", False))
        d["notes"] = q.notes
    return d


def _prefetch_question_data(
    db: Session, question_ids: list[int | None]
) -> tuple[dict[int, Question], dict[int, list[str]], dict[int, Paper], dict[int, list[QuestionBox]]]:
    qids = list({qid for qid in question_ids if qid is not None})
    questions: dict[int, Question] = {}
    sections_by_qid: dict[int, list[str]] = {}
    papers_by_id: dict[int, Paper] = {}
    boxes_by_qid: dict[int, list[QuestionBox]] = {}
    if not qids:
        return questions, sections_by_qid, papers_by_id, boxes_by_qid
    questions = {q.id: q for q in db.query(Question).filter(Question.id.in_(qids)).all()}
    for row in db.query(QuestionSection).filter(QuestionSection.question_id.in_(qids)).all():
        sections_by_qid.setdefault(row.question_id, []).append(row.section_name)
    paper_ids = {q.paper_id for q in questions.values()}
    if paper_ids:
        papers_by_id = {p.id: p for p in db.query(Paper).filter(Paper.id.in_(paper_ids)).all()}
    boxes = (
        db.query(QuestionBox)
        .filter(QuestionBox.question_id.in_(qids))
        .order_by(QuestionBox.page, QuestionBox.id)
        .all()
    )
    for box in boxes:
        boxes_by_qid.setdefault(box.question_id, []).append(box)
    return questions, sections_by_qid, papers_by_id, boxes_by_qid


def _serialize_item(
    item: CompositionItem,
    questions: dict[int, Question],
    sections_by_qid: dict[int, list[str]],
    papers_by_id: dict[int, Paper],
    boxes_by_qid: dict[int, list[QuestionBox]],
) -> dict:
    q = questions.get(item.question_id) if item.question_id is not None else None
    if q is None:
        return _item_to_dict(item)
    sections = list(sections_by_qid.get(q.id) or [])
    # fallback to legacy section field
    if not sections and q.section:
        sections = [q.section]
    paper = papers_by_id.get(q.paper_id)
    exam_code = (paper.exam_code or paper.filename) if paper else None
    boxes = boxes_by_qid.get(q.id) or []
    preview_url = None
    if boxes:
        version = question_preview_version(boxes)
        preview_url = f"/questions/{int(q.id)}/preview.png?w=1200&v={version}"
    return _item_to_dict(item, q, sections, exam_code, preview_url)


# ── Composition CRUD ─────────────────────────────────────────────────


@router.post("/compositions")
def create_composition(body: CompositionCreate, db: Session = Depends(get_db)):
    # Check duplicate name
    existing = db.query(Composition).filter(Composition.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="方案名已存在")
    comp = Composition(
        name=body.name,
        title=body.title,
        header_text=body.header_text,
        footer_text=body.footer_text,
        include_answers=body.include_answers,
        answers_placement=body.answers_placement,
        group_by_section=body.group_by_section,
        show_section_headers=body.show_section_headers,
        show_question_info=body.show_question_info,
        show_page_numbers=body.show_page_numbers,
    )
    db.add(comp)
    db.commit()
    db.refresh(comp)
    return _composition_to_dict(comp, item_count=0)


@router.get("/compositions")
def list_compositions(db: Session = Depends(get_db)):
    comps = db.query(Composition).order_by(Composition.updated_at.desc()).all()
    counts = dict(
        db.query(CompositionItem.composition_id, func.count(CompositionItem.id))
        .group_by(CompositionItem.composition_id)
        .all()
    )
    return [_composition_to_dict(comp, item_count=counts.get(comp.id, 0)) for comp in comps]


@router.get("/compositions/{comp_id}")
def get_composition(comp_id: int, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    items = (
        db.query(CompositionItem)
        .filter(CompositionItem.composition_id == comp_id)
        .order_by(CompositionItem.sort_order, CompositionItem.id)
        .all()
    )

    prefetched = _prefetch_question_data(db, [item.question_id for item in items])
    item_details = [_serialize_item(item, *prefetched) for item in items]

    result = _composition_to_dict(comp, item_count=len(items))
    result["items"] = item_details
    return result


@router.patch("/compositions/{comp_id}")
def update_composition(comp_id: int, body: CompositionUpdate, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    update_data = body.model_dump(exclude_unset=True)

    # Check duplicate name on rename
    if "name" in update_data and update_data["name"] != comp.name:
        dup = db.query(Composition).filter(
            Composition.name == update_data["name"],
            Composition.id != comp_id,
        ).first()
        if dup:
            raise HTTPException(status_code=409, detail="方案名已存在")

    for field, value in update_data.items():
        setattr(comp, field, value)

    db.commit()
    db.refresh(comp)
    count = (
        db.query(func.count(CompositionItem.id))
        .filter(CompositionItem.composition_id == comp.id)
        .scalar()
    )
    return _composition_to_dict(comp, item_count=count or 0)


@router.delete("/compositions/{comp_id}")
def delete_composition(comp_id: int, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")
    db.query(CompositionItem).filter(
        CompositionItem.composition_id == comp_id
    ).delete(synchronize_session=False)
    db.delete(comp)
    db.commit()
    return {"ok": True}


@router.post("/compositions/{comp_id}/duplicate")
def duplicate_composition(comp_id: int, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    new_comp = Composition(
        name=f"{comp.name} (copy)",
        title=comp.title,
        header_text=comp.header_text,
        footer_text=comp.footer_text,
        include_answers=comp.include_answers,
        answers_placement=comp.answers_placement,
        group_by_section=comp.group_by_section,
        show_section_headers=comp.show_section_headers,
        show_question_info=comp.show_question_info,
        show_page_numbers=comp.show_page_numbers,
    )
    db.add(new_comp)
    db.flush()

    items = (
        db.query(CompositionItem)
        .filter(CompositionItem.composition_id == comp_id)
        .order_by(CompositionItem.sort_order, CompositionItem.id)
        .all()
    )
    for item in items:
        new_item = CompositionItem(
            composition_id=new_comp.id,
            question_id=item.question_id,
            sort_order=item.sort_order,
            blank_pages=item.blank_pages,
            item_type=item.item_type,
            score=item.score,
            custom_header=item.custom_header,
        )
        db.add(new_item)

    db.commit()
    db.refresh(new_comp)
    return _composition_to_dict(new_comp, item_count=len(items))


# ── Composition Items ────────────────────────────────────────────────


@router.post("/compositions/{comp_id}/items")
def add_item(comp_id: int, body: CompositionItemAdd, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    # Check question exists
    q = db.query(Question).filter(Question.id == body.question_id).first()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    # Check duplicate
    existing = (
        db.query(CompositionItem)
        .filter(
            CompositionItem.composition_id == comp_id,
            CompositionItem.question_id == body.question_id,
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="Question already in composition")

    # Determine sort_order
    sort_order = body.sort_order
    if sort_order is None:
        max_order = (
            db.query(func.max(CompositionItem.sort_order))
            .filter(CompositionItem.composition_id == comp_id)
            .scalar()
        )
        sort_order = (max_order or 0) + 1

    item = CompositionItem(
        composition_id=comp_id,
        question_id=body.question_id,
        sort_order=sort_order,
        blank_pages=body.blank_pages,
        item_type=body.item_type,
        score=body.score,
        custom_header=body.custom_header,
    )
    db.add(item)
    db.commit()
    db.refresh(item)

    return _serialize_item(item, *_prefetch_question_data(db, [item.question_id]))


@router.post("/compositions/{comp_id}/items/batch")
def add_items_batch(comp_id: int, body: CompositionItemBatchAdd, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    max_order = (
        db.query(func.max(CompositionItem.sort_order))
        .filter(CompositionItem.composition_id == comp_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    found_ids = {
        row[0]
        for row in db.query(Question.id).filter(Question.id.in_(body.question_ids)).all()
    }
    existing_ids = {
        row[0]
        for row in db.query(CompositionItem.question_id)
        .filter(
            CompositionItem.composition_id == comp_id,
            CompositionItem.question_id.isnot(None),
        )
        .all()
    }

    added = []
    skipped = []
    for qid in body.question_ids:
        if qid not in found_ids or qid in existing_ids:
            skipped.append(qid)
            continue

        item = CompositionItem(
            composition_id=comp_id,
            question_id=qid,
            sort_order=next_order,
            item_type="question",
        )
        db.add(item)
        existing_ids.add(qid)
        added.append(qid)
        next_order += 1

    db.commit()
    return {"added": len(added), "skipped": skipped}


@router.delete("/compositions/{comp_id}/items/{item_id}")
def remove_item(comp_id: int, item_id: int, db: Session = Depends(get_db)):
    item = (
        db.query(CompositionItem)
        .filter(
            CompositionItem.id == item_id,
            CompositionItem.composition_id == comp_id,
        )
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(item)
    db.commit()
    return {"ok": True}


@router.patch("/compositions/{comp_id}/items/{item_id}")
def update_item(comp_id: int, item_id: int, body: CompositionItemUpdate, db: Session = Depends(get_db)):
    item = (
        db.query(CompositionItem)
        .filter(
            CompositionItem.id == item_id,
            CompositionItem.composition_id == comp_id,
        )
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)

    db.commit()
    db.refresh(item)

    return _serialize_item(item, *_prefetch_question_data(db, [item.question_id]))


@router.post("/compositions/{comp_id}/items/reorder")
def reorder_items(comp_id: int, body: CompositionReorder, db: Session = Depends(get_db)):
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    items_map = {}
    for item in (
        db.query(CompositionItem)
        .filter(CompositionItem.composition_id == comp_id)
        .all()
    ):
        items_map[item.id] = item

    for idx, item_id in enumerate(body.item_ids):
        item = items_map.get(item_id)
        if item:
            item.sort_order = idx

    db.commit()
    return {"ok": True, "reordered": len(body.item_ids)}


@router.post("/compositions/{comp_id}/items/insert_blank")
def insert_blank_page(comp_id: int, after_item_id: int | None = None, db: Session = Depends(get_db)):
    """Insert a blank page item after the specified item (or at the end)."""
    comp = db.query(Composition).filter(Composition.id == comp_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Composition not found")

    if after_item_id is not None:
        after_item = (
            db.query(CompositionItem)
            .filter(
                CompositionItem.id == after_item_id,
                CompositionItem.composition_id == comp_id,
            )
            .first()
        )
        if not after_item:
            raise HTTPException(status_code=404, detail="Item not found")
        insert_order = after_item.sort_order + 0.5
    else:
        max_order = (
            db.query(func.max(CompositionItem.sort_order))
            .filter(CompositionItem.composition_id == comp_id)
            .scalar()
        )
        insert_order = (max_order or 0) + 1

    item = CompositionItem(
        composition_id=comp_id,
        question_id=None,  # blank pages have no associated question
        sort_order=insert_order,
        blank_pages=0,
        item_type="blank_page",
    )
    db.add(item)
    db.flush()

    # Re-normalize sort orders
    all_items = (
        db.query(CompositionItem)
        .filter(CompositionItem.composition_id == comp_id)
        .order_by(CompositionItem.sort_order, CompositionItem.id)
        .all()
    )
    for idx, it in enumerate(all_items):
        it.sort_order = idx

    db.commit()
    db.refresh(item)
    return _item_to_dict(item)
