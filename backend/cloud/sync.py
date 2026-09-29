"""标注端 → 云端 同步引擎（设计稿 §4）。

流程：脏扫描 → 元数据 upsert → 题图裁剪/转 webp 传 R2 → 写 sync_log。
幂等可重入：以 source_updated_at（问题级）与 content_hash（图片级）做增量；
本地硬删除在云端转为 deleted_at 软删（tombstone）。

约定：本地是题库唯一写入口；本模块只出不进。
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from backend.cloud import r2, supabase
from backend.cloud.config import CloudConfig

logger = logging.getLogger(__name__)

# R2 单次 PUT 约 2s（延迟主导），并行上传；仅影响传图，元数据仍单线程
_UPLOAD_WORKERS = 6


@dataclass
class SyncSummary:
    ok: bool = False
    phase: str = "init"
    started_at: str = ""
    finished_at: str = ""
    duration_s: float = 0.0
    counts: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    resurrected: list[int] = field(default_factory=list)  # 本地仍存在但云端已 tombstone 的 id（疑似 id 复用）

    def bump(self, key: str, n: int = 1) -> None:
        self.counts[key] = self.counts.get(key, 0) + n

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "phase": self.phase,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_s": self.duration_s,
            "counts": self.counts,
            "errors": self.errors[:50],
            "error_count": len(self.errors),
            "resurrected": self.resurrected[:50],
        }


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.isoformat() + "Z"  # 本地库统一存 UTC naive
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _clamp01(v: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, x))


def crop_fingerprint(box) -> str:
    """图片内容指纹：源页图 stat + bbox。页图或框任一变更即变化。

    不直接哈希像素：全库同步时按页 stat 比对，毫秒级完成。
    """
    p = Path(str(getattr(box, "image_path", "") or ""))
    try:
        st = p.stat()
        meta = f"{p.resolve()}|{st.st_mtime_ns}|{st.st_size}"
    except OSError:
        meta = f"{p}|missing"
    bbox = ",".join(f"{_clamp01(x):.6f}" for x in list(getattr(box, "bbox", []) or [])[:4])
    return hashlib.sha256(f"{meta}|{bbox}".encode("utf-8")).hexdigest()


def crop_webp(box, quality: int = 88) -> bytes | None:
    """按归一化 bbox 从页图裁剪，编码为 webp 字节。源缺失返回 None。"""
    from PIL import Image

    bbox = list(getattr(box, "bbox", []) or [])
    if len(bbox) != 4:
        return None
    src = Path(str(getattr(box, "image_path", "") or ""))
    if not src.exists():
        return None
    try:
        with Image.open(src) as img:
            img = img.convert("RGB")
            w, h = img.size
            x0, x1 = sorted((_clamp01(bbox[0]), _clamp01(bbox[2])))
            y0, y1 = sorted((_clamp01(bbox[1]), _clamp01(bbox[3])))
            left = max(0, min(w - 1, int(round(x0 * w))))
            top = max(0, min(h - 1, int(round(y0 * h))))
            right = max(left + 1, min(w, int(round(x1 * w))))
            bottom = max(top + 1, min(h, int(round(y1 * h))))
            crop = img.crop((left, top, right, bottom))
            buf = io.BytesIO()
            crop.save(buf, "WEBP", quality=quality)
            return buf.getvalue()
    except OSError:
        return None


def _in_filter(column: str, ids: list) -> dict[str, str]:
    return {column: f"in.({','.join(str(i) for i in ids)})"}


def _chunked(ids: list, size: int = 400):
    for i in range(0, len(ids), size):
        yield ids[i : i + size]


def _is_dirty(local_updated: datetime | None, cloud_source_ts: str | None) -> bool:
    local = _as_utc(local_updated)
    cloud = _parse_ts(cloud_source_ts)
    if local is None:
        return False
    if cloud is None:
        return True
    return local > cloud


def run_sync(cfg: CloudConfig, summary: SyncSummary) -> None:
    from backend.database import (
        Answer,
        AnswerBox,
        Paper,
        Question,
        QuestionBox,
        QuestionSection,
        SectionDef,
        SectionGroup,
        SectionGroupMember,
        SessionLocal,
    )

    t0 = time.monotonic()
    summary.started_at = _iso(datetime.now(timezone.utc)) or ""
    now_iso = summary.started_at

    # ---------- 1. 拉云端现状（脏检查基线） ----------
    summary.phase = "fetch_cloud"
    cloud_papers = supabase.select(cfg, "papers", "id,source_updated_at,deleted_at")
    cloud_questions = supabase.select(cfg, "questions", "id,source_updated_at,deleted_at")
    cloud_answers = supabase.select(cfg, "answers", "id,source_updated_at,deleted_at")
    cloud_sdefs = supabase.select(cfg, "section_defs", "id,source_updated_at,deleted_at")
    cloud_sgroups = supabase.select(cfg, "section_groups", "id,source_updated_at,deleted_at")
    cloud_qsections = supabase.select(cfg, "question_sections", "question_id,section_name")
    cloud_gmembers = supabase.select(cfg, "section_group_members", "group_id,section_name")
    cloud_qboxes = supabase.select(cfg, "question_boxes", "id,question_id,image_key,content_hash")
    cloud_aboxes = supabase.select(cfg, "answer_boxes", "id,answer_id,image_key,content_hash")

    with SessionLocal() as db:
        papers = db.query(Paper).all()
        questions = db.query(Question).all()
        answers = db.query(Answer).all()
        sdefs = db.query(SectionDef).all()
        sgroups = db.query(SectionGroup).all()
        gmembers = db.query(SectionGroupMember).all()
        qsections = db.query(QuestionSection).all()
        qboxes = db.query(QuestionBox).all()
        aboxes = db.query(AnswerBox).all()

        # ---------- 2. papers（量小，全量 upsert） ----------
        summary.phase = "papers"
        paper_rows = [
            {
                "id": p.id,
                "filename": p.filename,
                "exam_code": p.exam_code,
                "year_token": p.year_token,
                "season_token": p.season_token,
                "is_answer": bool(p.is_answer),
                "paired_paper_id": p.paired_paper_id,
                "page_count": p.page_count,
                "done": bool(p.done),
                "source_updated_at": _iso(getattr(p, "updated_at", None) or p.created_at),
                "deleted_at": None,
            }
            for p in papers
        ]
        supabase.upsert(cfg, "papers", paper_rows)
        summary.bump("papers_upserted", len(paper_rows))
        summary.bump(
            "papers_tombstoned",
            _tombstone(cfg, "papers", cloud_papers, {p.id for p in papers}, now_iso),
        )

        # ---------- 3. questions（updated_at 脏检查） ----------
        summary.phase = "questions"
        cloud_q = {r["id"]: r for r in cloud_questions}
        dirty_questions = []
        for q in questions:
            cl = cloud_q.get(q.id)
            if cl is None or cl.get("deleted_at") is not None:
                if cl is not None and cl.get("deleted_at") is not None:
                    summary.resurrected.append(q.id)
                    logger.warning("question %s 云端已 tombstone 但本地存在，按复活推送（注意 id 复用）", q.id)
                dirty_questions.append(q)
            elif _is_dirty(q.updated_at, cl.get("source_updated_at")):
                dirty_questions.append(q)

        question_rows = [
            {
                "id": q.id,
                "paper_id": q.paper_id,
                "question_no": q.question_no,
                "section": q.section,
                "status": q.status or "confirmed",
                "notes": q.notes,
                "is_favorite": bool(q.is_favorite),
                "difficulty": getattr(q, "difficulty", None),
                "source_updated_at": _iso(q.updated_at),
                "updated_at": _iso(q.updated_at),
                "deleted_at": None,
            }
            for q in dirty_questions
        ]
        supabase.upsert(cfg, "questions", question_rows)
        summary.bump("questions_upserted", len(question_rows))
        summary.bump(
            "questions_tombstoned",
            _tombstone(cfg, "questions", cloud_questions, {q.id for q in questions}, now_iso),
        )

        # ---------- 4. question_sections（整表 diff，覆盖不更新 updated_at 的改标签） ----------
        summary.phase = "question_sections"
        _sync_link_rows(
            cfg,
            summary,
            table="question_sections",
            parent_col="question_id",
            desired=[(qs.question_id, qs.section_name) for qs in qsections],
            cloud_rows=[(r["question_id"], r["section_name"]) for r in cloud_qsections],
            row_factory=lambda pair: {"question_id": pair[0], "section_name": pair[1]},
            key_index=0,
        )

        # ---------- 5. answers ----------
        summary.phase = "answers"
        cloud_a = {r["id"]: r for r in cloud_answers}
        dirty_answers = []
        for a in answers:
            cl = cloud_a.get(a.id)
            if cl is None or cl.get("deleted_at") is not None:
                dirty_answers.append(a)
            elif _is_dirty(a.updated_at, cl.get("source_updated_at")):
                dirty_answers.append(a)
        answer_rows = [
            {
                "id": a.id,
                "question_id": a.question_id,
                "ms_paper_id": a.ms_paper_id,
                "notes": a.notes,
                "source_updated_at": _iso(a.updated_at),
                "updated_at": _iso(a.updated_at),
                "deleted_at": None,
            }
            for a in dirty_answers
        ]
        supabase.upsert(cfg, "answers", answer_rows)
        summary.bump("answers_upserted", len(answer_rows))
        summary.bump(
            "answers_tombstoned",
            _tombstone(cfg, "answers", cloud_answers, {a.id for a in answers}, now_iso),
        )

        # ---------- 6. 分类字典 ----------
        summary.phase = "sections"
        sdef_rows = [
            {
                "id": s.id,
                "name": s.name,
                "content": s.content,
                "color": s.color,
                "source_updated_at": _iso(s.updated_at),
                "deleted_at": None,
            }
            for s in sdefs
        ]
        supabase.upsert(cfg, "section_defs", sdef_rows)
        summary.bump("section_defs_upserted", len(sdef_rows))
        summary.bump(
            "section_defs_tombstoned",
            _tombstone(cfg, "section_defs", cloud_sdefs, {s.id for s in sdefs}, now_iso),
        )

        sgroup_rows = [
            {
                "id": g.id,
                "name": g.name,
                "show_in_filter": bool(g.show_in_filter),
                "source_updated_at": _iso(g.updated_at),
                "deleted_at": None,
            }
            for g in sgroups
        ]
        supabase.upsert(cfg, "section_groups", sgroup_rows)
        summary.bump("section_groups_upserted", len(sgroup_rows))
        summary.bump(
            "section_groups_tombstoned",
            _tombstone(cfg, "section_groups", cloud_sgroups, {g.id for g in sgroups}, now_iso),
        )

        _sync_link_rows(
            cfg,
            summary,
            table="section_group_members",
            parent_col="section_name",
            desired=[(m.section_name, m.group_id) for m in gmembers],
            cloud_rows=[(r["section_name"], r["group_id"]) for r in cloud_gmembers],
            row_factory=lambda pair: {"section_name": pair[0], "group_id": pair[1]},
            key_index=0,
        )

        # ---------- 7. 题图：裁剪 → webp → R2 → 元数据 upsert ----------
        summary.phase = "question_boxes"
        _sync_boxes(
            cfg,
            summary,
            table="question_boxes",
            cloud_rows={r["id"]: r for r in cloud_qboxes},
            local_boxes=qboxes,
            # 按试卷分文件夹：R2 无真实目录，前缀只是组织方式；试卷归属稳定不会因改标签变动
            key_of=lambda b: f"papers/{b.paper_id}/q{b.question_id}_{b.id}.webp",
            count_prefix="qbox",
        )

        summary.phase = "answer_boxes"
        _sync_boxes(
            cfg,
            summary,
            table="answer_boxes",
            cloud_rows={r["id"]: r for r in cloud_aboxes},
            local_boxes=aboxes,
            key_of=lambda b: f"papers/{b.ms_paper_id}/a{b.answer_id}_{b.id}.webp",
            count_prefix="abox",
        )

        # ---------- 8. sync_log 审计 ----------
        summary.phase = "sync_log"
        try:
            supabase.insert(
                cfg,
                "sync_log",
                [
                    {
                        "entity": "sync_run",
                        "entity_id": "*",
                        "action": "push",
                        "payload_hash": hashlib.sha256(
                            json.dumps(summary.counts, sort_keys=True).encode()
                        ).hexdigest()[:32],
                    }
                ],
            )
        except supabase.SupabaseError as exc:
            # 审计失败不影响数据一致性
            summary.errors.append(f"sync_log: {exc}")

    summary.ok = not summary.errors
    summary.phase = "done" if summary.ok else "done_with_errors"
    summary.finished_at = _iso(datetime.now(timezone.utc)) or ""
    summary.duration_s = round(time.monotonic() - t0, 2)


def _tombstone(cfg: CloudConfig, table: str, cloud_rows: list[dict], local_ids: set, now_iso: str) -> int:
    """云端存在但本地已删除的行 → deleted_at 软删。返回处理条数。"""
    stale = [r["id"] for r in cloud_rows if r["id"] not in local_ids and not r.get("deleted_at")]
    if not stale:
        return 0
    total = 0
    for chunk in _chunked(stale):
        total += supabase.patch(cfg, table, _in_filter("id", chunk), {"deleted_at": now_iso})
    return total


def _sync_link_rows(
    cfg: CloudConfig,
    summary: SyncSummary,
    *,
    table: str,
    parent_col: str,
    desired: list[tuple],
    cloud_rows: list[tuple],
    row_factory,
    key_index: int = 0,
) -> None:
    """链接表整表 diff：按父键分组做 delete+insert（replace 语义，幂等）。"""
    desired_set = set(desired)
    cloud_set = set(cloud_rows)
    if desired_set == cloud_set:
        return
    changed_keys = {pair[key_index] for pair in (desired_set ^ cloud_set)}
    if not changed_keys:
        return
    for key in changed_keys:
        supabase.delete_filtered(cfg, table, {parent_col: f"eq.{key}"})
        summary.bump(f"{table}_deleted")
    reinsert = [pair for pair in desired if pair[key_index] in changed_keys]
    supabase.insert(cfg, table, [row_factory(p) for p in reinsert])
    summary.bump(f"{table}_inserted", len(reinsert))


def _upload_box(cfg: CloudConfig, box, key: str) -> tuple[bool, str | None]:
    """裁剪并上传单个框图（线程池 worker）。返回 (成功, 错误信息)。"""
    data = crop_webp(box)
    if data is None:
        return False, f"本地源图缺失或 bbox 非法: {getattr(box, 'image_path', '')}"
    try:
        r2.put_object(cfg, key, data)
        return True, None
    except r2.R2Error as exc:
        return False, f"R2 上传失败: {exc}"


def _sync_boxes(
    cfg: CloudConfig,
    summary: SyncSummary,
    *,
    table: str,
    cloud_rows: dict[int, dict],
    local_boxes: list,
    key_of,
    count_prefix: str,
) -> None:
    """题图同步：指纹一致跳过；否则并行裁剪上传（失败保留旧 hash 下次重试）。

    指纹含 image_key，因此 key 约定变更会自动触发全量重传。
    """
    pending: list[tuple] = []  # (box, key, fingerprint, cloud_row|None)
    local_ids: set[int] = set()
    for b in local_boxes:
        local_ids.add(int(b.id))
        key = key_of(b)
        fp = crop_fingerprint(b)
        cl = cloud_rows.get(int(b.id))
        if cl is not None and cl.get("content_hash") == fp and cl.get("image_key") == key:
            continue  # 图片与元数据均未变化
        pending.append((b, key, fp, cl))

    uploaded_ok: dict[int, bool] = {}
    upload_errors: list[str] = []
    n_uploaded = 0
    if pending:
        workers = max(1, min(_UPLOAD_WORKERS, len(pending)))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="r2up") as pool:
            futures = {pool.submit(_upload_box, cfg, b, key): (b, key) for b, key, _, _ in pending}
            for fut in as_completed(futures):
                b, key = futures[fut]
                try:
                    ok, err = fut.result()
                except Exception as exc:  # 防御：worker 异常不能中断整轮同步
                    ok, err = False, f"上传异常: {exc}"
                uploaded_ok[int(b.id)] = ok
                if ok:
                    n_uploaded += 1
                elif err:
                    upload_errors.append(f"{table}[{b.id}] {err}")

    meta_rows: list[dict] = []
    for b, key, fp, cl in pending:
        uploaded = uploaded_ok.get(int(b.id), False)
        parent_key = "question_id" if table == "question_boxes" else "answer_id"
        paper_key = "paper_id" if table == "question_boxes" else "ms_paper_id"
        meta_rows.append(
            {
                "id": b.id,
                parent_key: getattr(b, parent_key),
                paper_key: getattr(b, paper_key),
                "page": b.page,
                "bbox": b.bbox,
                "image_key": key if (uploaded or cl is None) else (cl.get("image_key") or key),
                "content_hash": fp if uploaded else (cl.get("content_hash") if cl else None),
            }
        )

    if meta_rows:
        supabase.upsert(cfg, table, meta_rows)
        summary.bump(f"{count_prefix}_upserted", len(meta_rows))
    summary.bump(f"{count_prefix}_uploaded", n_uploaded)
    summary.errors.extend(upload_errors)

    stale = [cid for cid in cloud_rows if cid not in local_ids]
    if stale:
        for chunk in _chunked(stale):
            supabase.delete_filtered(cfg, table, _in_filter("id", chunk))
        summary.bump(f"{count_prefix}_deleted", len(stale))
