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
    assert config.model_dump_json(indent=2, exclude_none=True) == snapshot(
        """\
{
  "default_model": "",
  "models": {},
  "providers": {},
  "loop_control": {
    "max_steps_per_run": 100,
    "max_retries_per_step": 3
  },
  "services": {}
}\
"""
    )
