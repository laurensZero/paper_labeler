from __future__ import annotations

from collections import OrderedDict
import hashlib
from io import BytesIO
from pathlib import Path
from threading import Lock

from PIL import Image

from backend.database import QuestionBox

MAX_PREVIEW_WIDTH = 1200
MAX_CACHE_BYTES = 64 * 1024 * 1024
BG_COLOR = (255, 255, 255)

_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_bytes = 0
_cache_lock = Lock()


def _clamp01(value) -> float:
    try:
        n = float(value)
    except Exception:
        return 0.0
    return max(0.0, min(1.0, n))


def question_preview_version(boxes: list[QuestionBox]) -> str:
    parts: list[str] = []
    for box in boxes:
        try:
            mtime = int(Path(str(box.image_path)).stat().st_mtime)
        except Exception:
            mtime = 0
        bbox = ",".join(f"{float(x):.6f}" for x in list(box.bbox or [])[:4])
        parts.append(f"{int(box.id or 0)}:{int(box.page or 0)}:{mtime}:{bbox}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _cache_get(key: str) -> bytes | None:
    with _cache_lock:
        value = _cache.get(key)
        if value is None:
            return None
        _cache.move_to_end(key)
        return value


def _cache_set(key: str, value: bytes) -> None:
    global _cache_bytes
    with _cache_lock:
        old = _cache.pop(key, None)
        if old is not None:
            _cache_bytes -= len(old)
        _cache[key] = value
        _cache_bytes += len(value)
        while _cache_bytes > MAX_CACHE_BYTES and _cache:
            _, removed = _cache.popitem(last=False)
            _cache_bytes -= len(removed)


def build_question_preview_png(question_id: int, boxes: list[QuestionBox], width: int = MAX_PREVIEW_WIDTH) -> tuple[bytes, str]:
    safe_width = max(240, min(1200, int(width or MAX_PREVIEW_WIDTH)))
    version = question_preview_version(boxes)
    cache_key = f"q:{int(question_id)}:{safe_width}:{version}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached, version

    crops: list[Image.Image] = []
    try:
        for box in boxes:
            bbox = list(getattr(box, "bbox", []) or [])
            if len(bbox) != 4:
                continue
            src_path = Path(str(box.image_path))
            if not src_path.exists():
                continue
            with Image.open(src_path) as img:
                img = img.convert("RGB")
                img_w, img_h = img.size
                x0 = _clamp01(min(bbox[0], bbox[2]))
                y0 = _clamp01(min(bbox[1], bbox[3]))
                x1 = _clamp01(max(bbox[0], bbox[2]))
                y1 = _clamp01(max(bbox[1], bbox[3]))
                left = max(0, min(img_w - 1, int(round(x0 * img_w))))
                top = max(0, min(img_h - 1, int(round(y0 * img_h))))
                right = max(left + 1, min(img_w, int(round(x1 * img_w))))
                bottom = max(top + 1, min(img_h, int(round(y1 * img_h))))
                crop = img.crop((left, top, right, bottom))
                if crop.width > safe_width:
                    next_h = max(1, int(round(crop.height * (safe_width / crop.width))))
                    crop = crop.resize((safe_width, next_h), Image.Resampling.LANCZOS)
                crops.append(crop.copy())

        if not crops:
            raise ValueError("no preview crops")

        out_w = max(c.width for c in crops)
        out_h = sum(c.height for c in crops)
        out = Image.new("RGB", (out_w, out_h), BG_COLOR)
        y = 0
        for crop in crops:
            out.paste(crop, (0, y))
            y += crop.height

        buf = BytesIO()
        out.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        _cache_set(cache_key, data)
        return data, version
    finally:
        for crop in crops:
            try:
                crop.close()
            except Exception:
                pass
