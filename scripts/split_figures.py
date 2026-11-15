# -*- coding: utf-8 -*-
r"""框图图形区自动切分（CV 版面分析），为 web 端 LaTeX 组卷提供图形元数据。

背景：题目 OCR（question_ocr）只含文本，图形与文字常在同一裁剪框内
（如"曲线图在上、题干在下"），LaTeX 组卷若只渲染文本会无声丢图。
本脚本对每个框裁剪图做确定性切分，把图形子区域（bbox，框图相对像素坐标）
写入 question_figures 表；前端导出时从框图 canvas 按 bbox 裁切，无需单独存图。

算法（无 ML，几十毫秒/张）：
  1) Otsu 二值化 → 连通域分析
  2) 字符/图形分类：行高 H 由真实笔画（面积>200）高度中位数标定；
     图形 CC = 高 > 2.2H 且宽 > 1.5H（曲线/大块阴影），或宽 > 6H（轴线/表格框线/数轴）
  3) 正文行保护：字符按垂直重叠聚带，带内 ≥3 字符且横向跨度 ≥500px 判为正文行，
     永不被图形区吸收（根号上划线等长横线因此不会拖入正文，反之亦然）
  4) 图形区 = 图形 CC 聚类 bbox，迭代吸收邻近非正文字符（轴标 y=f(x)/O/π）
  5) 一框多图按垂直间隙 > 2.5H 聚类拆分

回写约定（与 question_ocr 同风格）：
  - boxes_fingerprint 记录切图时的框指纹（同 0013 RPC 规则），框变更后重跑自动刷新
  - 幂等：指纹未变的题直接跳过（--force 重算）
  - 写库删旧插新（按 question_id），dry-run 默认不写

用法：
  python scripts/split_figures.py [--only-flagged] [--limit N] [--force]
                                  [--write] [--workers 8] [--base URL]
  python scripts/split_figures.py --montage-only   # 仅从已有结果重出蒙太奇

依赖：opencv-python、numpy；下载走 curl（R2 公共域拒绝 urllib）。
"""
import argparse
import csv
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO / "ocr" / "figures_cache"
REVIEW_DIR = REPO / "ocr" / "figures_review"

FIGURE_WORDS = re.compile(r"\b(diagram|graph|figure|stem[- ]and[- ]leaf)\b", re.I)


# ---------------------------------------------------------------- 云端访问

def load_env() -> tuple[str, str]:
    env = REPO / ".env"
    if not env.exists():
        raise SystemExit("未找到 repo 根 .env")
    text = env.read_text(encoding="utf-8")
    base = re.search(r"^SUPABASE_URL=(\S+)", text, re.M)
    key = re.search(r"^SUPABASE_SERVICE_ROLE_KEY=(\S+)", text, re.M)
    if not base or not key:
        raise SystemExit(".env 缺 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    return base.group(1).rstrip("/"), key.group(1)


def rest_get(base: str, key: str, resource: str, params: str, tries: int = 5) -> list[dict]:
    """PostgREST 分页拉全（Range 头会截断，勿加）。"""
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


# ---------------------------------------------------------------- 切图算法

def split_figures(img: np.ndarray) -> list[dict]:
    """返回图形区列表 [{bbox:[x,y,w,h], full_box:bool, confidence:float}]。"""
    h, w = img.shape
    _, binv = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(binv, connectivity=8)
    cc = stats[1:]
    hs = [s[3] for s in cc if s[4] > 200 and s[3] < 150]
    if not hs:
        return []
    H = max(int(np.median(hs)), 30)  # 正文行高标定
    glyphs, graphics = [], []
    for x, y, cw, ch, area in cc:
        if area < 25:
            continue
        # 宽阈值取 max(6H, 0.3w)：分数线/根号上划线（≤15% 图宽）被排除，
        # 坐标轴/表格框线/数轴（≥30% 图宽）保留。
        # 高+宽组合判据要求 cw > 2.5H：大 Σ/∫ 带上下限是紧凑符号（宽 ~1.5-2H），
        # 三角形/圆/扇形/曲线等真图形的 CC 宽 ≥3H。
        if (ch > H * 2.2 and cw > H * 2.5) or cw > max(H * 6.0, w * 0.3):
            graphics.append((x, y, cw, ch, area))
        else:
            glyphs.append((x, y, cw, ch, area))
    if not graphics:
        return []

    # 正文行带（垂直重叠聚类）
    glyphs.sort(key=lambda g: g[1])
    bands: list[dict] = []
    for g in glyphs:
        placed = False
        for b in bands:
            if g[1] < b["y1"] + H * 0.5 and g[1] + g[3] > b["y0"] - H * 0.5:
                b["glyphs"].append(g)
                b["y0"] = min(b["y0"], g[1]); b["y1"] = max(b["y1"], g[1] + g[3])
                b["x0"] = min(b["x0"], g[0]); b["x1"] = max(b["x1"], g[0] + g[2])
                placed = True
                break
        if not placed:
            bands.append({"y0": g[1], "y1": g[1] + g[3], "x0": g[0], "x1": g[0] + g[2], "glyphs": [g]})

    def in_text_band(g) -> bool:
        y0, y1 = g[1], g[1] + g[3]
        for b in bands:
            if len(b["glyphs"]) >= 3 and (b["x1"] - b["x0"]) >= 500:
                if y0 < b["y1"] and y1 > b["y0"]:
                    return True
        return False

    # 图形 CC 按垂直间隙聚类（一框多图）
    graphics.sort(key=lambda g: g[1])
    clusters, cur = [], [graphics[0]]
    for g in graphics[1:]:
        if g[1] - (cur[-1][1] + cur[-1][3]) > H * 2.5:
            clusters.append(cur); cur = [g]
        else:
            cur.append(g)
    clusters.append(cur)

    margin = int(H * 1.4)
    results = []
    for cl in clusters:
        x0 = min(g[0] for g in cl); y0 = min(g[1] for g in cl)
        x1 = max(g[0] + g[2] for g in cl); y1 = max(g[1] + g[3] for g in cl)
        changed = True
        while changed:  # 迭代吸收邻近非正文字符（轴标/图内标注）
            changed = False
            for g in glyphs:
                if in_text_band(g):
                    continue
                gx0, gy0, gx1, gy1 = g[0], g[1], g[0] + g[2], g[1] + g[3]
                if gx1 >= x0 - margin and gx0 <= x1 + margin and gy1 >= y0 - margin and gy0 <= y1 + margin:
                    if gx0 < x0: x0, changed = gx0, True
                    if gy0 < y0: y0, changed = gy0, True
                    if gx1 > x1: x1, changed = gx1, True
                    if gy1 > y1: y1, changed = gy1, True
        bx, by = max(0, int(x0)), max(0, int(y0))
        bw, bh = min(w, int(x1)) - bx, min(h, int(y1)) - by
        full = bw * bh > 0.85 * w * h
        conf = 1.0 if bh > H * 2.2 else 0.6  # 细横条（数轴等）降置信
        # kind 判定：表格的横竖线相交成一个网格连通域，逐 CC 数细线无效，
        # 改数区域内"通宽横墨带 / 通高竖墨带"：
        #   横带 3~11 且有竖带 = 带框线表格（OCR 简单表已转 Markdown，web 端按此去重；
        #                      茎叶图等空间表无 Markdown，照常按图渲染）
        #   横带 ≥12 = 作图网格纸，仍按图处理
        sub = binv[by:by + bh, bx:bx + bw]
        row_full = ((sub > 0).sum(axis=1) > 0.8 * bw).astype(int)
        col_full = ((sub > 0).sum(axis=0) > 0.8 * bh).astype(int)
        h_bands = int(np.diff(np.concatenate(([0], row_full))).clip(min=0).sum())
        v_bands = int(np.diff(np.concatenate(([0], col_full))).clip(min=0).sum())
        kind = "figure"
        if 3 <= h_bands < 12 and v_bands >= 1:
            kind = "table"
        results.append({"bbox": [bx, by, bw, bh], "full_box": full,
                        "confidence": conf, "kind": kind})
    return results


# ---------------------------------------------------------------- 下载

def curl_download(image_key: str, dst: Path, tries: int = 3) -> bool:
    if dst.exists() and dst.stat().st_size > 0:
        return True
    url = f"https://img.paperlabeler.de5.net/{image_key}"
    for a in range(tries):
        r = subprocess.run(["curl", "-s", "--fail", "-o", str(dst), url],
                           capture_output=True, timeout=90)
        if r.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return True
        time.sleep(2 * (a + 1))
    return False


def webp_to_png(webp: Path) -> np.ndarray | None:
    return cv2.imread(str(webp), cv2.IMREAD_GRAYSCALE)


# ---------------------------------------------------------------- 主流程

def fingerprint(boxes: list[dict]) -> str:
    return ",".join(
        f"{b['page']}:{b['id']}:{b.get('content_hash') or b['image_key']}"
        for b in sorted(boxes, key=lambda x: (x["page"], x["id"]))
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only-flagged", action="store_true",
                    help="只跑启发式含图候选题（默认全量，全量可发现启发式漏标）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 题（调试）")
    ap.add_argument("--force", action="store_true", help="忽略指纹跳过，全部重算")
    ap.add_argument("--write", action="store_true", help="写库（默认 dry-run）")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--montage-cols", type=int, default=8)
    ap.add_argument("--montage-only", action="store_true", help="仅从 figures_review/results.json 重出蒙太奇")
    args = ap.parse_args()

    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    results_path = REVIEW_DIR / "results.json"

    if args.montage_only:
        records = json.loads(results_path.read_text(encoding="utf-8"))
        build_montage(records, args.montage_cols)
        return

    base, key = load_env()
    t0 = time.time()
    print("拉取云端数据 ...")
    questions = rest_get(base, key, "questions", "select=id&deleted_at=is.null")
    qids = [q["id"] for q in questions]
    boxes = rest_get(base, key, "question_boxes",
                     "select=id,question_id,page,image_key,content_hash&order=page,id")
    ocr_rows = rest_get(base, key, "question_ocr", "select=question_id,content,boxes_fingerprint")
    fig_rows = []
    if not args.force:
        try:
            fig_rows = rest_get(base, key, "question_figures",
                                "select=question_id,boxes_fingerprint&order=question_id")
        except Exception as e:
            print(f"  question_figures 拉取失败（0015 迁移未执行？按无增量跳过处理）: {e}")
            if args.write:
                raise SystemExit("--write 需要先在 Supabase 执行 supabase/migrations/0015_question_figures.sql")
    print(f"  题目 {len(qids)}  框 {len(boxes)}  OCR {len(ocr_rows)}  已有图形元数据 {len(fig_rows)} 题")

    boxes_by_q: dict[int, list[dict]] = {}
    for b in boxes:
        boxes_by_q.setdefault(b["question_id"], []).append(b)
    ocr_by_q = {r["question_id"]: r for r in ocr_rows}
    fp_done = {r["question_id"]: r["boxes_fingerprint"] for r in fig_rows}

    flagged = {r["question_id"] for r in ocr_rows if FIGURE_WORDS.search(r["content"] or "")}
    empty_content = {r["question_id"] for r in ocr_rows if not (r["content"] or "").strip()}

    todo = []
    for qid in qids:
        qb = boxes_by_q.get(qid)
        if not qb:
            continue
        if args.only_flagged and qid not in flagged and qid not in empty_content:
            continue
        if not args.force and fp_done.get(qid) == fingerprint(qb):
            continue  # 指纹未变，已处理过
        todo.append(qid)
    if args.limit:
        todo = todo[: args.limit]
    print(f"待处理 {len(todo)} 题 / {sum(len(boxes_by_q[q]) for q in todo)} 框"
          f"{'（仅含图候选）' if args.only_flagged else '（全量）'}")

    # 并发下载 + 切图
    records: list[dict] = []
    dl_fail = 0
    progress = {"done": 0}

    def process_q(qid: int):
        out = []
        for b in boxes_by_q[qid]:
            safe = b["image_key"].replace("/", "_")
            dst = CACHE_DIR / safe
            if not curl_download(b["image_key"], dst):
                out.append({"question_id": qid, "box_id": b["id"], "error": "download"})
                continue
            img = webp_to_png(dst)
            if img is None:
                out.append({"question_id": qid, "box_id": b["id"], "error": "decode"})
                continue
            for i, f in enumerate(split_figures(img)):
                out.append({"question_id": qid, "box_id": b["id"], "ord": i,
                            "bbox": f["bbox"], "full_box": f["full_box"],
                            "confidence": f["confidence"], "kind": f["kind"],
                            "image_key": b["image_key"], "page": b["page"]})
        progress["done"] += 1
        if progress["done"] % 100 == 0 or progress["done"] == len(todo):
            print(f"  {progress['done']}/{len(todo)} 题  "
                  f"({time.time() - t0:.0f}s)", flush=True)
        return out

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(process_q, qid) for qid in todo]
        for fut in as_completed(futs):
            records += fut.result()

    dl_fail = sum(1 for r in records if r.get("error"))
    fig_records = [r for r in records if not r.get("error")]
    found = [r for r in fig_records if "bbox" in r]
    n_q = len({r["question_id"] for r in found})
    print(f"完成：{len(todo)} 题 / {sum(len(boxes_by_q[q]) for q in todo)} 框，"
          f"发现图形区 {len(found)} 个（{n_q} 题），下载/解码失败 {dl_fail} 框，"
          f"耗时 {time.time() - t0:.0f}s")

    # 启发式对照：图出现在"未标记题"里 = 漏标；标记题没图 = 无图（纯文字误报）
    found_qids = {r["question_id"] for r in found}
    missed = sorted(found_qids - flagged - empty_content)
    print(f"启发式漏标（有图但无 diagram/graph/figure 字样）: {len(missed)} 题"
          + (f"  qid: {missed[:20]}" if missed else ""))

    # 结果落盘 + 蒙太奇
    results_path.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    build_montage(records, args.montage_cols)

    # 写库
    if args.write:
        write_db(base, key, fig_records, boxes_by_q, fp_done)
    else:
        print("dry-run 未写库；确认蒙太奇无误后加 --write 回写")


def build_montage(records: list[dict], cols: int, thumb_h: int = 220):
    """把切出的图形区拼成大图供人工抽查。"""
    import math
    found = [r for r in records if "bbox" in r]
    if not found:
        print("无图形区，跳过蒙太奇")
        return
    found.sort(key=lambda r: (r["question_id"], r["box_id"], r["ord"]))
    per_sheet = 72
    for s in range(math.ceil(len(found) / per_sheet)):
        chunk = found[s * per_sheet:(s + 1) * per_sheet]
        cells = []
        for r in chunk:
            img = webp_to_png(CACHE_DIR / r["image_key"].replace("/", "_"))
            if img is None:
                continue
            x, y, bw, bh = r["bbox"]
            crop = img[max(0, y):y + bh, max(0, x):x + bw]
            if crop.size == 0:
                continue
            scale = min(1.0, thumb_h / crop.shape[0])
            crop = cv2.resize(crop, (max(1, int(crop.shape[1] * scale)), max(1, int(crop.shape[0] * scale))))
            canvas = np.full((thumb_h + 24, max(crop.shape[1], 120), 3), 255, np.uint8)
            g3 = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
            canvas[24:24 + g3.shape[0], 0:g3.shape[1]] = g3
            tag = f"q{r['question_id']} b{r['box_id']}#{r['ord']}" + (" FULL" if r.get("full_box") else "")
            if r.get("kind") == "table":
                tag += " TBL"
            if r.get("confidence", 1) < 1:
                tag += f" c{r['confidence']}"
            cv2.putText(canvas, tag, (2, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 200), 1, cv2.LINE_AA)
            cells.append(canvas)
        if not cells:
            continue
        rows = math.ceil(len(cells) / cols)
        col_w = max(c.shape[1] for c in cells)
        sheet = np.full((rows * (thumb_h + 26), cols * (col_w + 6), 3), 255, np.uint8)
        for i, c in enumerate(cells):
            r_, c_ = divmod(i, cols)
            sheet[r_ * (thumb_h + 26):r_ * (thumb_h + 26) + c.shape[0],
                  c_ * (col_w + 6):c_ * (col_w + 6) + c.shape[1]] = c
        dst = REVIEW_DIR / f"sheet_{s + 1}.png"
        cv2.imwrite(str(dst), sheet)
        print(f"蒙太奇 {dst}（{len(cells)} 项）")


def write_db(base: str, key: str, fig_records: list[dict], boxes_by_q: dict, fp_done: dict):
    """按题删旧插新（question_id 级），只动有图形区或指纹变化的题。"""
    by_q: dict[int, list[dict]] = {}
    for r in fig_records:
        if "bbox" in r:
            by_q.setdefault(r["question_id"], []).append(r)
    changed = set(by_q)
    # 指纹变了但本轮没跑到的题（--only-flagged 模式）也要清旧数据
    for qid, fp in fp_done.items():
        if qid in boxes_by_q and fingerprint(boxes_by_q[qid]) != fp:
            changed.add(qid)
    if not changed:
        print("无变化，不写库")
        return
    hdrs = {
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=ignore-duplicates",
        "User-Agent": "Mozilla/5.0 paperlabeler-split-figures/1.0",
    }
    # 删旧
    ids = sorted(changed)
    for i in range(0, len(ids), 200):
        chunk = ",".join(map(str, ids[i:i + 200]))
        req = urllib.request.Request(
            f"{base}/rest/v1/question_figures?question_id=in.({chunk})",
            headers=hdrs, method="DELETE")
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp.read()
    # 插新
    rows = []
    for qid in ids:
        fp = fingerprint(boxes_by_q.get(qid, []))
        for r in by_q.get(qid, []):
            rows.append({"question_id": qid, "box_id": r["box_id"], "ord": r["ord"],
                         "bbox": r["bbox"], "confidence": r["confidence"],
                         "full_box": r["full_box"], "kind": r["kind"],
                         "boxes_fingerprint": fp})
    for i in range(0, len(rows), 200):
        req = urllib.request.Request(
            f"{base}/rest/v1/question_figures",
            data=json.dumps(rows[i:i + 200]).encode(), headers=hdrs, method="POST")
        for a in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    resp.read()
                break
            except urllib.error.HTTPError as e:
                if e.code >= 500 and a < 3:
                    time.sleep(2 * (a + 1)); continue
                raise SystemExit(f"insert HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
    print(f"写库完成：{len(ids)} 题 / {len(rows)} 行 -> question_figures")
    (REVIEW_DIR / "written.csv").write_text(
        "\n".join([",".join(["question_id", "box_id", "ord", "bbox", "confidence", "full_box"])]
                  + [f"{r['question_id']},{r['box_id']},{r['ord']},\"{r['bbox']}\",{r['confidence']},{r['full_box']}"
                     for r in rows]), encoding="utf-8")


if __name__ == "__main__":
    main()
