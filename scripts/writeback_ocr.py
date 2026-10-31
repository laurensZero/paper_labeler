# -*- coding: utf-8 -*-
r"""把 OCR 结果回写云端 question_ocr 表（Supabase PostgREST，service role）。

输入：fetch_cloud_sample.py / 全量拉取脚本产出的 manifest.json（含 question_id /
box_id / page / file），加 OCR 输出目录（.md 与图片同名）。

多框题按 (page, box_id) 排序合并为一条，段落间空行分隔；写入前默认做
分隔符归一化（\[...,$ $...\] 错配修复，与 web/src/lib/latex.ts 同规则）。

用法：
  python scripts/writeback_ocr.py --manifest <manifest.json> --out-dir <md目录> [--dry-run]
                                        [--no-normalize] [--batch 200] [--status draft]
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load_service_key() -> str:
    env = REPO / ".env"
    if env.exists():
        m = re.search(r"^SUPABASE_SERVICE_ROLE_KEY=(\S+)", env.read_text(encoding="utf-8"), re.M)
        if m:
            return m.group(1)
    raise SystemExit("未找到 SUPABASE_SERVICE_ROLE_KEY（repo 根 .env）")


# ---- 分隔符归一化（与 web/src/lib/latex.ts normalizeLatexDelimiters 同规则）----

def normalize_latex_delimiters(src: str) -> str:
    out: list[str] = []
    mode = "out"  # out | display | inline
    i, n = 0, len(src)
    while i < n:
        rest = src[i:]
        if rest.startswith("\\[") or rest.startswith("\\("):
            tok = rest[:2]
            want = "display" if tok == "\\[" else "inline"
            if mode == "out":
                mode = want
                out.append(tok)
            else:
                out.append(tok)  # 嵌套/错配：原样保留，交给前端容错
            i += 2
            continue
        if rest.startswith("\\]") or rest.startswith("\\)"):
            tok = rest[:2]
            closing = "display" if tok == "\\]" else "inline"
            if mode == closing:
                mode = "out"
            out.append(tok)
            i += 2
            continue
        if rest.startswith("$$"):
            if mode == "out":
                mode = "display"
                out.append("\\[")
            elif mode == "display":
                mode = "out"
                out.append("\\]")
            else:
                out.append("\\)")  # inline 中的 $$ 视为闭合
                mode = "out"
            i += 2
            continue
        if src[i] == "$":
            if mode == "display":
                i += 1  # display 内游离 $：错配残片，丢弃
                continue
            if mode == "inline":
                mode = "out"
                out.append("\\)")
                i += 1
                continue
            close = src.find("$", i + 1)
            nl = src.find("\n", i + 1)
            if close != -1 and (nl == -1 or close < nl):
                mode = "inline"
                out.append("\\(")
            else:
                out.append("$")  # 无同行配对的游离 $（货币等）：按字面量保留
            i += 1
            continue
        out.append(src[i])
        i += 1
    if mode == "display":
        out.append("\\]")
    elif mode == "inline":
        out.append("\\)")
    return "".join(out)


def merge_by_question(manifest: list[dict], out_dir: Path, normalize: bool):
    by_q: dict[int, list[dict]] = {}
    for row in manifest:
        qid = row.get("question_id")
        if qid is None:
            continue
        by_q.setdefault(int(qid), []).append(row)
    merged = []
    for qid, rows in sorted(by_q.items()):
        rows.sort(key=lambda r: (r.get("page", 0), r.get("box_id", 0)))
        texts = []
        for r in rows:
            stem = Path(r["file"]).stem
            f = out_dir / f"{stem}.md"
            if not f.exists():
                print(f"  !! 缺输出文件 {f.name}（题 {qid}，跳过该框）")
                continue
            t = f.read_text(encoding="utf-8").strip()
            if t:
                texts.append(t)
        if not texts:
            continue
        content = "\n\n".join(texts)
        if normalize:
            content = normalize_latex_delimiters(content)
        merged.append({"question_id": qid, "content": content,
                       "model": "xiaomi-ocr-0", "status": "draft"})
    return merged


def upsert(rows: list[dict], base: str, key: str, batch: int):
    url = f"{base}/rest/v1/question_ocr?on_conflict=question_id"
    hdrs = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) paperlabeler-writeback/1.0",
    }
    done = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i : i + batch]
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
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-normalize", action="store_true")
    ap.add_argument("--batch", type=int, default=200)
    ap.add_argument("--status", choices=["draft", "confirmed"], default="draft")
    ap.add_argument("--base", default=None, help="覆盖 API 基址（默认 .env 的 SUPABASE_URL；直连不通可用 CF 反代）")
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    rows = merge_by_question(manifest, Path(args.out_dir), not args.no_normalize)
    for r in rows:
        r["status"] = args.status
    total_chars = sum(len(r["content"]) for r in rows)
    print(f"待回写 {len(rows)} 题 / {total_chars} 字符"
          f"{'（归一化已应用）' if not args.no_normalize else ''}")
    if args.dry_run:
        for r in rows[:3]:
            print(f"--- 题 {r['question_id']} 预览（前 200 字）---")
            print(r["content"][:200])
        print("dry-run 完成，未写库")
        return
    base = args.base
    if not base:
        for line in (REPO / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith("SUPABASE_URL="):
                base = line.split("=", 1)[1].strip()
    if not base:
        raise SystemExit(".env 缺 SUPABASE_URL")
    key = load_service_key()
    n = upsert(rows, base.rstrip("/"), key, args.batch)
    print(f"回写完成：{n} 题 -> question_ocr")


if __name__ == "__main__":
    main()
