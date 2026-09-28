"""云端组卷 → 本地 PDF（管理端「组卷查看」下载用）。

数据流：Supabase（composition/items/questions/boxes）→ R2 公开 URL 拉图 →
PIL 烤入平铺水印 → fpdf2 排版（A4、边框、页码、整页水印叠层）。

水印与网页端同构：
  - 图片像素级平铺（导出后单独复制图片也带水印）
  - 整页斜向平铺叠层（footer 阶段绘制，盖在内容之上）
  - 文本读 app_config['export'] 的 export_watermark；预设展开为
    本机用户@机器名 + 日期，便于追溯是哪台机器导出的
"""
from __future__ import annotations

import getpass
import io
import json
import logging
import platform
import re
import tempfile
import urllib.request
from datetime import date
from pathlib import Path

from backend.cloud import supabase as sb
from backend.cloud.config import CloudConfig

logger = logging.getLogger(__name__)

_MM = 72 / 25.4  # px@96dpi → mm（与网页端 PX_TO_MM 一致）
_FETCH_TIMEOUT = 60
# 图片域 img.paperlabeler.de5.net 开着 Cloudflare Browser Integrity Check（错误 1010），
# Python 默认 UA（Python-urllib/3.x）会被 403 拦截——必须带浏览器 UA。
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# 页面几何（mm，与网页端 pdfExport.ts 对齐）
_PAGE_W = 210.0
_PAGE_H = 297.0
_BOX_X, _BOX_Y, _BOX_W, _BOX_H = 13.0, 12.0, 184.0, 277.0
_CONTENT_X = 15.0
_MAX_IMG_W = 180.0
_BOTTOM = 282.0
_INTER_GAP = 2.0

_FONT_CACHE: str | None = None


def _font_path() -> str | None:
    """找一个可用的 CJK TTF（项目自带 simhei 优先，其次 Windows 字体）。"""
    global _FONT_CACHE
    if _FONT_CACHE:
        return _FONT_CACHE
    candidates = [
        Path(__file__).resolve().parents[2] / "web" / "public" / "fonts" / "simhei.ttf",
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\msyh.ttc"),
    ]
    for p in candidates:
        if p.exists():
            _FONT_CACHE = str(p)
            return _FONT_CACHE
    return None


def _pil_font(size: int):
    from PIL import ImageFont

    path = _font_path()
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:  # noqa: BLE001
            pass
    return ImageFont.load_default()


def resolve_export_watermark(cfg: CloudConfig) -> str | None:
    """读 app_config['export'].export_watermark，按 预设/自定义 展开为水印文本。"""
    try:
        rows = sb.select(cfg, "app_config", columns="value", filters={"key": "eq.export"})
    except sb.SupabaseError as exc:
        logger.warning("app_config read failed, watermark off: %s", exc)
        return None
    value = rows[0].get("value") if rows and isinstance(rows[0].get("value"), dict) else {}
    wm = value.get("export_watermark") if isinstance(value, dict) else None
    if not isinstance(wm, dict) or not wm.get("enabled"):
        return None
    mode = wm.get("mode")
    text = str(wm.get("text") or "")
    base = text if mode == "custom" and text else "{email} {date}"
    who = f"{getpass.getuser()}@{platform.node()}"
    return base.replace("{email}", who).replace("{date}", date.today().isoformat())


def _stamp_image(img, text: str):
    """把水印斜向平铺烤进图片像素（与网页端 stampCanvasWatermark 同构）。"""
    from PIL import Image, ImageDraw

    if not text:
        return img
    w, h = img.size
    if w <= 0 or h <= 0:
        return img
    font_size = max(11, int(min(w, h) * 0.055))
    font = _pil_font(font_size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    text_w = probe.textlength(text, font=font)
    col_step = text_w + max(48, font_size * 3)
    row_step = font_size * 5
    diag = int((w * w + h * h) ** 0.5) + 4

    layer = Image.new("RGBA", (diag, diag), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    half_cols = int(diag / col_step // 2) + 2
    half_rows = int(diag / row_step // 2) + 2
    for r in range(-half_rows, half_rows + 1):
        offset = col_step / 2 if abs(r) % 2 == 1 else 0.0
        for c in range(-half_cols, half_cols + 1):
            draw.text(
                (diag / 2 + c * col_step + offset, diag / 2 + r * row_step),
                text,
                font=font,
                fill=(110, 110, 110, 41),
                anchor="mm",
            )
    layer = layer.rotate(24, resample=Image.BICUBIC)  # 逆时针 → “/” 斜向，与网页端一致
    left = (diag - w) // 2
    top = (diag - h) // 2
    layer = layer.crop((left, top, left + w, top + h))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def _page_overlay_png(text: str) -> bytes:
    """生成整页斜向平铺水印 PNG（透明底），footer 阶段叠到每页之上。"""
    from PIL import Image, ImageDraw

    dpi = 120
    w = int(_PAGE_W / 25.4 * dpi)
    h = int(_PAGE_H / 25.4 * dpi)
    font_size = max(12, int(15 * dpi / 72))  # 对应网页端 wmSize=15pt
    font = _pil_font(font_size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    text_w = probe.textlength(text, font=font)
    col_step = text_w + int(120 * dpi / 72)
    row_step = int(130 * dpi / 72)
    diag = int((w * w + h * h) ** 0.5) + 4

    layer = Image.new("RGBA", (diag, diag), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    half_cols = int(diag / col_step // 2) + 2
    half_rows = int(diag / row_step // 2) + 2
    for r in range(-half_rows, half_rows + 1):
        offset = col_step / 2 if abs(r) % 2 == 1 else 0
        for c in range(-half_cols, half_cols + 1):
            draw.text(
                (diag / 2 + c * col_step + offset, diag / 2 + r * row_step),
                text,
                font=font,
                fill=(128, 128, 128, 26),
                anchor="mm",
            )
    layer = layer.rotate(30, resample=Image.BICUBIC)
    left = (diag - w) // 2
    top = (diag - h) // 2
    layer = layer.crop((left, top, left + w, top + h))
    buf = io.BytesIO()
    layer.save(buf, format="PNG")
    return buf.getvalue()


def _fetch_image(cfg: CloudConfig, key: str):
    """从 R2 公开 URL 拉图 → PIL Image。失败返回 None（跳过该图）。"""
    from PIL import Image

    from backend.cloud import r2

    url = r2.public_url(cfg, key)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
            data = resp.read()
        return Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception as exc:  # noqa: BLE001
        logger.warning("image fetch failed %s: %s", key, exc)
        return None


def _one(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return None


def _in_filter(ids: list) -> str:
    return "in.(" + ",".join(str(int(i)) for i in ids) + ")"


def _fetch_composition_data(cfg: CloudConfig, composition_id: str, answers_override: bool | None) -> dict:
    """拉取组卷全部数据（服务端排序/组装），并决定是否拉答案。"""
    comp_rows = sb.select(
        cfg,
        "compositions",
        columns=(
            "name,title,header_text,footer_text,cover_lines,include_answers,"
            "answers_placement,show_page_numbers,show_question_info,show_section_headers,"
            "owner_id,profiles(email)"
        ),
        filters={"id": f"eq.{composition_id}"},
    )
    if not comp_rows:
        raise LookupError("composition not found")
    comp = comp_rows[0]
    comp["owner_email"] = (_one(comp.get("profiles")) or {}).get("email") or ""
    use_answers = (
        bool(comp.get("include_answers")) if answers_override is None else answers_override
    )

    item_rows = sb.select(
        cfg,
        "composition_items",
        columns="sort_order,item_type,blank_pages,question_id",
        filters={"composition_id": f"eq.{composition_id}"},
    )
    item_rows.sort(key=lambda r: int(r.get("sort_order") or 0))
    q_ids = [r["question_id"] for r in item_rows if r.get("question_id")]

    questions: dict[int, dict] = {}
    papers: dict[int, dict] = {}
    boxes: dict[int, list] = {}
    answers: dict[int, int] = {}
    answer_boxes: dict[int, list] = {}
    if q_ids:
        for q in sb.select(
            cfg,
            "questions",
            columns="id,question_no,section,paper_id",
            filters={"id": _in_filter(q_ids)},
        ):
            questions[int(q["id"])] = q
        p_ids = sorted({int(q["paper_id"]) for q in questions.values() if q.get("paper_id")})
        if p_ids:
            for p in sb.select(
                cfg, "papers", columns="id,exam_code,filename", filters={"id": _in_filter(p_ids)}
            ):
                papers[int(p["id"])] = p
        for b in sb.select(
            cfg,
            "question_boxes",
            columns="question_id,page,image_key",
            filters={"question_id": _in_filter(q_ids)},
        ):
            boxes.setdefault(int(b["question_id"]), []).append(b)
        for lst in boxes.values():
            lst.sort(key=lambda r: int(r.get("page") or 0))
        if use_answers:
            for a in sb.select(
                cfg,
                "answers",
                columns="id,question_id",
                filters={"question_id": _in_filter(q_ids)},
            ):
                answers[int(a["question_id"])] = int(a["id"])
            a_ids = list(answers.values())
            if a_ids:
                for b in sb.select(
                    cfg,
                    "answer_boxes",
                    columns="answer_id,page,image_key",
                    filters={"answer_id": _in_filter(a_ids)},
                ):
                    answer_boxes.setdefault(int(b["answer_id"]), []).append(b)
                for lst in answer_boxes.values():
                    lst.sort(key=lambda r: int(r.get("page") or 0))

    return {
        "comp": comp,
        "use_answers": use_answers,
        "items": item_rows,
        "questions": questions,
        "papers": papers,
        "boxes": boxes,
        "answers": answers,
        "answer_boxes": answer_boxes,
    }


def _question_header(q: dict, papers: dict) -> str:
    parts = [f"#{q.get('question_no') or q.get('id')}"]
    paper = papers.get(int(q["paper_id"])) if q.get("paper_id") else None
    if paper:
        parts.append(str(paper.get("exam_code") or paper.get("filename") or ""))
    if q.get("section"):
        parts.append(str(q["section"]))
    return " · ".join(p for p in parts if p)


def build_composition_pdf(
    cfg: CloudConfig,
    composition_id: str,
    include_answers: bool | None = None,
) -> tuple[bytes, str]:
    """渲染组卷 PDF，返回 (pdf_bytes, 文件名)。"""
    from fpdf import FPDF

    data = _fetch_composition_data(cfg, composition_id, include_answers)
    comp = data["comp"]
    use_answers = data["use_answers"]
    wm_text = resolve_export_watermark(cfg)
    wm_png_path: str | None = None

    cjk_family = None
    font_path = _font_path()
    page_kind = {"kind": "fresh"}  # fresh | content | blank

    class _PDF(FPDF):
        def __init__(self):
            super().__init__(unit="mm", format="A4")
            self.watermark_path: str | None = None
            self.page_offset = 0
            self.show_page_numbers = True

        def footer(self):
            if self.watermark_path:
                self.image(self.watermark_path, x=0, y=0, w=_PAGE_W, h=_PAGE_H)
            if not self.show_page_numbers:
                return
            display = self.page_no() - self.page_offset
            if display <= 0:
                return
            self.set_y(-15)
            self.set_font("Helvetica", size=8)
            self.set_text_color(128, 128, 128)
            self.cell(0, 10, str(display), align="C")

    pdf = _PDF()
    pdf.set_auto_page_break(auto=False, margin=15)
    if font_path:
        try:
            pdf.add_font("CJK", "", font_path)
            pdf.add_font("CJK", "B", font_path)
            cjk_family = "CJK"
        except Exception as exc:  # noqa: BLE001
            logger.warning("CJK font register failed: %s", exc)

    cover_lines: list[str] = []
    if comp.get("cover_lines"):
        try:
            parsed = json.loads(comp["cover_lines"])
            if isinstance(parsed, list):
                cover_lines = [str(x) for x in parsed]
        except (ValueError, TypeError):
            cover_lines = []

    has_cover = bool(str(comp.get("title") or "").strip() or cover_lines)
    pdf.page_offset = 1 if has_cover else 0
    pdf.show_page_numbers = bool(comp.get("show_page_numbers", True))

    if wm_text:
        fd, wm_png_path = tempfile.mkstemp(suffix=".png")
        with open(fd, "wb") as fh:
            fh.write(_page_overlay_png(wm_text))
        pdf.watermark_path = wm_png_path

    def _new_page() -> None:
        page_kind["kind"] = "fresh"
        pdf.add_page()
        pdf.set_draw_color(0, 0, 0)
        pdf.set_line_width(0.25)
        pdf.rect(_BOX_X, _BOX_Y, _BOX_W, _BOX_H)
        pdf.set_y(_BOX_Y + 6)

    def _ensure_content_page() -> None:
        """内容开始前：若当前页已被用作空白页则另起一页。"""
        if page_kind["kind"] == "blank":
            _new_page()

    def _draw_blank_page() -> None:
        """消耗一张空白页（当前页若仍空着就直接充当，否则另起）。"""
        if page_kind["kind"] == "content":
            _new_page()
        page_kind["kind"] = "blank"

    def _text(s: str, size: int, *, bold: bool = False, gray: bool = False, center: bool = False) -> None:
        page_kind["kind"] = "content"
        if cjk_family:
            pdf.set_font(cjk_family, "B" if bold else "", size)
        else:
            pdf.set_font("Helvetica", "B" if bold else "", size)
        pdf.set_text_color(120, 120, 120) if gray else pdf.set_text_color(0, 0, 0)
        pdf.cell(0, size * 0.5, s, new_x="LMARGIN", new_y="NEXT", align="C" if center else "L")

    def _place_images(keys: list[str]) -> None:
        for key in keys:
            img = _fetch_image(cfg, key)
            if img is None:
                continue
            if wm_text:
                img = _stamp_image(img, wm_text)
            w_px, h_px = img.size
            target_w = min(_MAX_IMG_W, w_px * _MM)
            target_h = target_w * (h_px / w_px)
            max_h = _BOTTOM - _BOX_Y - 12
            if target_h > max_h:
                target_h = max_h
                target_w = target_h * (w_px / h_px)
            if pdf.get_y() + target_h > _BOTTOM:
                _new_page()
            page_kind["kind"] = "content"
            pdf.image(img, x=_CONTENT_X, y=pdf.get_y(), w=target_w)
            pdf.set_y(pdf.get_y() + target_h + _INTER_GAP)

    # ---- 封面 ----
    if has_cover:
        _new_page()
        title = str(comp.get("title") or comp.get("name") or "").strip()
        pdf.set_y(70)
        if title:
            _text(title, 22, bold=True, center=True)
        pdf.set_y(100)
        for line in cover_lines:
            _text(line or " ", 14, center=True)
        if comp.get("footer_text"):
            pdf.set_y(_PAGE_H - 50)
            _text(str(comp["footer_text"]), 11, gray=True, center=True)
    else:
        _new_page()

    # ---- 题目 ----
    items = data["items"]
    questions = data["questions"]
    papers = data["papers"]
    boxes = data["boxes"]
    show_info = bool(comp.get("show_question_info", True))

    for idx, item in enumerate(items):
        if item.get("item_type") == "blank_page":
            _draw_blank_page()
            continue
        qid = item.get("question_id")
        q = questions.get(int(qid)) if qid else None
        if not q:
            continue
        keys = [b.get("image_key") for b in boxes.get(int(qid), []) if b.get("image_key")]
        if not keys:
            continue
        _ensure_content_page()
        if show_info:
            header = _question_header(q, papers)
            if header:
                if pdf.get_y() + 14 > _BOTTOM:
                    _new_page()
                _text(header, 11, bold=True)
                pdf.set_y(pdf.get_y() + 2)
        _place_images(keys)
        for _ in range(max(0, int(item.get("blank_pages") or 0))):
            _draw_blank_page()

    # ---- 答案（统一附在卷末；interleaved 的逐题穿插在云端简化为附后）----
    if use_answers:
        answer_map = data["answers"]
        answer_boxes = data["answer_boxes"]
        for it in items:
            qid = it.get("question_id")
            if not qid:
                continue
            aid = answer_map.get(int(qid))
            if not aid:
                continue
            keys = [b.get("image_key") for b in answer_boxes.get(aid, []) if b.get("image_key")]
            if keys:
                _ensure_content_page()
                _place_images(keys)

    out = bytes(pdf.output())
    if wm_png_path:
        try:
            Path(wm_png_path).unlink(missing_ok=True)
        except OSError:
            pass
    raw_name = str(comp.get("name") or "composition")
    safe = re.sub(r'[\\/:*?"<>|]', "_", raw_name).strip()[:80] or "composition"
    return out, f"{safe}.pdf"
