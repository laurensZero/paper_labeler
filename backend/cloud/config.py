from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_dotenv_loaded = False


def _load_dotenv() -> None:
    """极简 .env 加载（无三方依赖）。已存在的环境变量优先，不被覆盖。"""
    global _dotenv_loaded
    if _dotenv_loaded:
        return
    _dotenv_loaded = True
    path = _ROOT / ".env"
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, _, val = s.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        if key and key not in os.environ:
            os.environ[key] = val


def _env(key: str) -> str:
    return os.getenv(key, "").strip()


@dataclass(frozen=True)
class CloudConfig:
    supabase_url: str
    service_role_key: str
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    r2_public_base: str


def get_cloud_config() -> CloudConfig:
    _load_dotenv()
    return CloudConfig(
        supabase_url=_env("SUPABASE_URL").rstrip("/"),
        service_role_key=_env("SUPABASE_SERVICE_ROLE_KEY"),
        r2_account_id=_env("R2_ACCOUNT_ID"),
        r2_access_key_id=_env("R2_ACCESS_KEY_ID"),
        r2_secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        r2_bucket=_env("R2_BUCKET") or "paper-labeler",
        r2_public_base=_env("R2_PUBLIC_BASE").rstrip("/"),
    )


def cloud_enabled() -> bool:
    _load_dotenv()
    return _env("PAPER_CLOUD_ENABLED") == "1"


def get_cloud_token() -> str:
    """Local management token for /cloud/* write endpoints (PAPER_CLOUD_TOKEN)."""
    _load_dotenv()
    return _env("PAPER_CLOUD_TOKEN")


def missing_config(cfg: CloudConfig) -> list[str]:
    """返回尚未配置的必填项名称（按 .env.example 顺序）。"""
    checks = [
        ("SUPABASE_URL", cfg.supabase_url),
        ("SUPABASE_SERVICE_ROLE_KEY", cfg.service_role_key),
        ("R2_ACCOUNT_ID", cfg.r2_account_id),
        ("R2_ACCESS_KEY_ID", cfg.r2_access_key_id),
        ("R2_SECRET_ACCESS_KEY", cfg.r2_secret_access_key),
        ("R2_PUBLIC_BASE", cfg.r2_public_base),
    ]
    return [name for name, value in checks if not value]
