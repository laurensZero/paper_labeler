# -*- coding: utf-8 -*-
r"""框级 OCR 文本存量回填（0016 question_box_ocr）。

来源：ocr/cloud_all_out 的框级 md（文件名 q{qid}_p{page}_b{box_id}.md，
其中 b{N} = question_boxes.id）。question_id / page 以云端 question_boxes
为准，本地文件名仅用于配对；云端有框但无 md 的按图形框记空内容
（空内容 = 图形框，web 端 LaTeX 组卷按此把图形插到框间）。

清洗与 writeback_ocr.py 同规则（clean_text + 归一化），幂等：
  upsert on_conflict=box_id，重复执行安全。

用法：
  python scripts/backfill_box_ocr.py [--md-dir ocr/cloud_all_out]
                                     [--dry-run] [--write] [--batch 500]
前提：0016 迁移已在 Supabase 执行。
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from writeback_ocr import (  # noqa: E402
    REPO,
    clean_text,
    load_service_key,
    normalize_latex_delimiters,
)


def rest_get(base: str, key: str, resource: str, params: str, tries: int = 5) -> list[dict]:
    out, offset = [], 0
    while True:
        url = f"{base}/rest/v1/{resource}?{params}&offset={offset}"
        for a in range(tries):
            try:
                req = urllib.request.Request(url, headers={
                    "apikey": key, "Authorization": f"Bearer {key}",
                })
                with urllib.request.urlopen(req, timeout=120) as r:
                    rows = json.loads(r.read().decode() or "[]")
                break
            except Exception:
                if a == tries - 1:
                    raise
                time.sleep(2 * (a + 1))
        out += rows
        if len(rows) < 1000:
            return out
        offset += 1000


import urllib.request  # noqa: E402


def upsert(rows: list[dict], base: str, key: str, batch: int) -> int:
    url = f"{base}/rest/v1/question_box_ocr?on_conflict=box_id"
    hdrs = {
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
        "User-Agent": "Mozilla/5.0 paperlabeler-backfill-box-ocr/1.0",
    }
    done = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        req = urllib.request.Request(url, data=json.dumps(chunk).encode(), headers=hdrs, method="POST")
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    resp.read()
                break
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                if e.code >= 500 and attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise SystemExit(f"upsert HTTP {e.code}: {body[:400]}")
            except urllib.error.URLError as e:
                if attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise SystemExit(f"网络错误：{e}")
        done += len(chunk)
        print(f"  upserted {done}/{len(rows)}")
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--md-dir", default=str(REPO / "ocr" / "cloud_all_out"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--batch", type=int, default=500)
    ap.add_argument("--base", default=None, help="覆盖 API 基址（默认 .env 的 SUPABASE_URL）")
    args = ap.parse_args()

    md_dir = Path(args.md_dir)
    md_map: dict[int, str] = {}
    pat = re.compile(r"q(\d+)_p(\d+)_b(\d+)$")
    for f in md_dir.glob("*.md"):
        m = pat.match(f.stem)
        if not m:
            continue
        box_id = int(m.group(3))
        md_map[box_id] = f.read_text(encoding="utf-8")

    base = args.base
    if not base:
        for line in (REPO / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith("SUPABASE_URL="):
                base = line.split("=", 1)[1].strip()
    if not base:
        raise SystemExit(".env 缺 SUPABASE_URL")
    key = load_service_key()
    base = base.rstrip("/")

    print("拉取云端框列表 ...")
    boxes = rest_get(base, key, "question_boxes", "select=id,question_id,page")
    print(f"云端框 {len(boxes)}，本地 md {len(md_map)}")

    rows, missing_md = [], 0
    for b in boxes:
        text = md_map.get(b["id"])
        if text is None:
            missing_md += 1
            text = ""
        content = clean_text(text.strip())
        content = normalize_latex_delimiters(content)
        rows.append({
            "box_id": b["id"],
            "question_id": b["question_id"],
            "page": b["page"],
            "content": content,
        })
    text_boxes = sum(1 for r in rows if r["content"])
    print(f"待回填 {len(rows)} 框（文本框 {text_boxes}，空内容/图形框 {len(rows) - text_boxes}，"
          f"无本地 md {missing_md}）")
    if args.dry_run:
        for r in rows[:3]:
            print(f"--- 框 {r['box_id']}（题 {r['question_id']} p{r['page']}）前 120 字 ---")
            print(r["content"][:120] or "（空 = 图形框）")
        print("dry-run 完成，未写库")
        return
    if not args.write:
        print("未加 --write，未写库")
        return
    n = upsert(rows, base, key, args.batch)
    print(f"回填完成：{n} 框 -> question_box_ocr")


if __name__ == "__main__":
    main()
