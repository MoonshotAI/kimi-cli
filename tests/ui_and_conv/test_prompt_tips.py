from __future__ import annotations

import os
import time
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import MagicMock

import pytest

from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell import prompt as shell_prompt
from kimi_cli.ui.shell.prompt import (
    _GIT_STATUS_TTL,
    PROMPT_SYMBOL,
    BgTaskCounts,
    CustomPromptSession,
    PromptMode,
    UserInput,
    _build_toolbar_tips,
    _display_width,
    _format_git_badge,
    _get_git_branch,
    _get_git_status,
    _git_branch_state,
    _git_status_state,
    _shorten_cwd,
    _toast_queues,
    _truncate_left,
    _truncate_right,
    toast,
)

# ── Shared helpers ─────────────────────────────────────────────────────────────


class _DummyRunningPrompt:
    modal_priority = 10

    def render_running_prompt_body(self, columns: int) -> str:
        return f"live view ({columns})"

    def running_prompt_placeholder(self) -> None:
        return None

    def running_prompt_allows_text_input(self) -> bool:
        return True

    def running_prompt_hides_input_buffer(self) -> bool:
        return False

    def running_prompt_accepts_submission(self) -> bool:
        return True

    def should_handle_running_prompt_key(self, key: str) -> bool:
        return key == "enter"

    def handle_running_prompt_key(self, key: str, event) -> None:
        raise AssertionError("Should not be called in this test")


class _DummyReadOnlyModal:
    modal_priority = 20

    def render_running_prompt_body(self, columns: int) -> str:
        return f"modal body ({columns})"

    def running_prompt_placeholder(self) -> None:
        return None

    def running_prompt_allows_text_input(self) -> bool:
        return False

    def running_prompt_hides_input_buffer(self) -> bool:
        return True

    def running_prompt_accepts_submission(self) -> bool:
        return True

    def should_handle_running_prompt_key(self, key: str) -> bool:
        return key == "enter"

    def handle_running_prompt_key(self, key: str, event) -> None:
        raise AssertionError("Should not be called in this test")


def _make_toolbar_session(*, model_name: str | None = None, tips: list[str] | None = None) -> Any:
    """Build a minimal CustomPromptSession for toolbar rendering tests."""
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._model_name = model_name
    prompt_session._thinking = False
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._background_task_count_provider = None
    prompt_session._tips = tips if tips is not None else []
    prompt_session._tip_rotation_index = 0
    prompt_session._last_tip_rotate_time = float("inf")  # prevent time-based rotation
    return prompt_session


def _render_toolbar_lines(
    prompt_session: Any,
    width: int,
    monkeypatch: Any,
    *,
    git_branch: str | None = None,
    git_status_result: tuple[bool, int, int] = (False, 0, 0),
    cwd: str = "~/proj",
    before_render: Callable[[], None] | None = None,
) -> list[str]:
    """Patch the environment, optionally run setup, render the toolbar, return lines."""

    class _DummyOutput:
        @staticmethod
        def get_size() -> Any:
            return SimpleNamespace(columns=width)

    monkeypatch.setattr(
        shell_prompt, "get_app_or_none", lambda: SimpleNamespace(output=_DummyOutput())
    )
    monkeypatch.setattr(shell_prompt, "_get_git_branch", lambda: git_branch)
    monkeypatch.setattr(shell_prompt, "_get_git_status", lambda: git_status_result)
    monkeypatch.setattr(shell_prompt, "_shorten_cwd", lambda _: cwd)
    _toast_queues["left"].clear()
    _toast_queues["right"].clear()
    if before_render is not None:
        before_render()

    rendered = prompt_session._render_bottom_toolbar()
    plain = "".join(fragment[1] for fragment in rendered)
    return cast(list[str], plain.split("\n"))


# ── _build_toolbar_tips ────────────────────────────────────────────────────────


def test_build_toolbar_tips_without_clipboard() -> None:
    assert _build_toolbar_tips(clipboard_available=False) == [
        "ctrl-x: toggle mode",
        "shift-tab: plan mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "/feedback: send feedback",
        "/theme: switch dark/light",
        "@: mention files",
    ]


def test_build_toolbar_tips_with_clipboard() -> None:
    assert _build_toolbar_tips(clipboard_available=True) == [
        "ctrl-x: toggle mode",
        "shift-tab: plan mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "/feedback: send feedback",
        "/theme: switch dark/light",
        "ctrl-v: paste clipboard",
        "@: mention files",
    ]


# ── _display_width ─────────────────────────────────────────────────────────────


def test_display_width_empty() -> None:
    assert _display_width("") == 0


def test_display_width_ascii() -> None:
    assert _display_width("hello") == 5


def test_display_width_cjk_wide_chars() -> None:
    # Each CJK character occupies 2 terminal columns.
    assert _display_width("中文") == 4


def test_display_width_mixed_ascii_and_cjk() -> None:
    assert _display_width("a中b") == 4  # 1 + 2 + 1


# ── _truncate_left / _truncate_right ──────────────────────────────────────────


def test_truncate_left_within_limit_unchanged() -> None:
    assert _truncate_left("hello", 10) == "hello"


def test_truncate_left_ascii_exceeds_limit() -> None:
    # "abcde" width=5, max=4 → budget=3 → keep last 3 chars → "…cde"
    result = _truncate_left("abcde", 4)
    assert result == "…cde"
    assert _display_width(result) == 4


def test_truncate_left_cjk_exceeds_limit() -> None:
    # "中文中文" = 8 cols, max=5 → budget=4 → keep last 2 wide chars → "…中文"
    result = _truncate_left("中文中文", 5)
    assert result == "…中文"
    assert _display_width(result) == 5


def test_truncate_right_within_limit_unchanged() -> None:
    assert _truncate_right("hello", 10) == "hello"


def test_truncate_right_ascii_exceeds_limit() -> None:
    # "abcde" width=5, max=4 → budget=3 → keep first 3 chars → "abc…"
    result = _truncate_right("abcde", 4)
    assert result == "abc…"
    assert _display_width(result) == 4


def test_truncate_right_cjk_exceeds_limit() -> None:
    # "中文中文" = 8 cols, max=5 → budget=4 → keep first 2 wide chars → "中文…"
    result = _truncate_right("中文中文", 5)
    assert result == "中文…"
    assert _display_width(result) == 5


def test_truncate_right_zero_max_cols_returns_empty() -> None:
    # Contract: output width must be ≤ max_cols; when max_cols=0, must return ""
    assert _truncate_right("hello", 0) == ""
    assert _truncate_right("中文", 0) == ""


def test_truncate_left_zero_max_cols_returns_empty() -> None:
    # Contract: output width must be ≤ max_cols; when max_cols=0, must return ""
    assert _truncate_left("hello", 0) == ""
    assert _truncate_left("中文", 0) == ""


# ── _shorten_cwd ──────────────────────────────────────────────────────────────


def test_shorten_cwd_home_itself() -> None:
    home = os.path.expanduser("~")
    assert _shorten_cwd(home) == "~"


def test_shorten_cwd_subdirectory() -> None:
    home = os.path.expanduser("~")
    subdir = os.path.join(home, "projects", "myapp")
    assert _shorten_cwd(subdir) == "~/projects/myapp"


def test_shorten_cwd_unrelated_path() -> None:
    # A path outside of home is returned unchanged.
    assert _shorten_cwd("/etc/hosts") == "/etc/hosts"


# ── _format_git_badge ─────────────────────────────────────────────────────────


def test_format_git_badge_clean() -> None:
    assert _format_git_badge("main", False, 0, 0) == "main"


def test_format_git_badge_dirty_only() -> None:
    assert _format_git_badge("main", True, 0, 0) == "main [±]"


def test_format_git_badge_ahead_only() -> None:
    assert _format_git_badge("main", False, 3, 0) == "main [↑3]"


def test_format_git_badge_behind_only() -> None:
    assert _format_git_badge("main", False, 0, 1) == "main [↓1]"


def test_format_git_badge_all_three() -> None:
    assert _format_git_badge("main", True, 3, 1) == "main [± ↑3↓1]"


# ── Tip rotation logic ────────────────────────────────────────────────────────


def test_rotating_tips_empty_returns_none() -> None:
    session = _make_toolbar_session(tips=[])
    assert session._get_two_rotating_tips() is None
    assert session._get_one_rotating_tip() is None


def test_rotating_tips_single_tip_always_returned() -> None:
    session = _make_toolbar_session(tips=["ctrl-x: toggle mode"])
    assert session._get_two_rotating_tips() == "ctrl-x: toggle mode"
    assert session._get_one_rotating_tip() == "ctrl-x: toggle mode"


@pytest.mark.parametrize(
    "index,expected_two,expected_one",
    [
        (0, "tip-a | tip-b", "tip-a"),
        (1, "tip-b | tip-c", "tip-b"),
        (2, "tip-c | tip-a", "tip-c"),  # pair wraps around end of list
    ],
)
def test_rotating_tips_rotation_and_wrap(index: int, expected_two: str, expected_one: str) -> None:
    session = _make_toolbar_session(tips=["tip-a", "tip-b", "tip-c"])
    session._tip_rotation_index = index
    assert session._get_two_rotating_tips() == expected_two
    assert session._get_one_rotating_tip() == expected_one


# ── Toolbar overflow invariants ───────────────────────────────────────────────


@pytest.mark.parametrize("width", [40, 60, 80])
def test_bottom_toolbar_never_overflows(width: int, monkeypatch: Any) -> None:
    # Toolbar must always render exactly 3 lines (separator + info + toast/context).
    # Neither content line may exceed the terminal width, even with a tip far longer
    # than the terminal width or on narrow terminals where degradation kicks in.
    prompt_session = _make_toolbar_session(tips=["x" * (width * 2)])

    lines = _render_toolbar_lines(prompt_session, width, monkeypatch)

    assert len(lines) == 3, f"expected 3 lines, got {len(lines)}: {lines!r}"
    assert _display_width(lines[1]) <= width, (
        f"info line overflows at width={width}: {_display_width(lines[1])}"
    )
    assert _display_width(lines[2]) <= width, (
        f"toast/context line overflows at width={width}: {_display_width(lines[2])}"
    )


@pytest.mark.parametrize("width", [40, 50, 60])
def test_bottom_toolbar_narrow_terminal_with_full_decoration(width: int, monkeypatch: Any) -> None:
    # Regression: on narrow terminals, combining a long CWD path, a git branch badge
    # (dirty + ahead + behind), an active bg bash task, and a model name must never
    # push line 1 past the terminal width. The toolbar must degrade gracefully.
    prompt_session = _make_toolbar_session(
        model_name="kimi-latest",
        tips=["ctrl-x: toggle mode"],
    )
    prompt_session._background_task_count_provider = lambda: BgTaskCounts(bash=2, agent=0)

    lines = _render_toolbar_lines(
        prompt_session,
        width,
        monkeypatch,
        git_branch="feature/very-long-branch-name",
        git_status_result=(True, 3, 1),
        cwd="~/src/project/subdir",
    )

    assert len(lines) == 3, f"expected 3 lines at width={width}, got {len(lines)}"
    assert _display_width(lines[1]) <= width, (
        f"info line overflows at width={width}: {_display_width(lines[1])}"
    )
    assert _display_width(lines[2]) <= width, (
        f"toast/context line overflows at width={width}: {_display_width(lines[2])}"
    )


def test_bottom_toolbar_shows_bash_and_agent_badges_together(monkeypatch: Any) -> None:
    prompt_session = _make_toolbar_session(tips=[])
    prompt_session._background_task_count_provider = lambda: BgTaskCounts(bash=3, agent=1)

    lines = _render_toolbar_lines(prompt_session, 120, monkeypatch)

    assert "⚙ bash: 3" in lines[1], f"bash badge missing: {lines[1]!r}"
    assert "⚙ agent: 1" in lines[1], f"agent badge missing: {lines[1]!r}"
    assert lines[1].index("⚙ bash: 3") < lines[1].index("⚙ agent: 1"), (
        f"bash badge must come before agent badge: {lines[1]!r}"
    )


def test_bottom_toolbar_shows_agent_badge_alone_when_no_bash(monkeypatch: Any) -> None:
    prompt_session = _make_toolbar_session(tips=[])
    prompt_session._background_task_count_provider = lambda: BgTaskCounts(bash=0, agent=2)

    lines = _render_toolbar_lines(prompt_session, 120, monkeypatch)

    assert "⚙ bash" not in lines[1], f"bash badge must not appear when count is 0: {lines[1]!r}"
    assert "⚙ agent: 2" in lines[1], f"agent badge missing: {lines[1]!r}"


def test_bottom_toolbar_drops_agent_badge_before_bash_when_narrow(monkeypatch: Any) -> None:
    # With only ~width budget for one badge after CWD/mode, keeping bash and
    # dropping agent is the documented priority.
    prompt_session = _make_toolbar_session(tips=[])
    prompt_session._background_task_count_provider = lambda: BgTaskCounts(bash=5, agent=5)

    lines = _render_toolbar_lines(prompt_session, 40, monkeypatch)

    # Must never overflow and the bash badge is preferred over the agent badge.
    assert _display_width(lines[1]) <= 40
    if "⚙ agent" in lines[1]:
        # Only acceptable if bash also fit — otherwise priority is violated.
        assert "⚙ bash" in lines[1], (
            f"agent badge appeared without bash badge at narrow width: {lines[1]!r}"
        )


def test_mode_shows_full_with_model_name_on_wide_terminal(monkeypatch: Any) -> None:
    """On a wide terminal the full mode string (with model name and thinking dot) is shown."""
    session = _make_toolbar_session(model_name="fast-model")
    session._thinking = False
    lines = _render_toolbar_lines(session, 80, monkeypatch)
    assert "fast-model" in lines[1], f"model name missing on wide terminal: {lines[1]!r}"
    assert "○" in lines[1], f"thinking dot missing on wide terminal: {lines[1]!r}"


def test_mode_drops_model_name_on_narrow_terminal(monkeypatch: Any) -> None:
    """On a terminal too narrow for the full mode string, model name is dropped but
    the thinking dot is still shown."""
    # "agent (a-very-long-model-name-that-is-40-chars ○)" is ~50 cols;
    # a 30-col terminal forces mid-level degradation.
    long_model = "a-very-long-model-name-that-is-40-chars"
    session = _make_toolbar_session(model_name=long_model)
    session._thinking = True
    lines = _render_toolbar_lines(session, 30, monkeypatch)
    assert long_model not in lines[1], (
        f"model name should be dropped on 30-col terminal: {lines[1]!r}"
    )
    assert "●" in lines[1], f"thinking dot should still appear at mid level: {lines[1]!r}"
    assert _display_width(lines[1]) <= 30


def test_mode_drops_model_name_and_dot_on_very_narrow_terminal(monkeypatch: Any) -> None:
    """On a terminal too narrow even for 'agent ○', only the bare mode name is shown."""
    # Force remaining to be tiny by using a very short model name but very narrow width.
    # "agent ○" = 8 cols; needs 10 cols with spacing. Use width=8 to force bare mode.
    session = _make_toolbar_session(model_name="m")
    session._thinking = False
    lines = _render_toolbar_lines(session, 8, monkeypatch)
    assert "m" not in lines[1] or lines[1].startswith("agent"), (
        f"bare mode expected on 8-col terminal: {lines[1]!r}"
    )
    assert _display_width(lines[1]) <= 8


# ── Line 2 structural correctness ─────────────────────────────────────────────


def test_toolbar_line2_context_appears_on_line2_not_line1(monkeypatch: Any) -> None:
    prompt_session = _make_toolbar_session(tips=[])
    lines = _render_toolbar_lines(prompt_session, 80, monkeypatch)

    assert "context: 0.0%" in lines[2]
    assert "context: 0.0%" not in lines[1]


def test_toolbar_line2_left_toast_appears_on_line2_not_line1(monkeypatch: Any) -> None:
    prompt_session = _make_toolbar_session(tips=[])

    lines = _render_toolbar_lines(
        prompt_session,
        80,
        monkeypatch,
        before_render=lambda: toast("mcp servers connected", topic="mcp", duration=10.0),
    )

    assert len(lines) == 3
    assert "mcp servers connected" in lines[2]
    assert "mcp servers connected" not in lines[1]


def test_toolbar_line2_long_left_toast_truncated_to_fit(monkeypatch: Any) -> None:
    width = 60
    prompt_session = _make_toolbar_session(tips=[])

    lines = _render_toolbar_lines(
        prompt_session,
        width,
        monkeypatch,
        before_render=lambda: toast("x" * 200, duration=10.0),
    )

    assert _display_width(lines[2]) <= width


def test_toolbar_line2_right_toast_replaces_context(monkeypatch: Any) -> None:
    prompt_session = _make_toolbar_session(tips=[])

    lines = _render_toolbar_lines(
        prompt_session,
        80,
        monkeypatch,
        before_render=lambda: toast("mcp connected", topic="mcp", duration=10.0, position="right"),
    )

    assert "mcp connected" in lines[2]
    assert "context:" not in lines[2]


# ── Fix #4 regression: branch change invalidates in-flight status subprocess ──


def test_git_branch_change_terminates_in_flight_status_proc(monkeypatch: Any) -> None:
    """Regression: switching branches must discard any in-flight status subprocess
    so stale results from the old branch are never applied to the new branch."""
    mock_branch_proc = MagicMock()
    mock_branch_proc.poll.return_value = 0  # process completed
    mock_branch_proc.communicate.return_value = ("feature-branch\n", "")

    mock_status_proc = MagicMock()

    # Simulate: branch proc has a result ready; status proc is still in-flight.
    monkeypatch.setattr(_git_branch_state, "branch", "main")
    monkeypatch.setattr(_git_branch_state, "proc", mock_branch_proc)
    monkeypatch.setattr(_git_branch_state, "timestamp", float("inf"))  # TTL fresh, won't re-launch
    monkeypatch.setattr(_git_status_state, "proc", mock_status_proc)
    monkeypatch.setattr(_git_status_state, "timestamp", float("inf"))  # TTL fresh

    _get_git_branch()

    mock_status_proc.terminate.assert_called_once()
    assert _git_status_state.proc is None
    assert _git_status_state.timestamp == 0.0
    assert _git_branch_state.branch == "feature-branch"


def test_git_status_stuck_subprocess_terminated_after_ttl(monkeypatch: Any) -> None:
    """Regression: a subprocess that never exits (pipe buffer deadlock) must be
    terminated after TTL to prevent the toolbar from being permanently frozen."""
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None  # subprocess never finishes (deadlocked)

    spawn_time = time.monotonic() - _GIT_STATUS_TTL - 1.0  # spawned > TTL ago
    monkeypatch.setattr(_git_status_state, "proc", mock_proc)
    monkeypatch.setattr(_git_status_state, "timestamp", spawn_time)
    monkeypatch.setattr(_git_status_state, "dirty", True)  # stale value preserved

    result = _get_git_status()

    # Must have been terminated
    mock_proc.terminate.assert_called_once()
    assert _git_status_state.proc is None
    # timestamp reset to ~now so next spawn is delayed by one full TTL
    assert time.monotonic() - _git_status_state.timestamp < 2.0
    # Stale cached values are still returned (better than crashing)
    assert result == (True, 0, 0)


def test_git_status_recent_subprocess_not_terminated(monkeypatch: Any) -> None:
    """A subprocess that is still within TTL must not be terminated prematurely."""
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None  # not finished yet but within TTL

    monkeypatch.setattr(_git_status_state, "proc", mock_proc)
    monkeypatch.setattr(_git_status_state, "timestamp", time.monotonic() - 1.0)  # only 1s old

    _get_git_status()

    mock_proc.terminate.assert_not_called()
    assert _git_status_state.proc is mock_proc  # unchanged


def test_git_status_not_called_when_branch_is_none(monkeypatch: Any) -> None:
    """When not in a git repo (branch=None), _get_git_status must not be called.

    Avoids spawning a subprocess that will immediately fail in non-git directories.
    """
    status_call_count = 0

    def _fake_status() -> tuple[bool, int, int]:
        nonlocal status_call_count
        status_call_count += 1
        return (False, 0, 0)

    class _DummyOutput:
        @staticmethod
        def get_size() -> Any:
            return SimpleNamespace(columns=80)

    monkeypatch.setattr(
        shell_prompt, "get_app_or_none", lambda: SimpleNamespace(output=_DummyOutput())
    )
    monkeypatch.setattr(shell_prompt, "_get_git_branch", lambda: None)
    monkeypatch.setattr(shell_prompt, "_get_git_status", _fake_status)
    monkeypatch.setattr(shell_prompt, "_shorten_cwd", lambda _: "~/proj")
    _toast_queues["left"].clear()
    _toast_queues["right"].clear()

    prompt_session = _make_toolbar_session()
    prompt_session._render_bottom_toolbar()

    assert status_call_count == 0, "_get_git_status must not be called when branch is None"


# ── Prompt layout (separator, running/idle message) ───────────────────────────


def test_running_prompt_uses_shared_toolbar_and_separator_layout(monkeypatch: Any) -> None:
    width = 72
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._model_name = None
    prompt_session._running_prompt_delegate = _DummyRunningPrompt()
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._background_task_count_provider = None
    prompt_session._thinking = False
    prompt_session._tips = ["tip"]
    prompt_session._tip_rotation_index = 0
    prompt_session._last_tip_rotate_time = float("inf")  # prevent time-based rotation

    class _DummyOutput:
        @staticmethod
        def get_size() -> Any:
            return SimpleNamespace(columns=width)

    monkeypatch.setattr(
        shell_prompt, "get_app_or_none", lambda: SimpleNamespace(output=_DummyOutput())
    )
    monkeypatch.setattr(shell_prompt, "_get_git_branch", lambda: None)
    monkeypatch.setattr(shell_prompt, "_get_git_status", lambda: (False, 0, 0))
    monkeypatch.setattr(shell_prompt, "_shorten_cwd", lambda _: "~/proj")

    rendered_message = prompt_session._render_agent_prompt_message()
    plain_message = "".join(fragment[1] for fragment in rendered_message)
    assert plain_message.startswith(f"live view ({width})\n\n")
    # Input section header
    assert "── input " in plain_message

    _toast_queues["left"].clear()
    _toast_queues["right"].clear()
    rendered_toolbar = prompt_session._render_bottom_toolbar()
    plain_toolbar = "".join(fragment[1] for fragment in rendered_toolbar)
    assert "tip" in plain_toolbar
    assert "context: 0.0%" in plain_toolbar


def test_modal_prompt_hides_normal_separator_and_prompt_label(monkeypatch) -> None:
    width = 72
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._model_name = None
    prompt_session._running_prompt_delegate = _DummyRunningPrompt()
    prompt_session._modal_delegates = [_DummyRunningPrompt()]
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._thinking = False

    class _DummyOutput:
        @staticmethod
        def get_size():
            return SimpleNamespace(columns=width)

    dummy_app = SimpleNamespace(output=_DummyOutput())
    monkeypatch.setattr(shell_prompt, "get_app_or_none", lambda: dummy_app)

    rendered_message = prompt_session._render_agent_prompt_message()
    plain_message = "".join(fragment[1] for fragment in rendered_message)

    assert plain_message == f"live view ({width})\n"
    assert f"\n{'─' * width}\n" not in plain_message
    assert not plain_message.endswith(f"{PROMPT_SYMBOL} ")


def test_modal_prompt_hides_shell_prompt_label(monkeypatch) -> None:
    width = 72
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.SHELL
    prompt_session._model_name = None
    prompt_session._running_prompt_delegate = None
    prompt_session._modal_delegates = [_DummyRunningPrompt()]
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._thinking = False

    class _DummyOutput:
        @staticmethod
        def get_size():
            return SimpleNamespace(columns=width)

    dummy_app = SimpleNamespace(output=_DummyOutput())
    monkeypatch.setattr(shell_prompt, "get_app_or_none", lambda: dummy_app)

    rendered_message = prompt_session._render_shell_prompt_message()
    plain_message = "".join(fragment[1] for fragment in rendered_message)

    assert plain_message == f"live view ({width})\n"
    assert "$ " not in plain_message


def test_modal_prompt_hides_input_buffer_when_text_input_is_not_allowed() -> None:
    prompt_session = CustomPromptSession(
        status_provider=lambda: StatusSnapshot(context_usage=0.0),
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        agent_mode_slash_commands=[],
        shell_mode_slash_commands=[],
    )

    modal = _DummyReadOnlyModal()
    prompt_session.attach_modal(modal)

    assert prompt_session._prompt_buffer_container is not None
    assert prompt_session._should_render_input_buffer() is False


def test_modal_prompt_keeps_input_buffer_when_text_input_is_allowed() -> None:
    prompt_session = CustomPromptSession(
        status_provider=lambda: StatusSnapshot(context_usage=0.0),
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        agent_mode_slash_commands=[],
        shell_mode_slash_commands=[],
    )

    modal = _DummyRunningPrompt()
    prompt_session.attach_modal(modal)

    assert prompt_session._prompt_buffer_container is not None
    assert prompt_session._should_render_input_buffer() is True


def test_modal_prompt_suspends_and_restores_existing_draft_when_input_is_hidden() -> None:
    prompt_session = CustomPromptSession(
        status_provider=lambda: StatusSnapshot(context_usage=0.0),
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        agent_mode_slash_commands=[],
        shell_mode_slash_commands=[],
    )
    prompt_session._session.default_buffer.start_completion = lambda *args, **kwargs: None  # type: ignore[method-assign]
    prompt_session._session.default_buffer.validate_while_typing = lambda: False  # type: ignore[method-assign]
    prompt_session._session.default_buffer.document = shell_prompt.Document(
        text="keep this draft",
        cursor_position=len("keep this draft"),
    )

    modal = _DummyReadOnlyModal()
    prompt_session.attach_modal(modal)

    assert prompt_session._session.default_buffer.text == ""
    assert prompt_session._suspended_buffer_document is not None

    prompt_session.detach_modal(modal)

    assert prompt_session._session.default_buffer.text == "keep this draft"
    assert prompt_session._suspended_buffer_document is None


def test_idle_agent_prompt_uses_same_separator_layout(monkeypatch: Any) -> None:
    width = 64
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._running_prompt_delegate = None
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._thinking = False

    class _DummyOutput:
        @staticmethod
        def get_size() -> Any:
            return SimpleNamespace(columns=width)

    monkeypatch.setattr(
        shell_prompt, "get_app_or_none", lambda: SimpleNamespace(output=_DummyOutput())
    )

    rendered_message = prompt_session._render_agent_prompt_message()
    plain_message = "".join(fragment[1] for fragment in rendered_message)
    # Input section header
    assert "── input " in plain_message


# ── Session mode / erase_when_done behavior ───────────────────────────────────


def test_apply_mode_syncs_erase_when_done_with_current_mode() -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._session = cast(
        Any,
        SimpleNamespace(
            app=SimpleNamespace(erase_when_done=False),
            default_buffer=SimpleNamespace(completer=None),
        ),
    )
    prompt_session._agent_mode_completer = cast(Any, object())
    prompt_session._shell_mode_completer = cast(Any, object())
    prompt_session._mode = PromptMode.AGENT

    prompt_session._apply_mode()

    assert prompt_session._session.default_buffer.completer is prompt_session._agent_mode_completer
    assert prompt_session._session.app.erase_when_done is True

    prompt_session._mode = PromptMode.SHELL
    prompt_session._apply_mode()

    assert prompt_session._session.default_buffer.completer is prompt_session._shell_mode_completer
    assert prompt_session._session.app.erase_when_done is False


def test_attach_running_prompt_enables_erase_when_done_and_detach_restores_state() -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.SHELL
    prompt_session._running_prompt_delegate = None
    prompt_session._running_prompt_previous_mode = None
    prompt_session._session = cast(Any, SimpleNamespace(app=SimpleNamespace(erase_when_done=False)))

    delegate = _DummyRunningPrompt()
    trace: list[tuple[str, object, object, object]] = []

    def fake_apply_mode(event=None) -> None:
        prompt_session._session.app.erase_when_done = prompt_session._mode == PromptMode.AGENT
        trace.append(
            (
                "apply",
                prompt_session._mode,
                prompt_session._session.app.erase_when_done,
                prompt_session._running_prompt_delegate,
            )
        )

    def fake_invalidate() -> None:
        trace.append(
            (
                "invalidate",
                prompt_session._mode,
                prompt_session._session.app.erase_when_done,
                prompt_session._running_prompt_delegate,
            )
        )

    async def fake_prompt_once(*, append_history: bool) -> UserInput:
        trace.append(
            (
                "prompt",
                append_history,
                prompt_session._session.app.erase_when_done,
                prompt_session._running_prompt_delegate,
            )
        )
        return UserInput(mode=PromptMode.AGENT, command="hi", resolved_command="hi", content=[])

    prompt_session._apply_mode = fake_apply_mode
    prompt_session.invalidate = fake_invalidate

    prompt_session.attach_running_prompt(delegate)

    assert prompt_session._mode == PromptMode.AGENT
    assert prompt_session._running_prompt_delegate is delegate
    assert prompt_session._session.app.erase_when_done is True

    prompt_session.detach_running_prompt(delegate)

    assert prompt_session._mode == PromptMode.SHELL
    assert prompt_session._running_prompt_delegate is None
    assert prompt_session._session.app.erase_when_done is False
    assert [entry[0] for entry in trace] == ["apply", "invalidate", "apply", "invalidate"]


# ── Prompt async contract ─────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("running_prompt", [_DummyRunningPrompt(), None])
async def test_prompt_once_uses_prompt_delegate_placeholder_contract(running_prompt: Any) -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._running_prompt_delegate = running_prompt
    prompt_session._tip_rotation_index = 0

    captured: list[object | None] = []

    class _DummySession:
        async def prompt_async(self, **kwargs: Any) -> str:
            captured.append(kwargs.get("placeholder"))
            return "hello"

    prompt_session._session = cast(Any, _DummySession())
    prompt_session._build_user_input = lambda command: UserInput(
        mode=PromptMode.AGENT,
        command=command,
        resolved_command=command,
        content=[],
    )

    result = await prompt_session._prompt_once(append_history=False)

    assert result.command == "hello"
    assert captured == [None]


@pytest.mark.asyncio
async def test_prompt_next_skips_history_for_running_submission() -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._running_prompt_delegate = _DummyRunningPrompt()
    prompt_session._tip_rotation_index = 0
    prompt_session._append_history_entry = lambda text: (_ for _ in ()).throw(
        AssertionError("running submissions must not append history")
    )
    prompt_session._build_user_input = lambda command: UserInput(
        mode=PromptMode.AGENT,
        command=command,
        resolved_command=command,
        content=[],
    )

    class _DummySession:
        async def prompt_async(self, **kwargs: Any) -> str:
            return "follow-up"

    prompt_session._session = cast(Any, _DummySession())

    result = await prompt_session.prompt_next()

    assert result.command == "follow-up"
    assert prompt_session.last_submission_was_running is True


@pytest.mark.asyncio
async def test_prompt_next_does_not_mark_submission_as_running_when_delegate_releases_prompt() -> (
    None
):
    prompt_session = object.__new__(CustomPromptSession)

    class _FinishedRunningPrompt(_DummyRunningPrompt):
        def running_prompt_accepts_submission(self) -> bool:
            return False

    prompt_session._running_prompt_delegate = _FinishedRunningPrompt()
    prompt_session._tip_rotation_index = 0
    prompt_session._append_history_entry = lambda _text: None  # type: ignore[assignment]
    prompt_session._build_user_input = lambda command: UserInput(
        mode=PromptMode.AGENT,
        command=command,
        resolved_command=command,
        content=[],
    )

    class _DummySession:
        async def prompt_async(self, **kwargs):
            return "follow-up"

    prompt_session._session = cast(Any, _DummySession())

    result = await prompt_session.prompt_next()

    assert result.command == "follow-up"
    assert prompt_session.last_submission_was_running is False
