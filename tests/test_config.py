from __future__ import annotations

import pytest
from inline_snapshot import snapshot

from kimi_cli.config import (
    Config,
    Services,
    get_default_config,
    load_config_from_string,
)
from kimi_cli.exception import ConfigError


def test_default_config():
    config = get_default_config()
    assert config == snapshot(
        Config(
            default_model="",
            default_thinking=False,
            models={},
            providers={},
            services=Services(),
        )
    )


def test_default_config_dump():
    config = get_default_config()
    assert config.model_dump() == snapshot(
        {
            "default_model": "",
            "default_thinking": False,
            "models": {},
            "providers": {},
            "loop_control": {
                "max_steps_per_turn": 100,
                "max_retries_per_step": 3,
                "max_ralph_iterations": 0,
                "auto_compact_threshold": 0.8,
            },
            "services": {"moonshot_search": None, "moonshot_fetch": None},
            "mcp": {"client": {"tool_call_timeout_ms": 60000}},
        }
    )


def test_load_config_text_toml():
    config = load_config_from_string('default_model = ""\n')
    assert config == get_default_config()


def test_load_config_text_json():
    config = load_config_from_string('{"default_model": ""}')
    assert config == get_default_config()


def test_load_config_text_invalid():
    with pytest.raises(ConfigError, match="Invalid configuration text"):
        load_config_from_string("not valid {")


def test_load_config_invalid_ralph_iterations():
    with pytest.raises(ConfigError, match="max_ralph_iterations"):
        load_config_from_string('{"loop_control": {"max_ralph_iterations": -2}}')


def test_load_config_auto_compact_threshold():
    config = load_config_from_string('{"loop_control": {"auto_compact_threshold": 0.7}}')
    assert config.loop_control.auto_compact_threshold == 0.7


def test_load_config_auto_compact_threshold_too_low():
    with pytest.raises(ConfigError, match="auto_compact_threshold"):
        load_config_from_string('{"loop_control": {"auto_compact_threshold": 0.05}}')


def test_load_config_auto_compact_threshold_too_high():
    with pytest.raises(ConfigError, match="auto_compact_threshold"):
        load_config_from_string('{"loop_control": {"auto_compact_threshold": 1.5}}')
