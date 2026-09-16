import importlib.util
from pathlib import Path
from types import SimpleNamespace


_EXAMPLE = Path(__file__).parents[2] / "examples" / "hooks" / "hol_guard_pre_tool.py"
_spec = importlib.util.spec_from_file_location("hol_guard_pre_tool", _EXAMPLE)
assert _spec and _spec.loader
module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(module)


def _event(command: str = "git status") -> dict:
    return {
        "hook_event_name": "PreToolUse",
        "tool_name": "Shell",
        "tool_input": {"command": command},
    }


def test_allows_only_explicit_benign(monkeypatch) -> None:
    monkeypatch.setattr(module.shutil, "which", lambda _: "/usr/bin/hol-guard")
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='{"decision":"benign"}'),
    )
    assert module.evaluate(_event()) == 0


def test_blocks_review_and_guard_failures(monkeypatch) -> None:
    monkeypatch.setattr(module.shutil, "which", lambda _: "/usr/bin/hol-guard")
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='{"decision":"review"}'),
    )
    assert module.evaluate(_event()) == 2

    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout=""),
    )
    assert module.evaluate(_event()) == 2


def test_blocks_missing_command_or_guard(monkeypatch) -> None:
    assert module.evaluate(_event("")) == 2
    monkeypatch.setattr(module.shutil, "which", lambda _: None)
    assert module.evaluate(_event()) == 2
