import pytest
from pydantic import ValidationError

from backend.schemas.schemas import (
    ExportQuestionsPDF,
    ExportQuestionsPDFOptions,
    QuestionsBatchUpdate,
    QuestionCreate,
)


class TestExportQuestionsPDF:
    def test_requires_at_least_one_id(self):
        with pytest.raises(ValidationError):
            ExportQuestionsPDF(ids=[])

    def test_accepts_ids(self):
        model = ExportQuestionsPDF(ids=[1, 2, 3])
        assert model.ids == [1, 2, 3]
        assert model.options is None


class TestExportQuestionsPDFOptions:
    def test_defaults(self):
        opts = ExportQuestionsPDFOptions()
        assert opts.include_paper is True
        assert opts.include_answers is False
        assert opts.answers_placement == "end"

    def test_rejects_invalid_answers_placement(self):
        with pytest.raises(ValidationError):
            ExportQuestionsPDFOptions(answers_placement="middle")


class TestQuestionsBatchUpdate:
    def test_requires_ids(self):
        with pytest.raises(ValidationError):
            QuestionsBatchUpdate(ids=[])

    def test_accepts_partial_fields(self):
        model = QuestionsBatchUpdate(ids=[1], is_favorite=True)
        assert model.sections is None
        assert model.is_favorite is True


class TestQuestionCreate:
    def test_empty_boxes_allowed_at_schema_level(self):
        # Endpoint rejects empty boxes with 400; schema itself does not.
        model = QuestionCreate(boxes=[])
        assert model.boxes == []

    def test_box_bbox_accepts_list_of_floats(self):
        model = QuestionCreate(boxes=[{"page": 1, "bbox": [0, 0, 1, 1]}])
        assert model.boxes[0].bbox == [0, 0, 1, 1]

    def test_accepts_multi_sections(self):
        model = QuestionCreate(
            boxes=[{"page": 1, "bbox": [0.1, 0.1, 0.2, 0.2]}],
            sections=["Mechanics", "Statistics"],
            status="draft",
        )
        assert model.sections == ["Mechanics", "Statistics"]
        assert model.status == "draft"
