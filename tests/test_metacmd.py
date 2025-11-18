"""Tests for meta command functionality using inline-snapshot."""

from __future__ import annotations

from typing import Any

import pytest
from inline_snapshot import snapshot

from kimi_cli.ui.shell.metacmd import _meta_command_aliases, _meta_commands, meta_command


def check_meta_commands(snapshot: Any):
    """Usage: check_meta_commands(snapshot()), then `uv run pytest` will update the snapshot."""

    import json

    pretty_meta_commands = json.dumps(
        {
            alias: f"{cmd.slash_name()}: {cmd.description}"
            for (alias, cmd) in _meta_command_aliases.items()
        },
        indent=2,
        sort_keys=True,
    )
    assert pretty_meta_commands == snapshot


@pytest.fixture(autouse=True)
def clear_meta_commands():
    """Clear meta commands before and after each test."""
    original = _meta_commands.copy()
    original_aliases = _meta_command_aliases.copy()
    _meta_commands.clear()
    _meta_command_aliases.clear()
    yield
    _meta_commands.clear()
    _meta_commands.update(original)
    _meta_command_aliases.clear()
    _meta_command_aliases.update(original_aliases)


def test_meta_command_registration():
    """Test all meta command registration scenarios."""

    # Basic registration
    @meta_command
    def basic(app, args):
        """Basic command."""
        pass

    # Custom name, original name should be ignored
    @meta_command(name="run")
    def start(app, args):
        """Run something."""
        pass

    # Aliases only, original name should be kept
    @meta_command(aliases=["h", "?"])
    def help(app, args):
        """Show help."""
        pass

    # Custom name with aliases
    @meta_command(name="search", aliases=["s", "find"])
    def query(app, args):
        """Search items."""
        pass

    # Edge cases: no doc, whitespace doc, duplicate aliases
    @meta_command
    def no_doc(app, args):
        pass

    @meta_command
    def whitespace_doc(app, args):
        """\n\t"""
        pass

    @meta_command(aliases=["dup", "dup"])
    def dedup_test(app, args):
        """Test deduplication."""
        pass

    check_meta_commands(
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
""")
    )


def test_meta_command_overwriting():
    """Test command overwriting behavior."""

    @meta_command
    def test_cmd(app, args):
        """First version."""
        pass

    check_meta_commands(
        snapshot("""\
{
  "test_cmd": "/test_cmd: First version."
}\
""")
    )

    @meta_command(name="test_cmd")
    def _test_cmd(app, args):  # Same name, different function
        """Second version."""
        pass

    check_meta_commands(
        snapshot("""\
{
  "test_cmd": "/test_cmd: Second version."
}\
""")
    )
