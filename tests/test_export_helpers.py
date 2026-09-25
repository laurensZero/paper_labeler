from PIL import Image

from backend.routers.export import (
    _crop_image_with_bbox,
    _normalize_filter_summary_lines,
    _sanitize_download_filename,
)


class TestSanitizeDownloadFilename:
    def test_default_when_empty(self):
        assert _sanitize_download_filename("", "export.pdf") == "export.pdf"
        assert _sanitize_download_filename(None, "export.pdf") == "export.pdf"

    def test_replaces_illegal_chars(self):
        name = _sanitize_download_filename('a/b\\c:d*e?f"g<h>i|j.pdf', "d.pdf")
        assert "/" not in name
        assert "\\" not in name
        assert ":" not in name
        assert "*" not in name
        assert "?" not in name
        assert '"' not in name
        assert "<" not in name
        assert ">" not in name
        assert "|" not in name
        assert name.endswith(".pdf")

    def test_appends_pdf_suffix(self):
        assert _sanitize_download_filename("my-export", "d.pdf") == "my-export.pdf"

    def test_truncates_long_names(self):
        name = _sanitize_download_filename("x" * 300, "d.pdf")
        assert len(name) <= 160
        assert name.endswith(".pdf")

    def test_strips_trailing_dots(self):
        name = _sanitize_download_filename("  report...  ", "d.pdf")
        assert name == "report.pdf"


class TestNormalizeFilterSummaryLines:
    def test_empty(self):
        assert _normalize_filter_summary_lines(None) == []
        assert _normalize_filter_summary_lines([]) == []
        assert _normalize_filter_summary_lines(["  ", ""]) == []

    def test_relabels_known_prefixes(self):
        out = _normalize_filter_summary_lines(
            ["任意: Mechanics", "whatever: 2023", "ignored: s23"]
        )
        # Labels are positional: Section / Paper / Year / Season / Favorites / Count
        assert out[0] == "Section: Mechanics"
        assert out[1] == "Paper: 2023"
        assert out[2] == "Year: s23"

    def test_keeps_extra_lines(self):
        out = _normalize_filter_summary_lines(
            ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6", "raw extra"]
        )
        assert out[-1] == "raw extra"

    def test_keeps_lines_without_separator(self):
        assert _normalize_filter_summary_lines(["plain line"]) == ["plain line"]


class TestCropImageWithBbox:
    def test_crops_normalized_bbox(self):
        img = Image.new("RGB", (100, 200), (255, 0, 0))
        cropped = _crop_image_with_bbox(img, [0.1, 0.1, 0.5, 0.5])
        assert cropped.size == (40, 80)

    def test_clamps_out_of_range_bbox(self):
        img = Image.new("RGB", (100, 100), (0, 255, 0))
        cropped = _crop_image_with_bbox(img, [-1, -1, 2, 2])
        assert cropped.size == (100, 100)

    def test_reversed_bbox_still_valid(self):
        img = Image.new("RGB", (100, 100), (0, 0, 255))
        cropped = _crop_image_with_bbox(img, [0.8, 0.8, 0.2, 0.2])
        assert cropped.size[0] >= 0
        assert cropped.size[1] >= 0
