"""Backup data/ before wiping test bank. Handles live SQLite via backup API."""
from __future__ import annotations

import shutil
import sqlite3
import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path("D:/Projects/paper_labeler")
DATA = ROOT / "data"
BACKUP_DIR = ROOT / "backups"


def backup_sqlite(src: Path, dest: Path) -> None:
    """Consistent copy even if WAL is active."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    src_uri = f"file:{src.as_posix()}?mode=ro"
    src_con = sqlite3.connect(src_uri, uri=True)
    dest_con = sqlite3.connect(str(dest))
    try:
        src_con.backup(dest_con)
        dest_con.commit()
    finally:
        dest_con.close()
        src_con.close()
    print(f"  sqlite backup -> {dest} ({dest.stat().st_size} bytes)")


def main() -> int:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_zip = BACKUP_DIR / f"data_test_{stamp}.zip"
    stage = BACKUP_DIR / f"_stage_data_test_{stamp}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    print(f"staging to {stage}")
    copied = 0
    skipped: list[str] = []

    # 1) SQLite consistent snapshot
    if (DATA / "app.db").exists():
        backup_sqlite(DATA / "app.db", stage / "app.db")
        copied += 1

    # 2) Everything else under data/
    for path in DATA.rglob("*"):
        rel = path.relative_to(DATA)
        if path.is_dir():
            (stage / rel).mkdir(parents=True, exist_ok=True)
            continue
        if path.name in ("app.db", "app.db-shm", "app.db-wal"):
            continue  # already snapshotted via sqlite backup
        dest = stage / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(path, dest)
            copied += 1
        except OSError as exc:
            skipped.append(f"{rel}: {exc}")
            print(f"  SKIP {rel}: {exc}")

    print(f"copied {copied} files, skipped {len(skipped)}")
    for s in skipped:
        print("  ", s)

    # 3) Zip the stage
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    if out_zip.exists():
        out_zip.unlink()
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in stage.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(stage))
    print(f"zip -> {out_zip} ({out_zip.stat().st_size} bytes)")

    # 4) Keep an uncompressed folder copy too (easier to inspect / restore)
    keep = BACKUP_DIR / f"data_test_{stamp}"
    if keep.exists():
        shutil.rmtree(keep)
    shutil.copytree(stage, keep)
    print(f"folder -> {keep}")

    # cleanup stage
    shutil.rmtree(stage, ignore_errors=True)

    # manifest
    manifest = BACKUP_DIR / f"data_test_{stamp}_manifest.txt"
    lines = [
        f"backup_time: {stamp}",
        f"source: {DATA}",
        f"zip: {out_zip}",
        f"folder: {keep}",
        f"copied_files: {copied}",
        f"skipped: {len(skipped)}",
    ]
    lines.extend(skipped)
    # counts
    for sub in ("pages", "pdfs", "_export_jobs", "logs"):
        p = DATA / sub
        if p.exists():
            n = sum(1 for _ in p.rglob("*") if _.is_file())
            lines.append(f"{sub}_files: {n}")
    if (DATA / "app.db").exists():
        con = sqlite3.connect(str(stage / "app.db") if (stage / "app.db").exists() else str(keep / "app.db"))
        try:
            for t in ("papers", "questions", "question_boxes", "answers", "answer_boxes"):
                try:
                    cur = con.execute(f"SELECT COUNT(*) FROM {t}")
                    lines.append(f"{t}: {cur.fetchone()[0]}")
                except Exception:
                    pass
        finally:
            con.close()
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"manifest -> {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
