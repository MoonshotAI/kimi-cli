"""Tests for slash command completer behavior."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from types import SimpleNamespace

from prompt_toolkit.completion import CompleteEvent, Completion
from prompt_toolkit.document import Document
from prompt_toolkit.layout.containers import ConditionalContainer, FloatContainer, HSplit, Window
from prompt_toolkit.utils import get_cwidth

import kimi_cli.ui.shell.prompt as prompt_mod
from kimi_cli.ui.shell.prompt import (
    SlashCommandCompleter,
    SlashCommandMenuControl,
    _find_prompt_float_container,
    _wrap_to_width,
)
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.utils.slashcmd import SlashCommand


def _noop(app: object, args: str) -> None:
    pass


def _make_command(
    name: str, *, aliases: Iterable[str] = ()
) -> SlashCommand[Callable[[object, str], None]]:
    return SlashCommand(
        name=name,
        description=f"{name} command",
        func=_noop,
        aliases=list(aliases),
    )


def _completion_texts(completer: SlashCommandCompleter, text: str) -> list[str]:
    document = Document(text=text, cursor_position=len(text))
    event = CompleteEvent(completion_requested=True)
    return [completion.text for completion in completer.get_completions(document, event)]


def _completions(completer: SlashCommandCompleter, text: str):
    document = Document(text=text, cursor_position=len(text))
    event = CompleteEvent(completion_requested=True)
    return list(completer.get_completions(document, event))


def test_exact_command_match_hides_completions():
    """Exact matches should not show completions."""
    completer = SlashCommandCompleter(
        [
            _make_command("mcp"),
            _make_command("mcp-server"),
            _make_command("help", aliases=["h"]),
        ]
    )

    texts = _completion_texts(completer, "/mcp")

    assert not texts


def test_exact_alias_match_hides_completions():
    """Exact alias matches should not show completions."""
    completer = SlashCommandCompleter(
        [
            _make_command("help", aliases=["h"]),
            _make_command("history"),
        ]
    )

    texts = _completion_texts(completer, "/h")

    assert not texts


def test_should_complete_only_for_root_slash_token():
    assert SlashCommandCompleter.should_complete(Document(text="/", cursor_position=1))
    assert SlashCommandCompleter.should_complete(Document(text="  /he", cursor_position=5))
    assert not SlashCommandCompleter.should_complete(Document(text="test /he", cursor_position=8))
    assert not SlashCommandCompleter.should_complete(Document(text="@src", cursor_position=4))
    assert not SlashCommandCompleter.should_complete(Document(text="/he next", cursor_position=8))


def test_completion_display_uses_canonical_command_name():
    completer = SlashCommandCompleter(
        [
            _make_command("help", aliases=["h", "?"]),
            _make_command("history"),
        ]
    )

    completions = _completions(completer, "/he")

    assert len(completions) == 1
    assert completions[0].text == "/help"
    assert completions[0].display_text == "/help"
    assert completions[0].display_meta_text == "help command"


def test_skill_completion_path_still_returns_registered_skill_command():
    completer = SlashCommandCompleter(
        [
            _make_command("skill:demo"),
            _make_command("help"),
        ]
    )

    assert _completion_texts(completer, "/skill:de") == ["/skill:demo"]
    assert _completion_texts(completer, "/skill:demo") == []


def test_flow_completion_path_still_returns_registered_flow_command():
    completer = SlashCommandCompleter(
        [
            _make_command("flow:demo"),
            _make_command("help"),
        ]
    )

    assert _completion_texts(completer, "/flow:de") == ["/flow:demo"]
    assert _completion_texts(completer, "/flow:demo") == []


def test_btw_is_available_in_agent_slash_completion_menu():
    completer = SlashCommandCompleter(shell_slash_registry.list_commands())

    assert "/btw" in _completion_texts(completer, "/bt")


def test_wrap_to_width_respects_width():
    lines = _wrap_to_width(
        "Help address review issue comments on the open GitHub PR",
        18,
    )

    assert len(lines) > 1
    assert all(get_cwidth(line) <= 18 for line in lines)


def test_wrap_to_width_respects_max_lines():
    lines = _wrap_to_width(
        "Help address review issue comments on the open GitHub PR for the current branch",
        20,
        max_lines=2,
    )

    assert len(lines) == 2
    assert all(get_cwidth(line) <= 20 for line in lines)
    assert lines[-1].endswith("...")


def test_slash_menu_preserves_unselected_state(monkeypatch):
    completions = [
        Completion(
            text="/editor",
            start_position=0,
            display="/editor",
            display_meta="Set default external editor for Ctrl-O",
        ),
        Completion(
            text="/exit",
            start_position=0,
            display="/exit",
            display_meta="Exit the application",
        ),
    ]
    complete_state = SimpleNamespace(completions=completions, complete_index=None)
    app = SimpleNamespace(current_buffer=SimpleNamespace(complete_state=complete_state))
    monkeypatch.setattr(prompt_mod, "get_app_or_none", lambda: app)

    control = SlashCommandMenuControl(left_padding=lambda: 0)
    content = control.create_content(width=80, height=6)

    rendered_lines = [
        "".join(fragment[1] for fragment in content.get_line(i)) for i in range(content.line_count)
    ]

    assert content.line_count == 1 + len(completions)
    assert content.cursor_position.y == 0
    assert "›" not in rendered_lines[1]
    assert "›" not in rendered_lines[2]
    assert "Ctrl-O" in rendered_lines[1]
    assert rendered_lines[1].count("/editor") == 1


def test_find_prompt_float_container_supports_conditional_container_shape():
    float_container = FloatContainer(content=Window(), floats=[])
    root = HSplit(
        [
            ConditionalContainer(
                content=Window(),
                filter=True,
                alternative_content=float_container,
            )
        ]
    )

    assert _find_prompt_float_container(root) is float_container


def test_find_prompt_float_container_supports_direct_float_container_shape():
    float_container = FloatContainer(content=Window(), floats=[])
    root = HSplit([float_container])

    assert _find_prompt_float_container(root) is float_container
