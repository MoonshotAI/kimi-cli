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


def _verdict(*, explicitly_benign: bool, minimum_action: str) -> str:
    benign = "true" if explicitly_benign else "false"
    return (
        '{"classification":{"explicitly_benign":'
        f'{benign}}},"minimum_action":"{minimum_action}"}}'
    )


@pytest.mark.parametrize(
    ("returncode", "explicitly_benign", "minimum_action", "expected"),
    [
        (0, True, "allow", 0),
        (0, False, "allow", 2),
        (0, True, "review", 2),
        (1, True, "allow", 2),
    ],
)
def test_guard_decisions(
    monkeypatch,
    returncode: int,
    explicitly_benign: bool,
    minimum_action: str,
    expected: int,
) -> None:
    monkeypatch.setattr(module.shutil, "which", lambda _: "/usr/bin/hol-guard")
    output = _verdict(
        explicitly_benign=explicitly_benign,
        minimum_action=minimum_action,
    )
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=returncode, stdout=output),
    )
    assert module.evaluate(_event()) == expected


def test_missing_command_or_guard_blocks(monkeypatch) -> None:
    assert module.evaluate(_event("")) == 2
    monkeypatch.setattr(module.shutil, "which", lambda _: None)
    assert module.evaluate(_event()) == 2
