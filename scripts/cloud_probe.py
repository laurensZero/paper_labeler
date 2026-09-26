"""云端连通性探针：检查 .env 配置 → Supabase REST → R2 上传/公开读。

用法：venv\\Scripts\\python.exe scripts/cloud_probe.py
"""
from __future__ import annotations

import io
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.cloud import r2, supabase  # noqa: E402
from backend.cloud.config import cloud_enabled, get_cloud_config, missing_config  # noqa: E402


def main() -> int:
    cfg = get_cloud_config()
    print(f"enabled={cloud_enabled()} missing={missing_config(cfg)}")
    if not cloud_enabled() or missing_config(cfg):
        return 1

    # 1) Supabase REST（service role）
    try:
        rows = supabase.select(cfg, "profiles", "id,role", limit=5)
        print(f"[supabase] OK — profiles 可读，行数={len(rows)}（表已建）")
    except supabase.SupabaseError as exc:
        if exc.status == 42 and "relation" in str(exc).lower():
            print("[supabase] 认证 OK，但表还不存在 —— 需要先执行 0001_init.sql")
        else:
            print(f"[supabase] 错误: {exc}")
            return 1

    # 2) R2 上传 + 公开读
    try:
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (4, 4), (200, 30, 30)).save(buf, "WEBP")
        key = "_probe/ping.webp"
        url = r2.put_object(cfg, key, buf.getvalue())
        print(f"[r2] PUT OK -> {url}")
        # r2.dev 有 CF bot 防护，Python 默认 UA 会吃 error 1010；用浏览器 UA 验证
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        ok = resp.status == 200 and data[:4] == b"RIFF"
        print(f"[r2] 公开读 {'OK' if ok else f'异常 status={resp.status}'} ({len(data)} bytes)")
        if not ok:
            return 1
    except Exception as exc:
        print(f"[r2] 错误: {exc}")
        return 1

    print("探针全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
