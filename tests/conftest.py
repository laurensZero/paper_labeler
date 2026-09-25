"""Test bootstrap: isolate DATA_DIR before any backend import."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# config.py resolves APP_DIR from PAPER_LABELER_ROOT only when that root
# already contains a data/ directory. Create a throwaway root first so every
# test run writes into a temp tree instead of the real project data/.
_TMP_ROOT = Path(tempfile.mkdtemp(prefix="paper_labeler_test_"))
(_TMP_ROOT / "data").mkdir(parents=True, exist_ok=True)
os.environ["PAPER_LABELER_ROOT"] = str(_TMP_ROOT)

from backend.database import init_db  # noqa: E402
from backend.config import DATA_DIR  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _init_database() -> None:
    init_db()
    assert DATA_DIR == _TMP_ROOT / "data"
    assert DATA_DIR.exists()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from backend.main import app

    with TestClient(app) as c:
        yield c
