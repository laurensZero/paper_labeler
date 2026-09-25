from pathlib import Path

import pytest
from fastapi import HTTPException

from backend.services.paper_utils import (
    auto_suggest_allowed_by_filename,
    derive_pair_code,
    extract_year_from_filename,
    is_answer_filename,
    normalize_exam_code_for_type,
    page_image_url_suffix,
    resolve_page_image,
    stem_no_ext,
)


class TestExtractYearFromFilename:
    def test_extracts_two_digit_year(self):
        assert extract_year_from_filename("9709_s23_qp_23.pdf") == 23

    def test_case_insensitive_season(self):
        assert extract_year_from_filename("9709_M25_qp_1.pdf") == 25

    def test_winter_session(self):
        assert extract_year_from_filename("9709_w19_ms_1.pdf") == 19

    def test_no_match_returns_none(self):
        assert extract_year_from_filename("random.pdf") is None

    def test_empty_and_none(self):
        assert extract_year_from_filename("") is None
        assert extract_year_from_filename(None) is None


class TestAutoSuggestAllowedByFilename:
    def test_year_le_23_allowed(self):
        ok, reason = auto_suggest_allowed_by_filename("9709_s23_qp_1.pdf")
        assert ok is True
        assert reason is None

    def test_year_gt_23_allowed(self):
        # Year gate lifted: recognition quality no longer depends on year.
        ok, reason = auto_suggest_allowed_by_filename("9709_s24_qp_1.pdf")
        assert ok is True
        assert reason is None

    def test_unknown_year_allowed(self):
        ok, reason = auto_suggest_allowed_by_filename("no_year_here.pdf")
        assert ok is True
        assert reason is None


class TestStemNoExt:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("9709_s23_qp_23.pdf", "9709_s23_qp_23"),
            ("9709_s23_qp_23.PDF", "9709_s23_qp_23"),
            ("9709_s23_qp_23", "9709_s23_qp_23"),
            ("dir/name.pdf", "name"),
            ("", ""),
            (None, ""),
        ],
    )
    def test_cases(self, raw, expected):
        assert stem_no_ext(raw) == expected


class TestDerivePairCode:
    def test_qp_to_ms(self):
        assert derive_pair_code("9709_s23_qp_23.pdf") == "9709_s23_ms_23"

    def test_ms_to_qp(self):
        assert derive_pair_code("9709_s23_ms_23.pdf") == "9709_s23_qp_23"

    def test_no_pair_marker(self):
        assert derive_pair_code("9709_s23.pdf") is None

    def test_empty(self):
        assert derive_pair_code("") is None
        assert derive_pair_code(None) is None

    def test_case_insensitive(self):
        assert derive_pair_code("9709_S23_QP_23") == "9709_S23_ms_23"


class TestIsAnswerFilename:
    def test_ms_is_answer(self):
        assert is_answer_filename("9709_s23_ms_23.pdf") is True

    def test_qp_is_not_answer(self):
        assert is_answer_filename("9709_s23_qp_23.pdf") is False

    def test_no_marker(self):
        assert is_answer_filename("random.pdf") is False


class TestNormalizeExamCodeForType:
    def test_answer_flips_qp_to_ms(self):
        assert normalize_exam_code_for_type("9709_s23_qp_23", True) == "9709_s23_ms_23"

    def test_question_flips_ms_to_qp(self):
        assert normalize_exam_code_for_type("9709_s23_ms_23", False) == "9709_s23_qp_23"

    def test_untouched_when_already_correct(self):
        assert normalize_exam_code_for_type("9709_s23_ms_23", True) == "9709_s23_ms_23"
        assert normalize_exam_code_for_type("9709_s23_qp_23", False) == "9709_s23_qp_23"

    def test_none_and_empty_passthrough(self):
        assert normalize_exam_code_for_type(None, True) is None
        assert normalize_exam_code_for_type("", False) == ""


class TestPageImageResolution:
    def test_prefers_webp_over_png(self, tmp_path: Path):
        (tmp_path / "page_1.webp").write_bytes(b"webp")
        (tmp_path / "page_1.png").write_bytes(b"png")
        resolved = resolve_page_image(tmp_path, 1)
        assert resolved is not None
        assert resolved.suffix == ".webp"

    def test_falls_back_to_png(self, tmp_path: Path):
        (tmp_path / "page_2.png").write_bytes(b"png")
        resolved = resolve_page_image(tmp_path, 2)
        assert resolved is not None
        assert resolved.suffix == ".png"

    def test_missing_returns_none(self, tmp_path: Path):
        assert resolve_page_image(tmp_path, 9) is None

    def test_url_suffix_webp(self, tmp_path: Path):
        (tmp_path / "page_3.webp").write_bytes(b"webp")
        suffix, path = page_image_url_suffix(tmp_path, 3)
        assert suffix == "page_3.webp"
        assert path is not None

    def test_url_suffix_missing_fallback(self, tmp_path: Path):
        suffix, path = page_image_url_suffix(tmp_path, 7)
        assert suffix == "page_7.png"
        assert path is None


class TestSaveUploadWithLimit:
    def test_streams_to_disk(self, tmp_path: Path):
        from io import BytesIO

        from starlette.datastructures import UploadFile

        from backend.services.paper_utils import save_upload_with_limit

        payload = b"hello pdf bytes"
        upload = UploadFile(filename="a.pdf", file=BytesIO(payload))
        dest = tmp_path / "out" / "a.pdf"
        written = save_upload_with_limit(upload, dest, max_bytes=1024)
        assert written == len(payload)
        assert dest.read_bytes() == payload

    def test_rejects_oversize(self, tmp_path: Path):
        from io import BytesIO

        from starlette.datastructures import UploadFile

        from backend.services.paper_utils import save_upload_with_limit

        upload = UploadFile(filename="big.pdf", file=BytesIO(b"x" * 32))
        dest = tmp_path / "big.pdf"
        with pytest.raises(HTTPException) as exc:
            save_upload_with_limit(upload, dest, max_bytes=16)
        assert exc.value.status_code == 413
