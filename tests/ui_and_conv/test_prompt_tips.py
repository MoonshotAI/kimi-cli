from types import SimpleNamespace

from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell import prompt as shell_prompt
from kimi_cli.ui.shell.prompt import (
    CustomPromptSession,
    PromptMode,
    _build_toolbar_tips,
    _toast_queues,
)


def test_build_toolbar_tips_without_clipboard():
    assert _build_toolbar_tips(clipboard_available=False) == [
        "ctrl-x: toggle mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "@: mention files",
    ]


def test_build_toolbar_tips_with_clipboard():
    assert _build_toolbar_tips(clipboard_available=True) == [
        "ctrl-x: toggle mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "ctrl-v: paste image",
        "@: mention files",
    ]


def test_bottom_toolbar_no_overflow_when_tip_would_exactly_fill_old_available(monkeypatch) -> None:
    width = 60
    mode_text = "agent"
    right_text = CustomPromptSession._render_right_span(StatusSnapshot(context_usage=0.0))
    tip_len = width - len(mode_text) - len(right_text) - 4

    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._model_name = None
    prompt_session._thinking = False
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._tips = ["t" * tip_len]
    prompt_session._tip_rotation_index = 0

    class _DummyOutput:
        @staticmethod
        def get_size():
            return SimpleNamespace(columns=width)

    dummy_app = SimpleNamespace(output=_DummyOutput())
    monkeypatch.setattr(shell_prompt, "get_app_or_none", lambda: dummy_app)
    _toast_queues["left"].clear()
    _toast_queues["right"].clear()

    rendered = prompt_session._render_bottom_toolbar()
    plain = "".join(fragment[1] for fragment in rendered)
    second_line = plain.split("\n", 1)[1]

    assert len(second_line) <= width
