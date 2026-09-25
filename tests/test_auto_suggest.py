from backend.auto_suggest import (
    Marker,
    TextLine,
    _extract_markers_from_lines,
    _norm_params,
    _normalize_and_dedupe_questions,
    _q_values_coherent,
    detect_problematic_control_chars,
)


def _line(text: str, *, x0: float = 40.0, y0: float = 100.0) -> TextLine:
    return TextLine(x0=x0, y0=y0, x1=x0 + 200, y1=y0 + 14, text=text)


class TestNormParams:
    def test_defaults(self):
        pad_x, pad_y, mh = _norm_params(min_height_px=70, y_padding_px=12)
        assert pad_x == pad_y
        assert abs(pad_x - 12 / 3508) < 1e-9
        assert abs(mh - 70 / 3508) < 1e-9

    def test_negative_falls_back_to_defaults(self):
        pad_x, pad_y, mh = _norm_params(min_height_px=-5, y_padding_px=-1)
        # Negative inputs are treated as "unset" and fall back to defaults 70 / 12.
        assert abs(pad_x - 12 / 3508) < 1e-9
        assert abs(pad_y - 12 / 3508) < 1e-9
        assert abs(mh - 70 / 3508) < 1e-9

    def test_clamps_too_large(self):
        pad_x, pad_y, mh = _norm_params(min_height_px=99999, y_padding_px=99999)
        assert mh <= 1.0
        assert pad_y <= 0.5


class TestExtractMarkers:
    def test_combined_alpha(self):
        markers = _extract_markers_from_lines(
            [_line("12 (a) Show that x = 3")], page_num=1, page_h=3508, page_w=2480
        )
        assert markers == [Marker(page=1, y=100 / 3508, kind="Q", val="12")]

    def test_combined_roman(self):
        markers = _extract_markers_from_lines(
            [_line("7 (ii) Explain your answer")], page_num=2, page_h=3508, page_w=2480
        )
        assert markers == [Marker(page=2, y=100 / 3508, kind="Q", val="7")]

    def test_punct_marker(self):
        markers = _extract_markers_from_lines(
            [_line("5. Calculate the gradient")], page_num=1, page_h=3508, page_w=2480
        )
        assert markers == [Marker(page=1, y=100 / 3508, kind="Q", val="5")]

    def test_decimal_not_treated_as_question(self):
        markers = _extract_markers_from_lines(
            [_line("14.4 is the coefficient")], page_num=1, page_h=3508, page_w=2480
        )
        assert markers == []

    def test_space_marker_only_when_far_left(self):
        left = _extract_markers_from_lines(
            [_line("3 Find the area", x0=10)], page_num=1, page_h=3508, page_w=1000
        )
        assert left == [Marker(page=1, y=100 / 3508, kind="Q", val="3")]

        right = _extract_markers_from_lines(
            [_line("3 Find the area", x0=200)], page_num=1, page_h=3508, page_w=1000
        )
        assert right == []

    def test_standalone_number_far_left(self):
        markers = _extract_markers_from_lines(
            [_line("8", x0=5)], page_num=1, page_h=3508, page_w=1000
        )
        assert markers == [Marker(page=1, y=100 / 3508, kind="Q", val="8")]

    def test_subpart_alpha(self):
        markers = _extract_markers_from_lines(
            [_line("(b) Hence determine the value")], page_num=1, page_h=3508, page_w=2480
        )
        assert markers == [Marker(page=1, y=100 / 3508, kind="S", val="b")]

    def test_subpart_roman(self):
        markers = _extract_markers_from_lines(
            [_line("(iv) State one limitation")], page_num=1, page_h=3508, page_w=2480
        )
        assert markers == [Marker(page=1, y=100 / 3508, kind="S", val="iv")]

    def test_ignores_body_text(self):
        markers = _extract_markers_from_lines(
            [_line("The diagram shows a right-angled triangle.")],
            page_num=1,
            page_h=3508,
            page_w=2480,
        )
        assert markers == []

    def test_strips_control_chars_before_match(self):
        markers = _extract_markers_from_lines(
            [_line("12​ (a) Part one")], page_num=1, page_h=3508, page_w=2480
        )
        assert markers == [Marker(page=1, y=100 / 3508, kind="Q", val="12")]


class TestDetectProblematicControlChars:
    def test_flags_marker_line_with_control_char(self):
        snippet = detect_problematic_control_chars([_line("12​ (a) hi")])
        assert snippet is not None

    def test_ignores_body_line_with_control_char(self):
        snippet = detect_problematic_control_chars(
            [_line("The diagram shows​ a curve.")]
        )
        assert snippet is None

    def test_clean_lines_ok(self):
        assert detect_problematic_control_chars([_line("1. Compute")]) is None


class TestNormalizeAndDedupe:
    def test_drops_questions_without_boxes(self):
        out = _normalize_and_dedupe_questions([{"boxes": []}, {"boxes": [{"page": 1, "bbox": [0, 0, 1, 1]}]}])
        assert len(out) == 1
        assert out[0]["boxes"] == [{"page": 1, "bbox": [0.0, 0.0, 1.0, 1.0]}]

    def test_dedupes_identical_boxes(self):
        out = _normalize_and_dedupe_questions(
            [
                {
                    "boxes": [
                        {"page": 1, "bbox": [0.1, 0.1, 0.5, 0.2]},
                        {"page": 1, "bbox": [0.1, 0.1, 0.5, 0.2]},
                    ]
                }
            ]
        )
        assert len(out[0]["boxes"]) == 1

    def test_merges_overlapping_same_x_span(self):
        out = _normalize_and_dedupe_questions(
            [
                {
                    "boxes": [
                        {"page": 1, "bbox": [0.10, 0.10, 0.50, 0.30]},
                        {"page": 1, "bbox": [0.10, 0.25, 0.50, 0.45]},
                    ]
                }
            ]
        )
        boxes = out[0]["boxes"]
        assert len(boxes) == 1
        assert boxes[0]["bbox"] == [0.10, 0.10, 0.50, 0.45]

    def test_keeps_touching_vertical_subparts_separate(self):
        out = _normalize_and_dedupe_questions(
            [
                {
                    "boxes": [
                        {"page": 1, "bbox": [0.10, 0.10, 0.50, 0.30]},
                        {"page": 1, "bbox": [0.10, 0.30, 0.50, 0.50]},
                    ]
                }
            ]
        )
        assert len(out[0]["boxes"]) == 2

    def test_keeps_different_x_span_separate(self):
        out = _normalize_and_dedupe_questions(
            [
                {
                    "boxes": [
                        {"page": 1, "bbox": [0.10, 0.10, 0.50, 0.30]},
                        {"page": 1, "bbox": [0.20, 0.20, 0.70, 0.40]},
                    ]
                }
            ]
        )
        assert len(out[0]["boxes"]) == 2

    def test_keeps_pages_separate(self):
        out = _normalize_and_dedupe_questions(
            [
                {
                    "boxes": [
                        {"page": 1, "bbox": [0.10, 0.10, 0.50, 0.30]},
                        {"page": 2, "bbox": [0.10, 0.10, 0.50, 0.30]},
                    ]
                }
            ]
        )
        assert len(out[0]["boxes"]) == 2

    def test_drops_invalid_bbox_length(self):
        out = _normalize_and_dedupe_questions(
            [{"boxes": [{"page": 1, "bbox": [0, 0]}, {"page": 1, "bbox": [0, 0, 1, 1]}]}]
        )
        assert len(out[0]["boxes"]) == 1


class TestQValuesCoherent:
    def test_sequential_run(self):
        assert _q_values_coherent(["1", "2", "3", "4", "5", "6"]) is True

    def test_mid_sequence(self):
        assert _q_values_coherent(["7", "8", "9"]) is True

    def test_math_fragment_noise(self):
        assert _q_values_coherent(["2", "2", "3", "1"]) is False

    def test_non_monotonic(self):
        assert _q_values_coherent(["5", "1", "3"]) is False

    def test_non_integer(self):
        assert _q_values_coherent(["1", "a", "3"]) is False

    def test_empty_and_single(self):
        assert _q_values_coherent([]) is True
        assert _q_values_coherent(["4"]) is True
