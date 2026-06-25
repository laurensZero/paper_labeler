from __future__ import annotations
from datetime import datetime
from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint, create_engine, Column, Boolean, Float
from sqlalchemy.orm import declarative_base, sessionmaker
from backend.config import DATA_DIR

Base = declarative_base()


def _build_engine():
    db_path = (DATA_DIR / "app.db").resolve()
    url = f"sqlite:///{db_path.as_posix()}"
    return create_engine(url, connect_args={"check_same_thread": False})


engine = _build_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, expire_on_commit=False, bind=engine)


def reconnect_db():
    """Dispose the old engine and create a new one pointing at the current DATA_DIR."""
    global engine, SessionLocal
    engine.dispose()
    engine = _build_engine()
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, expire_on_commit=False, bind=engine)


class Paper(Base):
    __tablename__ = "papers"
    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, nullable=False)
    exam_code = Column(String, nullable=True)
    pdf_path = Column(String, nullable=True)
    pages_dir = Column(String, nullable=True)
    page_count = Column(Integer, nullable=True)
    year_token = Column(String, nullable=True, index=True)
    season_token = Column(String, nullable=True, index=True)
    done = Column(Boolean, nullable=False, default=False)
    paired_paper_id = Column(Integer, nullable=True, index=True)
    is_answer = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Question(Base):
    __tablename__ = "questions"
    id = Column(Integer, primary_key=True, index=True)
    paper_id = Column(Integer, ForeignKey("papers.id"), nullable=False, index=True)
    question_no = Column(String, nullable=True)
    section = Column(String, nullable=True)
    status = Column(String, nullable=False, default="confirmed")
    notes = Column(String, nullable=True)
    is_favorite = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class QuestionBox(Base):
    __tablename__ = "question_boxes"
    id = Column(Integer, primary_key=True, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False, index=True)
    paper_id = Column(Integer, ForeignKey("papers.id"), nullable=False, index=True)
    page = Column(Integer, nullable=False, index=True)
    bbox = Column(JSON, nullable=False)
    image_path = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Answer(Base):
    __tablename__ = "answers"
    id = Column(Integer, primary_key=True, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False, index=True)
    ms_paper_id = Column(Integer, ForeignKey("papers.id"), nullable=False, index=True)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    __table_args__ = (UniqueConstraint("question_id", name="uq_answer_question"),)


class AnswerBox(Base):
    __tablename__ = "answer_boxes"
    id = Column(Integer, primary_key=True, index=True)
    answer_id = Column(Integer, ForeignKey("answers.id"), nullable=False, index=True)
    ms_paper_id = Column(Integer, ForeignKey("papers.id"), nullable=False, index=True)
    page = Column(Integer, nullable=False, index=True)
    bbox = Column(JSON, nullable=False)
    image_path = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class SectionDef(Base):
    __tablename__ = "section_defs"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True, index=True)
    content = Column(String, nullable=True)
    color = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SectionGroup(Base):
    __tablename__ = "section_groups"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True, index=True)
    show_in_filter = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SectionGroupMember(Base):
    __tablename__ = "section_group_members"
    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("section_groups.id"), nullable=False, index=True)
    section_name = Column(String, nullable=False, unique=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class QuestionSection(Base):
    __tablename__ = "question_sections"
    id = Column(Integer, primary_key=True, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False, index=True)
    section_name = Column(String, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("question_id", "section_name", name="uq_question_section"),)


class Composition(Base):
    __tablename__ = "compositions"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    title = Column(String, nullable=True)
    header_text = Column(String, nullable=True)
    footer_text = Column(String, nullable=True)
    include_answers = Column(Boolean, nullable=False, default=False)
    answers_placement = Column(String, nullable=False, default="end")
    group_by_section = Column(Boolean, nullable=False, default=True)
    show_section_headers = Column(Boolean, nullable=False, default=True)
    show_question_info = Column(Boolean, nullable=False, default=True)
    show_page_numbers = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CompositionItem(Base):
    __tablename__ = "composition_items"
    id = Column(Integer, primary_key=True, index=True)
    composition_id = Column(Integer, ForeignKey("compositions.id", ondelete="CASCADE"), nullable=False, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False, index=True)
    sort_order = Column(Integer, nullable=False, default=0)
    blank_pages = Column(Integer, nullable=False, default=0)
    item_type = Column(String, nullable=False, default="question")
    score = Column(Float, nullable=True)
    custom_header = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (
        UniqueConstraint("composition_id", "question_id", name="uq_comp_question"),
    )


def init_db():
    Base.metadata.create_all(bind=engine)
    try:
        with engine.begin() as conn:
            cols = {str(r[1]) for r in conn.exec_driver_sql("PRAGMA table_info(papers)").fetchall()}
            if "year_token" not in cols:
                conn.exec_driver_sql("ALTER TABLE papers ADD COLUMN year_token VARCHAR")
            if "season_token" not in cols:
                conn.exec_driver_sql("ALTER TABLE papers ADD COLUMN season_token VARCHAR")
    except Exception:
        pass
    try:
        with engine.begin() as conn:
            cols = {str(r[1]) for r in conn.exec_driver_sql("PRAGMA table_info(section_defs)").fetchall()}
            if "color" not in cols:
                conn.exec_driver_sql("ALTER TABLE section_defs ADD COLUMN color VARCHAR")
    except Exception:
        pass
