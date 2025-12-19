"""Tests for slash command functionality using inline-snapshot."""

from __future__ import annotations

from typing import Any

import pytest
from inline_snapshot import snapshot

from kimi_cli.utils.slashcmd import (
    SlashCommand,
    SlashCommandCall,
    SlashCommandRegistry,
    parse_slash_command_call,
)


def check_slash_commands(registry: SlashCommandRegistry[Any], snapshot: Any):
    """Check slash commands match snapshot."""
    import json

    # Use the public list_commands() API and build the alias mapping
    alias_to_cmd: dict[str, SlashCommand[Any]] = {}
    for cmd in registry.list_commands():
        alias_to_cmd[cmd.name] = cmd
        for alias in cmd.aliases:
            alias_to_cmd[alias] = cmd

    pretty_commands = json.dumps(
        {
            alias: f"{cmd.slash_name()}: {cmd.description}"
            for (alias, cmd) in sorted(alias_to_cmd.items())
        },
        indent=2,
        sort_keys=True,
    )
    assert pretty_commands == snapshot


def test_parse_slash_command_call():
    """Test parsing slash command calls, focusing on edge cases."""

    # Regular cases should work
    result = parse_slash_command_call("/help")
    assert result == snapshot(SlashCommandCall(name="help", args=[], raw_input="/help"))

    result = parse_slash_command_call("/search query")
    assert result == snapshot(
        SlashCommandCall(name="search", args=["query"], raw_input="/search query")
    )

    # Edge cases: double slash
    assert parse_slash_command_call("//comment") is None
    assert parse_slash_command_call("//") is None

    # Edge cases: /* and # comments
    assert parse_slash_command_call("/* comment */") is None
    assert parse_slash_command_call("# comment") is None
    assert parse_slash_command_call("#!/bin/bash") is None

    # Edge cases: Chinese characters in args (should work)
    result = parse_slash_command_call("/echo 你好世界")
    assert result == snapshot(
        SlashCommandCall(name="echo", args=["你好世界"], raw_input="/echo 你好世界")
    )

    result = parse_slash_command_call("/search 中文查询 english query")
    assert result == snapshot(
        SlashCommandCall(
            name="search",
            args=["中文查询", "english", "query"],
            raw_input="/search 中文查询 english query",
        )
    )

    # Chinese characters in command name should fail (regex only allows a-zA-Z0-9_-)
    assert parse_slash_command_call("/测试命令 参数") is None
    assert parse_slash_command_call("/命令") is None

    # Invalid cases should return None
    assert parse_slash_command_call("") is None
    assert parse_slash_command_call("help") is None
    assert parse_slash_command_call("/") is None
    assert parse_slash_command_call("/.invalid") is None

    # Malformed input with quotes
    result = parse_slash_command_call('/cmd "unmatched quote')
    assert result is None

    result = parse_slash_command_call("/cmd '")
    assert result is None


@pytest.fixture
def test_registry() -> SlashCommandRegistry[Any]:
    """Create a clean test registry for each test."""
    return SlashCommandRegistry()


def test_slash_command_registration(test_registry: SlashCommandRegistry[Any]) -> None:
    """Test all slash command registration scenarios."""

    # Basic registration
    @test_registry.command  # noqa: F811
    def basic(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """Basic command."""
        pass

    # Custom name, original name should be ignored
    @test_registry.command(name="run")  # noqa: F811
    def start(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """Run something."""
        pass

    # Aliases only, original name should be kept
    @test_registry.command(aliases=["h", "?"])  # noqa: F811
    def help(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """Show help."""
        pass

    # Custom name with aliases
    @test_registry.command(name="search", aliases=["s", "find"])  # noqa: F811
    def query(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """Search items."""
        pass

    # Edge cases: no doc, whitespace doc, duplicate aliases
    @test_registry.command  # noqa: F811
    def no_doc(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        pass

    @test_registry.command  # noqa: F811
    def whitespace_doc(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """\n\t"""
        pass

    @test_registry.command(aliases=["dup", "dup"])  # noqa: F811
    def dedup_test(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """Test deduplication."""
        pass

    check_slash_commands(
        test_registry,
        snapshot("""\
{
  "?": "/help (h, ?): Show help.",
  "basic": "/basic: Basic command.",
  "dedup_test": "/dedup_test (dup, dup): Test deduplication.",
  "dup": "/dedup_test (dup, dup): Test deduplication.",
  "find": "/search (s, find): Search items.",
  "h": "/help (h, ?): Show help.",
  "help": "/help (h, ?): Show help.",
  "no_doc": "/no_doc: ",
  "run": "/run: Run something.",
  "s": "/search (s, find): Search items.",
  "search": "/search (s, find): Search items.",
  "whitespace_doc": "/whitespace_doc: "
}\
"""),
    )


def test_slash_command_overwriting(test_registry: SlashCommandRegistry[Any]) -> None:
    """Test command overwriting behavior."""

    @test_registry.command  # noqa: F811
    def test_cmd(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """First version."""
        pass

    check_slash_commands(
        test_registry,
        snapshot("""\
{
  "test_cmd": "/test_cmd: First version."
}\
"""),
    )

    @test_registry.command(name="test_cmd")  # noqa: F811
    def _test_cmd(app: object, args: list[str]) -> None:  # noqa: F811 # pyright: ignore[reportUnusedFunction]
        """Second version."""
        pass

    check_slash_commands(
        test_registry,
        snapshot("""\
{
  "test_cmd": "/test_cmd: Second version."
}\
"""),
    )
