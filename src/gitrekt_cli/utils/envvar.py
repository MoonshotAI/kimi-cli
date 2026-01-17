from __future__ import annotations

import os

_TRUE_VALUES = {"1", "true", "t", "yes", "y"}


def get_env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in _TRUE_VALUES
