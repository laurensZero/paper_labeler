from backend.utils import _file_mtime_token, _with_cache_bust


class TestFileMtimeToken:
    def test_returns_integer_string(self, tmp_path):
        p = tmp_path / "a.png"
        p.write_bytes(b"x")
        token = _file_mtime_token(p)
        assert token is not None
        assert token.isdigit()

    def test_missing_file_returns_none(self, tmp_path):
        assert _file_mtime_token(tmp_path / "nope.png") is None


class TestWithCacheBust:
    def test_appends_query_param(self):
        assert _with_cache_bust("/data/pages/page_1.png", "171000") == "/data/pages/page_1.png?v=171000"

    def test_appends_with_ampersand_when_query_exists(self):
        assert _with_cache_bust("/a.png?x=1", "9") == "/a.png?x=1&v=9"

    def test_empty_token_unchanged(self):
        assert _with_cache_bust("/a.png", None) == "/a.png"
        assert _with_cache_bust("/a.png", "") == "/a.png"
