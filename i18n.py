import json
from pathlib import Path

_LOCALES_DIR = Path(__file__).with_name("locales")

def load_locale(lang: str = "en") -> dict:
    file = _LOCALES_DIR / f"{lang}.json"
    if not file.exists():
        file = _LOCALES_DIR / "en.json"   # düşülme güvenliği
    return json.loads(file.read_text(encoding="utf-8"))

def system_prompt(lang: str = "en") -> str:
    return load_locale(lang)["system_prompt"]
