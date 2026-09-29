"""只读盘点云端：Supabase 各表行数 + R2 对象数量/前缀分布。

用法：venv\\Scripts\\python.exe scripts/cloud_inventory.py
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.cloud import supabase  # noqa: E402
from backend.cloud.config import get_cloud_config, missing_config  # noqa: E402

TABLES = [
    "papers",
    "questions",
    "question_boxes",
    "answers",
    "answer_boxes",
    "section_defs",
    "section_groups",
    "section_group_members",
    "question_sections",
    "compositions",
    "composition_items",
    "suggestions",
    "export_jobs",
    "sync_log",
    "profiles",
    "question_grants",
    "question_user_data",
    "app_config",
]


def _count(cfg, table: str) -> str:
    # Prefer-accurate via Prefer: count=exact head request
    url = f"{cfg.supabase_url}/rest/v1/{table}?select=id"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "apikey": cfg.service_role_key,
            "Authorization": f"Bearer {cfg.service_role_key}",
            "Prefer": "count=exact",
            "Range-Unit": "items",
            "Range": "0-0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            content_range = resp.headers.get("Content-Range") or ""
            # format: 0-0/123
            if "/" in content_range:
                return content_range.split("/", 1)[1]
            body = resp.read()
            return f"rows~{len(json.loads(body)) if body.strip() else 0}"
    except urllib.error.HTTPError as exc:
        return f"ERR:{exc.code}:{exc.read().decode('utf-8', 'replace')[:80]}"
    except Exception as exc:
        return f"ERR:{exc}"


def _sample(cfg, table: str, columns: str, limit: int = 5) -> list[dict]:
    try:
        return supabase.select(cfg, table, columns, limit=limit)
    except Exception as exc:
        return [{"_error": str(exc)[:120]}]


def _r2_list(cfg, prefix: str = "", max_keys: int = 1000) -> list[str]:
    """List objects under prefix (S3 ListObjectsV2). Returns keys."""
    host = f"{cfg.r2_account_id}.r2.cloudflarestorage.com"
    region, service = "auto", "s3"
    keys: list[str] = []
    token = ""
    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        qs = urllib.parse.urlencode(params)
        canonical_uri = f"/{cfg.r2_bucket}"
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        canonical_query = "&".join(
            f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
            for k, v in sorted(params.items())
        )
        payload_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        canonical_headers = f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
        canonical_request = "\n".join(
            ["GET", canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash]
        )
        scope = f"{datestamp}/{region}/{service}/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
            ]
        )

        def _hmac(key: bytes, msg: str) -> bytes:
            return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

        k = _hmac(("AWS4" + cfg.r2_secret_access_key).encode("utf-8"), datestamp)
        k = _hmac(k, region)
        k = _hmac(k, service)
        k = _hmac(k, "aws4_request")
        signature = hmac.new(k, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        auth = (
            f"AWS4-HMAC-SHA256 Credential={cfg.r2_access_key_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        url = f"https://{host}/{cfg.r2_bucket}?{qs}"
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": auth,
                "Host": host,
                "X-Amz-Content-Sha256": payload_hash,
                "X-Amz-Date": amz_date,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            print(f"[r2] list ERR {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}")
            break
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
            if len(keys) >= max_keys:
                break
            continue
        break
    return keys


def main() -> int:
    cfg = get_cloud_config()
    missing = missing_config(cfg)
    print(f"missing={missing}")
    if missing:
        return 1

    print("\n=== Supabase counts ===")
    for t in TABLES:
        n = _count(cfg, t)
        print(f"  {t:28s} {n}")

    print("\n=== samples ===")
    print("profiles:", json.dumps(_sample(cfg, "profiles", "id,email,role,created_at"), ensure_ascii=False))
    print("papers:", json.dumps(_sample(cfg, "papers", "id,filename,exam_code,year_token,season_token,done,deleted_at", 3), ensure_ascii=False))
    print("questions:", json.dumps(_sample(cfg, "questions", "id,paper_id,question_no,status,section,deleted_at", 3), ensure_ascii=False))
    print("compositions:", json.dumps(_sample(cfg, "compositions", "id,name,owner_id,visibility,created_at", 3), ensure_ascii=False))
    print("export_jobs:", json.dumps(_sample(cfg, "export_jobs", "id,status,result_key,created_at", 3), ensure_ascii=False))
    print("question_user_data:", json.dumps(_sample(cfg, "question_user_data", "*", 3), ensure_ascii=False))

    print("\n=== R2 objects ===")
    keys = _r2_list(cfg)
    print(f"total keys (capped): {len(keys)}")
    prefixes = Counter()
    for k in keys:
        parts = k.split("/")
        prefixes["/".join(parts[:2]) if len(parts) > 1 else parts[0]] += 1
    for p, c in prefixes.most_common(30):
        print(f"  {p:40s} {c}")
    if keys:
        print("sample keys:", keys[:8])
    print(f"probe/_probe present: {any(k.startswith('_probe') for k in keys)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
