"""上线前清空云端测试数据：Supabase 业务表 + R2 全部对象 + 多余账号。

用法：
  venv\\Scripts\\python.exe scripts/cloud_purge.py            # dry-run，只打印
  venv\\Scripts\\python.exe scripts/cloud_purge.py --yes      # 真正删除

范围（与产品确认）：
  - 清空全部业务表（papers/questions/boxes/answers/sections/compositions/...）
  - 清空 R2 全部对象
  - 账号只保留 KEEP_ADMIN_EMAIL，其余 auth 用户删除
  - 保留数据库 schema / RLS / 迁移
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import hmac
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.cloud import supabase  # noqa: E402
from backend.cloud.config import get_cloud_config, missing_config  # noqa: E402

KEEP_ADMIN_EMAIL = "admin@paperlabeler.test"

# 依赖顺序：子表在前
TABLES_ALL = [
    ("composition_items", {"id": "not.is.null"}),
    ("compositions", {"id": "not.is.null"}),
    ("export_jobs", {"id": "not.is.null"}),
    ("suggestions", {"id": "not.is.null"}),
    ("question_user_data", {"question_id": "not.is.null"}),
    ("question_grants", {"id": "not.is.null"}),
    ("question_sections", {"id": "not.is.null"}),
    ("section_group_members", {"id": "not.is.null"}),
    ("section_groups", {"id": "not.is.null"}),
    ("section_defs", {"id": "not.is.null"}),
    ("answer_boxes", {"id": "not.is.null"}),
    ("answers", {"id": "not.is.null"}),
    ("question_boxes", {"id": "not.is.null"}),
    ("questions", {"id": "not.is.null"}),
    ("papers", {"id": "not.is.null"}),
    ("sync_log", {"id": "not.is.null"}),
    ("app_config", {"key": "not.is.null"}),
]

_REGION, _SERVICE = "auto", "s3"


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sig_headers(cfg, method: str, canonical_uri: str, canonical_query: str, payload: bytes) -> dict:
    host = f"{cfg.r2_account_id}.r2.cloudflarestorage.com"
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(payload).hexdigest()
    canonical_headers = (
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        [method, canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash]
    )
    scope = f"{datestamp}/{_REGION}/{_SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    k = _hmac(("AWS4" + cfg.r2_secret_access_key).encode("utf-8"), datestamp)
    k = _hmac(k, _REGION)
    k = _hmac(k, _SERVICE)
    k = _hmac(k, "aws4_request")
    signature = hmac.new(k, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    auth = (
        f"AWS4-HMAC-SHA256 Credential={cfg.r2_access_key_id}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {
        "Authorization": auth,
        "Host": host,
        "X-Amz-Content-Sha256": payload_hash,
        "X-Amz-Date": amz_date,
    }


def r2_list_keys(cfg) -> list[str]:
    keys: list[str] = []
    token = ""
    while True:
        params: dict[str, str] = {"list-type": "2", "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        canonical_query = "&".join(
            f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
            for k, v in sorted(params.items())
        )
        headers = _sig_headers(cfg, "GET", f"/{cfg.r2_bucket}", canonical_query, b"")
        url = f"https://{cfg.r2_account_id}.r2.cloudflarestorage.com/{cfg.r2_bucket}?{canonical_query}"
        req = urllib.request.Request(url, method="GET", headers=headers)
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read()
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        root = ET.fromstring(body)
        for contents in root.findall("s3:Contents", ns):
            key_el = contents.find("s3:Key", ns)
            if key_el is not None and key_el.text:
                keys.append(key_el.text)
        truncated = root.find("s3:IsTruncated", ns)
        next_token = root.find("s3:NextContinuationToken", ns)
        if truncated is not None and truncated.text == "true" and next_token is not None and next_token.text:
            token = next_token.text
            continue
        break
    return keys


def r2_delete_keys(cfg, keys: list[str], *, apply: bool) -> int:
    if not keys:
        return 0
    deleted = 0
    # DeleteObjects: max 1000 keys per request
    for i in range(0, len(keys), 1000):
        chunk = keys[i : i + 1000]
        parts = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>", "<Delete>"]
        for k in chunk:
            parts.append(f"<Object><Key>{k.replace('&', '&amp;').replace('<', '&lt;')}</Key></Object>")
        parts.append("</Delete>")
        payload = "".join(parts).encode("utf-8")
        if not apply:
            deleted += len(chunk)
            continue
        canonical_query = "delete="
        headers = _sig_headers(cfg, "POST", f"/{cfg.r2_bucket}", canonical_query, payload)
        headers["Content-Type"] = "application/xml"
        url = f"https://{cfg.r2_account_id}.r2.cloudflarestorage.com/{cfg.r2_bucket}?delete"
        req = urllib.request.Request(url, data=payload, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp.read()
            deleted += len(chunk)
        except urllib.error.HTTPError as exc:
            print(f"  [r2] delete batch failed HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}")
            raise
    return deleted


def list_auth_users(cfg) -> list[dict]:
    users: list[dict] = []
    page = 1
    while True:
        status, body = supabase._auth_request(cfg, "GET", f"admin/users?page={page}&per_page=200")
        if status >= 400:
            raise RuntimeError(f"list users failed: {status} {body}")
        batch = body.get("users") or []
        users.extend(batch)
        if len(batch) < 200:
            break
        page += 1
    return users


def main() -> int:
    parser = argparse.ArgumentParser(description="Purge cloud test data before production")
    parser.add_argument("--yes", action="store_true", help="actually delete (default: dry-run)")
    args = parser.parse_args()
    apply = bool(args.yes)

    cfg = get_cloud_config()
    missing = missing_config(cfg)
    print(f"missing_config={missing}")
    if missing:
        return 1

    mode = "APPLY" if apply else "DRY-RUN"
    print(f"\n=== cloud purge ({mode}) ===")
    print(f"keep admin: {KEEP_ADMIN_EMAIL}")

    # --- R2 ---
    # 保留 app-update/（桌面端更新包与 latest.json），只清业务/测试对象
    try:
        keys = [k for k in r2_list_keys(cfg) if not k.startswith("app-update/")]
    except Exception as exc:
        print(f"[r2] list failed: {exc}")
        return 1
    print(f"\n[r2] objects to delete: {len(keys)}")
    if keys:
        sample = keys[:5]
        print(f"  sample: {sample}")
    if apply:
        n = r2_delete_keys(cfg, keys, apply=True)
        print(f"[r2] deleted {n} objects")
    else:
        print(f"[r2] would delete {len(keys)} objects")

    # --- Supabase business tables ---
    print("\n[supabase] tables:")
    for table, filters in TABLES_ALL:
        try:
            rows = supabase.select(cfg, table, "*", filters, limit=1)
            # rough count via select of all would be heavy; use delete count later
            exists = "ok"
        except Exception as exc:
            exists = f"skip ({str(exc)[:60]})"
            rows = []
        if apply and exists == "ok":
            try:
                n = supabase.delete_filtered(cfg, table, filters)
                print(f"  {table:28s} deleted={n}")
            except Exception as exc:
                print(f"  {table:28s} DELETE FAILED: {exc}")
                return 1
        else:
            print(f"  {table:28s} {exists}")

    # --- accounts ---
    print("\n[auth] users:")
    try:
        users = list_auth_users(cfg)
    except Exception as exc:
        print(f"  list failed: {exc}")
        users = []
    to_delete = []
    for u in users:
        email = (u.get("email") or "").strip().lower()
        uid = u.get("id")
        keep = email == KEEP_ADMIN_EMAIL.lower()
        mark = "KEEP" if keep else "DELETE"
        print(f"  {mark:6s} {email or uid}")
        if not keep and uid:
            to_delete.append((uid, email or uid))
    if apply:
        for uid, label in to_delete:
            try:
                supabase.admin_delete_user(cfg, uid)
                print(f"  deleted user {label}")
            except Exception as exc:
                print(f"  delete user {label} FAILED: {exc}")
                return 1
    else:
        print(f"  would delete {len(to_delete)} users")

    print(f"\n=== done ({mode}) ===")
    if not apply:
        print("Re-run with --yes to actually delete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
