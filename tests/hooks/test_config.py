import pytest
import tomlkit
from pydantic import ValidationError

from kimi_cli.config import Config
from kimi_cli.hooks.config import HOOK_EVENT_TYPES, HookDef


def test_parse_hook_def():
    h = HookDef(event="PreToolUse", command="echo ok", matcher="Shell")
    assert h.event == "PreToolUse"
    assert h.timeout == 30

def test_default_matcher_is_empty():
    h = HookDef(event="Stop", command="echo done")
    assert h.matcher == ""

def test_invalid_event():
    with pytest.raises(ValidationError):
        HookDef(event="InvalidEvent", command="echo bad")

def test_all_event_types_defined():
    assert len(HOOK_EVENT_TYPES) == 13

def test_config_with_hooks():
    toml_str = '''
default_model = ""

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo ok"
timeout = 10

[[hooks]]
event = "PostToolUse"
matcher = "WriteFile"
command = "prettier --write"
'''
    data = tomlkit.parse(toml_str)
    config = Config.model_validate(data)
    assert len(config.hooks) == 2
    assert config.hooks[0].event == "PreToolUse"
    assert config.hooks[0].matcher == "Shell"
    assert config.hooks[1].timeout == 30

def test_config_without_hooks():
    config = Config.model_validate({"default_model": ""})
    assert config.hooks == []
