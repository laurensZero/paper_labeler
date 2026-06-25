from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field

class AutoSuggestRequest(BaseModel):
    min_height_px: int = 70
    y_padding_px: int = 12

class PaperUpdate(BaseModel):
    exam_code: str | None = None
    done: bool | None = None

class PurgeAllRequest(BaseModel):
    confirm1: str
    confirm2: str
    wipe_sections: bool = False

class SectionDefCreate(BaseModel):
    name: str
    content: str | None = None
    group_id: int | None = None
    color: str | None = None

class SectionDefUpdate(BaseModel):
    name: str | None = None
    content: str | None = None
    group_id: int | None = None
    color: str | None = None

class SectionGroupCreate(BaseModel):
    name: str
    show_in_filter: bool | None = None

class SectionGroupUpdate(BaseModel):
    name: str | None = None
    show_in_filter: bool | None = None

class BoxIn(BaseModel):
    page: int
    bbox: list[float] = Field(description="[x0,y0,x1,y1] normalized")

class QuestionCreate(BaseModel):
    question_no: str | None = None
    section: str | None = None  # 向后兼容，不再使用
    sections: list[str] | None = None  # 新：支持多个分类
    status: str = "confirmed"
    notes: str | None = None
    boxes: list[BoxIn]

class QuestionUpdate(BaseModel):
    question_no: str | None = None
    section: str | None = None  # 向后兼容，不再使用
    sections: list[str] | None = None  # 新：支持多个分类
    status: str | None = None
    notes: str | None = None
    is_favorite: bool | None = None

class QuestionBoxesReplace(BaseModel):
    boxes: list[BoxIn]

class AnswerUpsert(BaseModel):
    ms_paper_id: int
    notes: str | None = None
    boxes: list[BoxIn]

class QuestionSearchRequest(BaseModel):
    section: str | None = None
    status: str | None = None
    paper_id: int | None = None
    paper_ids: list[int] | None = None
    question_no: str | None = None
    notes_keyword: str | None = None
    year: str | None = None
    years: list[str] | None = None
    season: str | None = None
    seasons: list[str] | None = None
    favorite: bool | None = None
    unsectioned: bool | None = None
    exclude_multi_section: bool | None = None
    page: int = 1
    page_size: int = 10
    ids_only: bool = False

class QuestionsBatchUpdate(BaseModel):
    ids: list[int] = Field(min_length=1)
    sections: list[str] | None = None
    is_favorite: bool | None = None
    notes: str | None = None

class ExportQuestionsPDFOptions(BaseModel):
    include_paper: bool = True
    include_section: bool = True
    include_question_no: bool = True
    include_answers: bool = False
    answers_placement: Literal["end", "interleaved"] = "end"

class ExportQuestionsPDF(BaseModel):
    ids: list[int] = Field(min_length=1)
    options: ExportQuestionsPDFOptions | None = None

class ExportJobCreated(BaseModel):
    url: str


# ── Composition schemas ──────────────────────────────────────────────

class CompositionCreate(BaseModel):
    name: str
    title: str | None = None
    header_text: str | None = None
    footer_text: str | None = None
    include_answers: bool = False
    answers_placement: Literal["end", "interleaved"] = "end"
    group_by_section: bool = True
    show_section_headers: bool = True
    show_question_info: bool = True
    show_page_numbers: bool = True


class CompositionUpdate(BaseModel):
    name: str | None = None
    title: str | None = None
    header_text: str | None = None
    footer_text: str | None = None
    include_answers: bool | None = None
    answers_placement: Literal["end", "interleaved"] | None = None
    group_by_section: bool | None = None
    show_section_headers: bool | None = None
    show_question_info: bool | None = None
    show_page_numbers: bool | None = None


class CompositionItemAdd(BaseModel):
    question_id: int
    sort_order: int | None = None
    blank_pages: int = 0
    item_type: str = "question"
    score: float | None = None
    custom_header: str | None = None


class CompositionItemBatchAdd(BaseModel):
    question_ids: list[int] = Field(min_length=1)


class CompositionItemUpdate(BaseModel):
    sort_order: int | None = None
    blank_pages: int | None = None
    custom_header: str | None = None
    score: float | None = None


class CompositionReorder(BaseModel):
    item_ids: list[int] = Field(min_length=1)
