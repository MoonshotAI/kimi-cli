"""Multi-language loader for system prompts."""
from __future__ import annotations

import json
from pathlib import Path

_LOCALES_DIR = Path(__file__).with_name("locales")

def get_prompt(locale: str = "en") -> str:
    """Return system prompt in requested language."""
    file = _LOCALES_DIR / f"{locale}.json"
    if not file.exists():
        file = _LOCALES_DIR / "en.json"          # fallback
    return json.loads(file.read_text(encoding="utf-8"))["system_prompt"]
