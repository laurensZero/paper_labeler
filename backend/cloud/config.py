from __future__ import annotations

import os
import secrets
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
        r2_bucket=_env("R2_BUCKET") or "paperlabeler",
        r2_public_base=_env("R2_PUBLIC_BASE").rstrip("/"),
    )


def cloud_enabled() -> bool:
    _load_dotenv()
    return _env("PAPER_CLOUD_ENABLED") == "1"


# 自动生成的管理令牌（.env 未配置 PAPER_CLOUD_TOKEN 时使用；进程内稳定，
# 前端通过 GET /cloud/config 的 form.PAPER_CLOUD_TOKEN 收取并存 localStorage）
_auto_token: str | None = None


def get_cloud_token() -> str:
    """Local management token for /cloud/* write endpoints (PAPER_CLOUD_TOKEN).

    优先级：.env 配置值 → 自动生成（免手动配置）。
    """
    global _auto_token
    _load_dotenv()
    tok = _env("PAPER_CLOUD_TOKEN")
    if tok:
        return tok
    if _auto_token is None:
        _auto_token = secrets.token_urlsafe(16)
    return _auto_token


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


def _quote_env_value(val: str) -> str:
    if val == "":
        return ""
    if any(ch in val for ch in " \t#\"'"):
        escaped = val.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return val


def save_env_values(values: dict[str, str]) -> None:
    """把键值 upsert 进根 .env（保留注释与无关行），并同步刷新 os.environ —— 免重启生效。

    空字符串语义 = 清除该配置（写成 KEY=，同时从 os.environ 移除）。
    管理端「设置 → 云端」的图形化保存走这里，发行版用户不手编文件。
    """
    path = _ROOT / ".env"
    lines: list[str] = []
    if path.exists():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
    pending = dict(values)
    out: list[str] = []
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            key = s.partition("=")[0].strip()
            if key in pending:
                out.append(f"{key}={_quote_env_value(pending.pop(key))}")
                continue
        out.append(line)
    for key, val in pending.items():
        out.append(f"{key}={_quote_env_value(val)}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    for key, val in values.items():
        if val == "":
            os.environ.pop(key, None)
        else:
            os.environ[key] = val
