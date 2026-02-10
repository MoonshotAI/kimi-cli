from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from kimi_cli.config import Config

REDACTED = "***"


def redact_config(config: Config) -> dict[str, Any]:
    """Serialize config and redact all sensitive fields."""
    data = config.model_dump(mode="json", exclude_none=True)

    # Redact providers
    for provider_data in data.get("providers", {}).values():
        if "api_key" in provider_data:
            provider_data["api_key"] = REDACTED
        if "oauth" in provider_data and provider_data["oauth"]:
            provider_data["oauth"]["key"] = REDACTED
        if "custom_headers" in provider_data:
            provider_data["custom_headers"] = REDACTED
        if "env" in provider_data:
            provider_data["env"] = REDACTED

    # Redact services
    services = data.get("services", {})
    if services:
        for svc_name in ("moonshot_search", "moonshot_fetch"):
            svc = services.get(svc_name)
            if not svc:
                continue
            if "api_key" in svc:
                svc["api_key"] = REDACTED
            if "custom_headers" in svc:
                svc["custom_headers"] = REDACTED
            if "oauth" in svc and svc["oauth"]:
                svc["oauth"]["key"] = REDACTED

    return data


def anonymize_path(path: str) -> str:
    """Replace home directory with ~."""
    home = str(Path.home())
    if path.startswith(home):
        return "~" + path[len(home) :]
    return path


def redact_git_url(url: str) -> str:
    """Remove auth tokens from git URLs."""
    return re.sub(r"(https?://)([^@]+)@", r"\1***@", url)


def redact_log_content(content: str) -> str:
    """Remove secret patterns from log content."""
    content = re.sub(r"(sk-)[a-zA-Z0-9]{10,}", r"\1***", content)
    content = re.sub(r"(Bearer\s+)[a-zA-Z0-9._-]+", r"\1***", content)
    content = re.sub(r"(api_key[\"\s=:]+)[\"']?[a-zA-Z0-9._-]+", r"\1***", content)
    return content
