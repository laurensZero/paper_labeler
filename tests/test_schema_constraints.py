"""Local SQLite schema constraints that guard labeling + cloud sync."""
from __future__ import annotations

import sqlite3
from datetime import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from backend.database import Paper, Question, Answer, SessionLocal, init_db, engine


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def test_papers_filename_unique(db):
    db.add(Paper(filename="dup_name.pdf", exam_code="dup_name"))
    db.commit()
    db.add(Paper(filename="dup_name.pdf", exam_code="dup_name"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_answers_question_id_unique(db):
    paper = Paper(filename=f"ans_uq_{id(db)}.pdf", exam_code="ans_uq")
    db.add(paper)
    db.commit()
    q = Question(paper_id=paper.id, question_no=None, status="confirmed")
    db.add(q)
    db.commit()
    db.add(Answer(question_id=q.id, ms_paper_id=paper.id))
    db.commit()
    db.add(Answer(question_id=q.id, ms_paper_id=paper.id))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_papers_updated_at_backfills_on_init(tmp_path, monkeypatch):
    """init_db must fill NULL updated_at so cloud dirty-check has a timestamp."""
    init_db()
    raw = sqlite3.connect(str(engine.url.database))
    try:
        raw.execute(
            "INSERT INTO papers (filename, exam_code, is_answer, done, created_at, updated_at) "
            "VALUES ('legacy_null_ts.pdf', 'legacy_null_ts', 0, 0, '2020-01-01 00:00:00', NULL)"
        )
        raw.commit()
        init_db()
        row = raw.execute(
            "SELECT updated_at, created_at FROM papers WHERE filename='legacy_null_ts.pdf'"
        ).fetchone()
        assert row is not None
        assert row[0] is not None
        assert str(row[0]) == str(row[1])
    finally:
        raw.execute("DELETE FROM papers WHERE filename='legacy_null_ts.pdf'")
        raw.commit()
        raw.close()


def test_paper_updated_at_set_on_update(db):
    paper = Paper(filename=f"ts_update_{id(db)}.pdf", exam_code="ts_update")
    db.add(paper)
    db.commit()
    before = paper.updated_at
    paper.exam_code = "ts_update_changed"
    db.commit()
    assert paper.updated_at is not None
    if before is not None:
        assert paper.updated_at >= before
