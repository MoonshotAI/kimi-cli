"""Tests for slash command completer behavior."""

from __future__ import annotations

from collections.abc import Callable, Iterable

from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document

from kimi_cli.ui.shell.prompt import SlashCommandCompleter
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
