"""Cloudflare R2（S3 兼容 API）写入端：SigV4 签名 + PUT 对象。

只实现同步所需的最小能力：put_object / public_url。
区域固定为 R2 要求的 "auto"。
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from backend.cloud.config import CloudConfig

_REGION = "auto"
_SERVICE = "s3"
_TIMEOUT_S = 120


class R2Error(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"R2 PUT failed: HTTP {status}: {body[:300]}")
        self.status = status


def _encode_path(path: str) -> str:
    # AWS 规范：逐段编码，保留 "/"
    return urllib.parse.quote(path, safe="/-_.~")


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, datestamp: str) -> bytes:
    k = _hmac(("AWS4" + secret).encode("utf-8"), datestamp)
    k = _hmac(k, _REGION)
    k = _hmac(k, _SERVICE)
    return _hmac(k, "aws4_request")


def _endpoint(cfg: CloudConfig) -> str:
    return f"https://{cfg.r2_account_id}.r2.cloudflarestorage.com"


def public_url(cfg: CloudConfig, key: str) -> str:
    return f"{cfg.r2_public_base}/{_encode_path(key)}"


def put_object(
    cfg: CloudConfig,
    key: str,
    data: bytes,
    content_type: str = "image/webp",
    timeout: float = _TIMEOUT_S,
) -> str:
    """PUT 一个对象到 R2，返回其公开读 URL。失败抛 R2Error。"""
    host = f"{cfg.r2_account_id}.r2.cloudflarestorage.com"
    canonical_uri = _encode_path(f"/{cfg.r2_bucket}/{key}")

    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(data).hexdigest()

    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        ["PUT", canonical_uri, "", canonical_headers, signed_headers, payload_hash]
    )

    algorithm = "AWS4-HMAC-SHA256"
    scope = f"{datestamp}/{_REGION}/{_SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        [
            algorithm,
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(cfg.r2_secret_access_key, datestamp),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        f"{algorithm} Credential={cfg.r2_access_key_id}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    url = f"{_endpoint(cfg)}/{cfg.r2_bucket}/{_encode_path(key)}"
    req = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={
            "Content-Type": content_type,
            "Host": host,
            "X-Amz-Content-Sha256": payload_hash,
            "X-Amz-Date": amz_date,
            "Authorization": authorization,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        raise R2Error(exc.code, exc.read().decode("utf-8", "replace")) from None
    except OSError as exc:
        raise R2Error(0, str(exc)) from None
    return public_url(cfg, key)


def list_keys(cfg: CloudConfig, prefix: str = "") -> list[str]:
    """列出 bucket 下指定前缀的对象 key。失败抛 R2Error。"""
    keys: list[str] = []
    token = ""
    host = f"{cfg.r2_account_id}.r2.cloudflarestorage.com"
    while True:
        params: dict[str, str] = {"list-type": "2", "max-keys": "1000"}
        if prefix:
            params["prefix"] = prefix
        if token:
            params["continuation-token"] = token
        canonical_query = "&".join(
            f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
            for k, v in sorted(params.items())
        )
        headers = _sig_headers(cfg, "GET", f"/{cfg.r2_bucket}", canonical_query, b"")
        url = f"https://{host}/{cfg.r2_bucket}?{canonical_query}"
        req = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            raise R2Error(exc.code, exc.read().decode("utf-8", "replace")) from None
        except OSError as exc:
            raise R2Error(0, str(exc)) from None
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


def delete_keys(cfg: CloudConfig, keys: list[str]) -> int:
    """批量删除对象，返回删除数量。失败抛 R2Error。"""
    if not keys:
        return 0
    deleted = 0
    host = f"{cfg.r2_account_id}.r2.cloudflarestorage.com"
    for i in range(0, len(keys), 1000):
        chunk = keys[i : i + 1000]
        parts = ['<?xml version="1.0" encoding="UTF-8"?>', "<Delete>"]
        for k in chunk:
            parts.append(f"<Object><Key>{k.replace('&', '&amp;').replace('<', '&lt;')}</Key></Object>")
        parts.append("</Delete>")
        payload = "".join(parts).encode("utf-8")
        canonical_query = "delete="
        headers = _sig_headers(cfg, "POST", f"/{cfg.r2_bucket}", canonical_query, payload)
        headers["Content-Type"] = "application/xml"
        url = f"https://{host}/{cfg.r2_bucket}?delete"
        req = urllib.request.Request(url, data=payload, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp.read()
            deleted += len(chunk)
        except urllib.error.HTTPError as exc:
            raise R2Error(exc.code, exc.read().decode("utf-8", "replace")) from None
        except OSError as exc:
            raise R2Error(0, str(exc)) from None
    return deleted
