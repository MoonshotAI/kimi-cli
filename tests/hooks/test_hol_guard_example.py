import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


_PATH = Path(__file__).parents[2] / "examples" / "hooks" / "hol_guard_pre_tool.py"
_spec = importlib.util.spec_from_file_location("hol_guard_pre_tool", _PATH)
assert _spec and _spec.loader
module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(module)


def _event(command: str = "git status") -> dict:
    return {"hook_event_name": "PreToolUse", "tool_name": "Shell", "tool_input": {"command": command}}


@pytest.mark.parametrize(("returncode", "decision", "expected"), [(0, "benign", 0), (0, "review", 2), (1, "", 2)])
def test_guard_decisions(monkeypatch, returncode: int, decision: str, expected: int) -> None:
    monkeypatch.setattr(module.shutil, "which", lambda _: "/usr/bin/hol-guard")
    output = f'{{"decision":"{decision}"}}' if decision else ""
    monkeypatch.setattr(module.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=returncode, stdout=output))
    assert module.evaluate(_event()) == expected


def test_missing_command_or_guard_blocks(monkeypatch) -> None:
    assert module.evaluate(_event("")) == 2
    monkeypatch.setattr(module.shutil, "which", lambda _: None)
    assert module.evaluate(_event()) == 2
