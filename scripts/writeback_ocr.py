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

from otsl_converter import convert_otsl_to_html  # noqa: E402  # vendor 自 Xiaomi-OCR-0（Apache-2.0）


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
                if want == "inline":
                    # 显式 \( \) 内容含 >=2 个英文长单词 → 误包正文（如 \(32600 for Browns and\)）：
                    # 去掉定界符按正文保留
                    close = src.find("\\)", i + 2)
                    nl = src.find("\n", i + 2)
                    if close != -1 and (nl == -1 or close < nl):
                        candidate = src[i + 2 : close]
                        if len(re.findall(r"[A-Za-z]{3,}", candidate)) >= 2:
                            out.append(candidate)
                            i = close + 2
                            continue
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
            candidate = src[i + 1 : close] if close != -1 else ""
            # 配对内容含 >=2 个英文长单词（如 "for Browns and"）→ 货币/正文的 $ 误配对，按字面量保留
            if close != -1 and (nl == -1 or close < nl) and len(re.findall(r"[A-Za-z]{3,}", candidate)) < 2:
                mode = "inline"
                out.append("\\(")
            else:
                out.append("$")  # 无同行配对或疑似货币：按字面量保留
            i += 1
            continue
        out.append(src[i])
        i += 1
    if mode == "display":
        out.append("\\]")
    elif mode == "inline":
        out.append("\\)")
    return "".join(out)


def merge_by_question(manifest: list[dict], out_dir: Path, normalize: bool, keep_marks: bool = False):
    by_q: dict[int, list[dict]] = {}
    for row in manifest:
        qid = row.get("question_id")
        if qid is None:
            continue
        by_q.setdefault(int(qid), []).append(row)

    # 约定（2026-10-31 与用户确认）：
    #   1) 整行的点线/下划线/省略号 = 答题线，清除
    #   2) 段落末尾的 [数字] = 分值标注，统一去除（云端无分值真值，不补；
    #      只删段尾纯 [数字]，避免误伤 [0, 2π] 等数学记号）
    #   3) 表格 OTSL → HTML 表格（官方 postprocess/otsl.py 转换器，带 rowspan/colspan）
    #   4) 图不处理（前端打"含图"徽标）
    dots_line = re.compile(r"^\s*[\.\u2026\u22ef_·]{6,}\s*$", re.M)
    trailing_marks = re.compile(r"\s*\[\d{1,2}\]\s*$")
    blank_runs = re.compile(r"\n{3,}")

    def clean(text: str) -> str:
        text = dots_line.sub("", text)
        paras = [p.rstrip() for p in text.split("\n\n")]
        out = []
        for p in paras:
            if re.search(r"<\s*fcel\s*>", p, re.I):
                if re.search(r"<\s*(?:lcel|ucel|xcel)\s*>", p, re.I):
                    # 跨行/跨列标记 = 空间结构表（茎叶图等），Markdown/HTML 都失真：
                    # 按图片处理，不留文字表（前端"含图"徽标提示看原图）
                    continue
                p = convert_otsl_to_html(p)
            out.append(p)
        paras = out
        if not keep_marks:
            paras = [trailing_marks.sub("", p.rstrip()) for p in paras]
        return blank_runs.sub("\n\n", "\n\n".join(paras)).strip()

    merged = []
    for qid, rows_ in sorted(by_q.items()):
        rows_.sort(key=lambda r: (r.get("page", 0), r.get("box_id", 0)))
        texts = []
        missing_md = False
        for r in rows_:
            stem = Path(r["file"]).stem
            f = out_dir / f"{stem}.md"
            if not f.exists():
                # 真 OCR 失败：该题不写指纹，增量 RPC 下一轮自动重试
                missing_md = True
                print(f"  !! 缺输出文件 {f.name}（题 {qid}，指纹省略待重试）")
                continue
            t = f.read_text(encoding="utf-8").strip()
            if t:  # 空 md = 图形框（按图片处理），不计入文本
                texts.append(t)
        content = clean("\n\n".join(texts))
        if normalize:
            content = normalize_latex_delimiters(content)
        if not content and missing_md:
            # 有真失败：不回写，留待增量 RPC 重试
            continue
        # 框指纹（与 0013 RPC pending_ocr_questions 同规则）：page:box_id:hash
        fp = ",".join(
            f"{r['page']}:{r['box_id']}:{r.get('content_hash') or r['r2_key']}"
            for r in sorted(rows_, key=lambda x: (x.get("page", 0), x.get("box_id", 0)))
        )
        if not content:
            # 整题纯图形：写空内容 + 指纹，让 RPC 视为已处理，不再重列
            print(f"  -- 题 {qid} 纯图形题，记空内容")
        row = {"question_id": qid, "content": content, "model": "xiaomi-ocr-0", "status": "draft"}
        if not missing_md:
            row["boxes_fingerprint"] = fp
        merged.append(row)
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
    ap.add_argument("--keep-marks", action="store_true", help="保留段尾 [数字] 分值标注（默认去除）")
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    rows = merge_by_question(manifest, Path(args.out_dir), not args.no_normalize, args.keep_marks)
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
