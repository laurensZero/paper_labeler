"""API smoke tests: app boots, core routes respond, basic CRUD works."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from backend.config import DATA_DIR, PAGE_DIR
from backend.database import Paper, SessionLocal


def _make_paper(db, *, filename: str = "9709_s23_qp_1.pdf", exam_code: str = "9709_s23_qp_1") -> Paper:
    paper = Paper(filename=filename, exam_code=exam_code, page_count=1, done=False)
    db.add(paper)
    db.commit()
    db.refresh(paper)
    return paper


def _make_page_image(paper_id: int, page: int = 1) -> Path:
    pages_dir = PAGE_DIR / f"paper_{paper_id}"
    pages_dir.mkdir(parents=True, exist_ok=True)
    img_path = pages_dir / f"page_{page}.png"
    Image.new("RGB", (80, 120), (240, 240, 240)).save(img_path, "PNG")
    return img_path


class TestAppBoots:
    def test_root(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert resp.json().get("message")

    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_version(self, client):
        resp = client.get("/version")
        assert resp.status_code == 200
        assert "version" in resp.json()

    def test_debug_paths(self, client):
        resp = client.get("/debug/paths")
        assert resp.status_code == 200
        body = resp.json()
        assert body["DATA_DIR_exists"] is True


class TestPapersRoutes:
    def test_list_empty(self, client):
        resp = client.get("/papers")
        assert resp.status_code == 200

    def test_list_filenames(self, client):
        resp = client.get("/papers/filenames")
        assert resp.status_code == 200

    def test_get_missing_paper_404(self, client):
        resp = client.get("/papers/999999")
        assert resp.status_code == 404

    def test_create_and_read_paper(self, client):
        db = SessionLocal()
        try:
            paper = _make_paper(db)
        finally:
            db.close()
        resp = client.get(f"/papers/{paper.id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == paper.id

    def test_patch_paper(self, client):
        db = SessionLocal()
        try:
            paper = _make_paper(db)
        finally:
            db.close()
        resp = client.patch(f"/papers/{paper.id}", json={"done": True, "exam_code": "9709_s23_qp_9"})
        assert resp.status_code == 200


class TestSectionRoutes:
    def test_list_sections_empty(self, client):
        resp = client.get("/sections")
        assert resp.status_code == 200

    def test_section_def_crud(self, client):
        created = client.post("/section_defs", json={"name": "Mechanics", "content": "forces"})
        assert created.status_code == 200
        section_id = created.json()["section"]["id"]

        listed = client.get("/section_defs")
        assert listed.status_code == 200
        names = [s["name"] for s in listed.json()["sections"]]
        assert "Mechanics" in names

        updated = client.patch(f"/section_defs/{section_id}", json={"color": "#ff0000"})
        assert updated.status_code == 200

        deleted = client.delete(f"/section_defs/{section_id}")
        assert deleted.status_code == 200

        listed_after = client.get("/section_defs")
        assert "Mechanics" not in [s["name"] for s in listed_after.json()["sections"]]

    def test_duplicate_section_name_conflict(self, client):
        assert client.post("/section_defs", json={"name": "Dup"}).status_code == 200
        again = client.post("/section_defs", json={"name": "Dup"})
        assert again.status_code == 409

    def test_empty_section_name_rejected(self, client):
        resp = client.post("/section_defs", json={"name": "   "})
        assert resp.status_code == 400

    def test_section_group_crud(self, client):
        created = client.post("/section_groups", json={"name": "Pure Math", "show_in_filter": True})
        assert created.status_code == 200
        group_id = created.json()["group"]["id"]

        listed = client.get("/section_groups")
        assert listed.status_code == 200

        deleted = client.delete(f"/section_groups/{group_id}")
        assert deleted.status_code == 200


class TestQuestionRoutes:
    def test_search_empty(self, client):
        resp = client.post("/questions/search", json={"page": 1, "page_size": 10})
        assert resp.status_code == 200

    def test_search_summary_only_is_lean(self, client):
        db = SessionLocal()
        try:
            paper = _make_paper(db)
        finally:
            db.close()
        _make_page_image(paper.id)
        created = client.post(
            f"/papers/{paper.id}/questions",
            json={
                "boxes": [{"page": 1, "bbox": [0.1, 0.1, 0.5, 0.3]}],
                "sections": ["Mechanics"],
                "status": "confirmed",
            },
        )
        assert created.status_code == 200

        resp = client.post(
            "/questions/search",
            json={"page": 1, "page_size": 1000, "summary_only": True},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["page_size"] == 1000
        assert body["questions"]
        row = body["questions"][0]
        assert set(row.keys()) == {"id", "question_no", "is_favorite", "section", "sections"}
        assert "boxes" not in row
        assert "preview_image_url" not in row

    def test_get_missing_question_404(self, client):
        resp = client.get("/questions/999999")
        assert resp.status_code == 404

    def test_create_question_requires_boxes(self, client):
        db = SessionLocal()
        try:
            paper = _make_paper(db)
        finally:
            db.close()
        _make_page_image(paper.id)
        resp = client.post(
            f"/papers/{paper.id}/questions",
            json={"boxes": [], "status": "confirmed"},
        )
        assert resp.status_code == 400

    def test_create_and_read_question(self, client):
        db = SessionLocal()
        try:
            paper = _make_paper(db)
        finally:
            db.close()
        _make_page_image(paper.id)
        created = client.post(
            f"/papers/{paper.id}/questions",
            json={
                "boxes": [{"page": 1, "bbox": [0.1, 0.1, 0.5, 0.3]}],
                "sections": ["Mechanics"],
                "status": "confirmed",
                "notes": "smoke",
            },
        )
        assert created.status_code == 200
        qid = created.json()["question"]["id"]

        fetched = client.get(f"/questions/{qid}")
        assert fetched.status_code == 200
        assert fetched.json()["question"]["id"] == qid

        listed = client.get(f"/papers/{paper.id}/questions")
        assert listed.status_code == 200

        updated = client.patch(f"/questions/{qid}", json={"is_favorite": True})
        assert updated.status_code == 200

        deleted = client.delete(f"/questions/{qid}")
        assert deleted.status_code == 200

    def test_batch_update_validation(self, client):
        resp = client.post("/questions/batch_update", json={"ids": []})
        assert resp.status_code == 422

    def test_random_pick_requires_sections_config(self, client):
        resp = client.post("/questions/random_pick", json={"count": 1, "sections": {}})
        assert resp.status_code == 400

    def test_random_pick_accepts_config(self, client):
        resp = client.post("/questions/random_pick", json={"sections": {"Mechanics": 1}})
        assert resp.status_code == 200
        body = resp.json()
        assert "ids" in body
        assert "question_ids" in body


class TestExportHelpersViaApi:
    def test_export_job_requires_ids_field(self, client):
        resp = client.post("/export/questions_pdf_job", json={"options": {}})
        assert resp.status_code == 422

    def test_export_job_rejects_bad_id_type(self, client):
        resp = client.post("/export/questions_pdf_job", json={"ids": ["a"]})
        assert resp.status_code == 422

    def test_export_status_missing_job(self, client):
        resp = client.get("/export/questions_pdf_job/does-not-exist")
        assert resp.status_code in (404, 400)
