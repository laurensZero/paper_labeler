"""把 portable 更新包上传到 R2，并写入 app-update/latest.json 清单。

用法：
  python scripts/upload_release_r2.py "frontend-vite/dist/Paper Labeler-1.0.1-portable.exe" \
    --version 1.0.1 \
    --notes-file release-notes.md \
    --level prompt

  可选：
    --html-url   发布页（默认 GitHub tag 页，仅作说明字段）
    --dry-run    只打印将写入的对象，不上传

R2 对象布局：
  app-update/{version}/{filename}   更新包（只保留最近 2 个版本）
  app-update/latest.json            桌面端检查更新用清单
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

# Windows CI / 本地终端默认可能是 cp1252，中文 print 会炸
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.cloud import r2  # noqa: E402
from backend.cloud.config import get_cloud_config  # noqa: E402

UPLOAD_TIMEOUT_S = 600
KEEP_VERSIONS = 2
APP_UPDATE_PREFIX = "app-update/"


def _parse_version_from_name(name: str) -> str | None:
    m = re.search(r"(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)", name)
    return m.group(1) if m else None


def _version_sort_key(version: str):
    """与前端 compareVersions 同语义：数字段比较，正式版 > 预发布。"""
    norm = version.strip().lstrip("vV")
    base, _, pre = norm.partition("-")
    parts = []
    for piece in base.split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    # 预发布排在正式版前（升序时 pre 靠前 = 更旧）
    return (parts, 1 if not pre else 0, pre.lower())


def _prune_old_versions(cfg, keep: set[str], *, dry_run: bool) -> list[str]:
    """删除 app-update/ 下不在 keep 集合中的版本目录，返回被删 key。"""
    keys = r2.list_keys(cfg, APP_UPDATE_PREFIX)
    stale: list[str] = []
    for key in keys:
        if key == "app-update/latest.json":
            continue
        rest = key[len(APP_UPDATE_PREFIX) :]
        version_dir = rest.split("/", 1)[0] if rest else ""
        if not version_dir or version_dir in keep:
            continue
        stale.append(key)
    if dry_run or not stale:
        return stale
    r2.delete_keys(cfg, stale)
    return stale


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload portable update package to R2")
    parser.add_argument("exe", type=Path, help="portable exe 路径")
    parser.add_argument("--version", dest="version", help="版本号，如 1.0.1（默认从文件名解析）")
    parser.add_argument("--notes", dest="notes", default="", help="更新说明（可多行，用 \\n）")
    parser.add_argument("--notes-file", dest="notes_file", type=Path, help="更新说明文件")
    parser.add_argument(
        "--level",
        dest="level",
        choices=("force", "prompt", "silent"),
        default="prompt",
        help="update_level（写入更新说明末尾）",
    )
    parser.add_argument("--html-url", dest="html_url", default="", help="发布页 URL")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不上传")
    args = parser.parse_args()

    exe: Path = args.exe
    if not exe.is_file():
        print(f"文件不存在: {exe}")
        return 1

    version = (args.version or "").strip() or _parse_version_from_name(exe.name)
    if not version:
        print("无法从文件名解析版本号，请显式传 --version")
        return 1

    notes = args.notes.replace("\\n", "\n")
    if args.notes_file:
        if not args.notes_file.is_file():
            print(f"更新说明文件不存在: {args.notes_file}")
            return 1
        notes = args.notes_file.read_text(encoding="utf-8").strip()
    notes = notes.strip()
    if notes and not re.search(r"update_level:\s*(force|prompt|silent)", notes, re.I):
        notes = f"{notes}\n\nupdate_level: {args.level}".strip()
    elif not notes:
        notes = f"update_level: {args.level}"

    tag = version if version.lower().startswith("v") else f"v{version}"
    version_dir = version.lstrip("vV")
    html_url = args.html_url or f"https://github.com/laurensZero/paper_labeler/releases/tag/{tag}"

    data = exe.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    size = len(data)

    cfg = get_cloud_config()
    missing = []
    for env_name, attr in (
        ("R2_ACCOUNT_ID", "r2_account_id"),
        ("R2_ACCESS_KEY_ID", "r2_access_key_id"),
        ("R2_SECRET_ACCESS_KEY", "r2_secret_access_key"),
        ("R2_PUBLIC_BASE", "r2_public_base"),
    ):
        if not getattr(cfg, attr):
            missing.append(env_name)
    if missing:
        print(f"R2 配置缺失: {missing}")
        return 1

    key = f"{APP_UPDATE_PREFIX}{version_dir}/{exe.name}"
    download_url = r2.public_url(cfg, key)

    manifest = {
        "tag_name": tag,
        "body": notes,
        "html_url": html_url,
        "assets": [
            {
                "name": exe.name,
                "browser_download_url": download_url,
                "size": size,
                "sha256": digest,
            }
        ],
        "source": "r2",
    }

    print(f"exe      : {exe}")
    print(f"version  : {version}")
    print(f"key      : {key}")
    print(f"size     : {size} bytes")
    print(f"sha256   : {digest}")
    print(f"download : {download_url}")
    print("manifest : app-update/latest.json")
    print(f"level    : {args.level}")
    if args.dry_run:
        print("\n[dry-run] 未上传")
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    print("\n上传更新包…")
    url = r2.put_object(cfg, key, data, content_type="application/octet-stream", timeout=UPLOAD_TIMEOUT_S)
    print(f"  OK -> {url}")

    print("写入 latest.json…")
    payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    murl = r2.put_object(cfg, f"{APP_UPDATE_PREFIX}latest.json", payload, content_type="application/json")
    print(f"  OK -> {murl}")

    # 只保留最近 KEEP_VERSIONS 个版本目录
    try:
        existing = r2.list_keys(cfg, APP_UPDATE_PREFIX)
    except r2.R2Error as exc:
        print(f"[warn] 列目录失败，跳过清理: {exc}")
        existing = []
    version_dirs = set()
    for k in existing:
        rest = k[len(APP_UPDATE_PREFIX):]
        if not rest or rest == "latest.json":
            continue
        version_dirs.add(rest.split("/", 1)[0])
    version_dirs.add(version_dir)
    ordered = sorted(version_dirs, key=_version_sort_key)
    keep = set(ordered[-KEEP_VERSIONS:]) if len(ordered) > KEEP_VERSIONS else set(ordered)
    stale = _prune_old_versions(cfg, keep, dry_run=False)
    if stale:
        print(f"\n清理旧版本（保留 {sorted(keep)}）:")
        for s in stale:
            print(f"  delete {s}")
    else:
        print(f"\n版本保留: {sorted(keep)}")

    print("\n完成。桌面端将从 R2 读取该清单检查更新。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
