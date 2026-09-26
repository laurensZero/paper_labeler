"""Tests for the staged CIE import pipeline (mocked I/O)."""
from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.services import import_pipeline as ip


class FakeDB:
    def __init__(self, existing=None):
        self.added = []
        self.deleted = []
        self.committed = 0
        self._existing = existing
        self._papers = {}
        self._next_id = 1

    def query(self, model):
        existing = self._existing
        papers = self._papers

        class Q:
            def filter(self, *a, **k):
                return self

            def first(self):
                if existing is not None:
                    return existing
                # return most recently added paper if any
                if papers:
                    return list(papers.values())[-1]
                return None

        return Q()

    def add(self, obj):
        self.added.append(obj)
        if getattr(obj, "id", None) is None:
            obj.id = self._next_id
            self._next_id += 1
        self._papers[obj.id] = obj

    def delete(self, obj):
        self.deleted.append(obj)
        self._papers.pop(getattr(obj, "id", None), None)

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def refresh(self, obj):
        pass


def make_ctx(**kwargs):
    defaults = dict(url="https://x.test/a.pdf", filename="a.pdf")
    defaults.update(kwargs)
    return ip.ImportContext(**defaults)


def test_stage_weights_sum_to_one():
    assert abs(sum(ip.STAGE_WEIGHTS.values()) - 1.0) < 1e-9
    assert set(ip.STAGE_ORDER) == set(ip.STAGE_WEIGHTS)


def test_stage_frac_monotonic():
    assert ip.stage_frac("download", 0.0) == 0.0
    assert ip.stage_frac("download", 1.0) == pytest.approx(0.30)
    assert ip.stage_frac("render", 0.0) == pytest.approx(0.35)
    assert ip.stage_frac("ocr", 1.0) == pytest.approx(1.0)
    assert ip.stage_frac("download", 2.0) == pytest.approx(0.30)  # clamped


def test_validate_target_rejects_bad_input(tmp_path):
    with pytest.raises(HTTPException):
        ip.validate_target(make_ctx(url=""), FakeDB())
    with pytest.raises(HTTPException):
        ip.validate_target(make_ctx(url="ftp://x/a.pdf"), FakeDB())
    with pytest.raises(HTTPException):
        ip.validate_target(make_ctx(filename="a.txt"), FakeDB())


def test_validate_target_rejects_duplicate():
    existing = SimpleNamespace(id=9, filename="a.pdf")
    with pytest.raises(HTTPException) as ei:
        ip.validate_target(make_ctx(), FakeDB(existing=existing))
    assert ei.value.status_code == 409


def test_emit_collects_structured_events():
    events = []
    ctx = make_ctx(on_event=events.append)
    ctx.emit("download", "progress", 0.5)
    assert events[-1]["item"] == "a.pdf"
    assert events[-1]["stage"] == "download"
    assert events[-1]["frac"] == pytest.approx(0.15)
    assert events[-1]["status"] == "progress"
    ctx.emit("download", "start", 0.0, error="boom")
    assert events[-1]["error"] == "boom"


def test_run_import_stage_order(monkeypatch, tmp_path):
    order = []
    events = []

    def track(name):
        def _f(*a, **k):
            order.append(name)
        return _f

    monkeypatch.setattr(ip, "validate_target", track("validate") or ip.validate_target)

    def wrap(name, fn):
        def _w(*a, **k):
            order.append(name)
            return fn(*a, **k)
        return _w

    monkeypatch.setattr(ip, "validate_target", wrap("validate", lambda *a, **k: None))
    monkeypatch.setattr(ip, "download_pdf", wrap("download", lambda ctx: setattr(ctx, "tmp_path", tmp_path / "t.pdf") or (tmp_path / "t.pdf").write_bytes(b"%PDF")))
    monkeypatch.setattr(ip, "register_paper", wrap("register", lambda ctx, db: SimpleNamespace(id=1)))
    monkeypatch.setattr(ip, "render_pages", wrap("render", lambda ctx: setattr(ctx, "page_count", 1) or 1))
    monkeypatch.setattr(ip, "analyze_meta", wrap("analyze", lambda ctx, db: None))
    monkeypatch.setattr(ip, "run_ocr", wrap("ocr", lambda ctx, db: None))
    monkeypatch.setattr(ip, "finalize", wrap("finalize", lambda ctx, db: {"paper": {"id": 1}}))

    ctx = make_ctx(on_event=events.append)
    result = ip.run_import(ctx, FakeDB())
    assert result["paper"]["id"] == 1
    assert order == ["validate", "download", "register", "render", "analyze", "ocr", "finalize"]


def test_run_import_rolls_back_on_failure(monkeypatch, tmp_path):
    rolled = []

    monkeypatch.setattr(ip, "validate_target", lambda ctx, db: None)

    def boom(ctx):
        ctx.tmp_path = tmp_path / "t.pdf"
        ctx.tmp_path.write_bytes(b"x")
        raise HTTPException(status_code=500, detail="render died")

    monkeypatch.setattr(ip, "download_pdf", boom)
    monkeypatch.setattr(ip, "rollback_import", lambda ctx, db: rolled.append(True))

    ctx = make_ctx()
    with pytest.raises(HTTPException):
        ip.run_import(ctx, FakeDB())
    assert rolled == [True]


def test_rollback_clears_tmp(tmp_path):
    f = tmp_path / "t.pdf"
    f.write_bytes(b"x")
    ctx = make_ctx(tmp_path=f)
    ip.rollback_import(ctx, FakeDB())
    assert not f.exists()


def test_render_pages_reports_progress(monkeypatch, tmp_path):
    events = []
    ctx = make_ctx(paper_id=3, on_event=events.append)
    ctx.pdf_path = tmp_path / "p.pdf"
    ctx.pdf_path.write_bytes(b"%PDF")

    def fake_render(pdf, out, on_progress=None):
        if on_progress:
            on_progress(1, 2)
            on_progress(2, 2)
        return 2

    monkeypatch.setattr(ip, "render_pdf_to_images", fake_render)
    n = ip.render_pages(ctx)
    assert n == 2
    assert any(e["stage"] == "render" and e["frac"] > 0 for e in events)
