from __future__ import annotations

from inline_snapshot import snapshot

from kimi_cli.config import (
    Config,
    Services,
    get_default_config,
)


def test_default_config():
    config = get_default_config()
    assert config == snapshot(
        Config(
            default_model="",
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
            "models": {},
            "providers": {},
            "loop_control": {"max_steps_per_run": 100, "max_retries_per_step": 3},
            "services": {"moonshot_search": None, "moonshot_fetch": None},
            "mcp": {"client": {"tool_call_timeout_ms": 60000}},
        }
    )
