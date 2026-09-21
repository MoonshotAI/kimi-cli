from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from dotenv import dotenv_values


def load_dotenv_values(env_file: Path | None) -> dict[str, str]:
    """Read dotenv values without modifying the process environment."""
    if env_file is None:
        return {}
    return {key: value for key, value in dotenv_values(env_file).items() if value is not None}


def load_llm_env(env_file: Path | None) -> Mapping[str, str]:
    """Return process environment with values from a local dotenv file overlaid.

    This deliberately does not call ``load_dotenv``: loading a project file must
    not mutate the CLI process environment or leak its values to other code.
    """
    env = dict(os.environ)
    env.update(load_dotenv_values(env_file))
    return env
