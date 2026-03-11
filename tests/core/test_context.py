"""Tests for Context restore with malformed JSON lines (ENG-314)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from kimi_cli.soul.context import Context


async def test_context_restore_skips_malformed_and_recovers():
    """Context.restore() should skip lines that fail JSON parsing and continue with valid ones."""
    # A line with a literal newline inside a JSON string will be split across two file lines.
    # Both fragments are invalid JSON individually. The context should skip them
    # and continue parsing subsequent valid lines.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        # Valid usage line
        f.write(json.dumps({"role": "_usage", "token_count": 100}) + "\n")
        # Valid message line
        valid_msg = {
            "role": "user",
            "content": [{"type": "text", "text": "hello"}],
        }
        f.write(json.dumps(valid_msg) + "\n")
        # Poisoned line: literal newline splits it across two file lines
        # Both fragments will fail json.loads and should be skipped
        f.write('{"role": "assistant", "content": [{"type": "text", "text": "bad\nline"}]}\n')
        # Valid usage line after poisoned data
        f.write(json.dumps({"role": "_usage", "token_count": 200}) + "\n")
        tmpfile = f.name

    context = Context(file_backend=Path(tmpfile))
    restored = await context.restore()

    assert restored is True
    # The valid "user" message should be in history
    assert len(context.history) >= 1
    assert context.history[0].role == "user"
    # Token count should reflect the last valid _usage line
    assert context.token_count == 200


async def test_context_restore_handles_completely_broken_lines():
    """Context.restore() should skip completely broken JSON without crashing."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"role": "_usage", "token_count": 50}) + "\n")
        f.write("completely broken json{{{not valid\n")
        valid_msg = {
            "role": "user",
            "content": [{"type": "text", "text": "after broken"}],
        }
        f.write(json.dumps(valid_msg) + "\n")
        tmpfile = f.name

    context = Context(file_backend=Path(tmpfile))
    restored = await context.restore()

    assert restored is True
    assert len(context.history) == 1
    assert context.history[0].role == "user"
