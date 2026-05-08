"""Tests for Context.token_count_with_pending — the pending token estimate mechanism.

The pending estimate tracks tokens from messages appended after the last
``update_token_count`` call.  It is used solely for deciding whether to trigger
auto-compaction and is never persisted to disk.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from kosong.message import Message, Role

from kimi_cli.soul.compaction import estimate_text_tokens, should_auto_compact
from kimi_cli.soul.context import Context
from kimi_cli.wire.types import TextPart


def _msg(role: Role, text: str) -> Message:
    return Message(role=role, content=[TextPart(text=text)])


def _write_lines(path: Path, lines: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(line) + "\n" for line in lines),
        encoding="utf-8",
    )


def _message_dict(role: Role, text: str) -> dict:
    return json.loads(
        Message(role=role, content=[TextPart(text=text)]).model_dump_json(exclude_none=True)
    )


# --- Basic pending accumulation ---


@pytest.mark.asyncio
async def test_append_message_accumulates_pending(tmp_path: Path) -> None:
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    msg = _msg("user", "a" * 400)  # 400 chars → 100 estimated tokens
    await ctx.append_message(msg)

    assert ctx.token_count == 0  # no API call yet
    assert ctx.token_count_with_pending == estimate_text_tokens([msg])


@pytest.mark.asyncio
async def test_multiple_appends_accumulate(tmp_path: Path) -> None:
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    msg1 = _msg("user", "a" * 200)
    msg2 = _msg("assistant", "b" * 300)
    await ctx.append_message(msg1)
    await ctx.append_message(msg2)

    expected = estimate_text_tokens([msg1]) + estimate_text_tokens([msg2])
    assert ctx.token_count_with_pending == expected


@pytest.mark.asyncio
async def test_append_message_batch(tmp_path: Path) -> None:
    """append_message with a list of messages accumulates all at once."""
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    msgs = [_msg("user", "x" * 100), _msg("assistant", "y" * 200)]
    await ctx.append_message(msgs)

    assert ctx.token_count_with_pending == estimate_text_tokens(msgs)


# --- Reset on update_token_count ---


@pytest.mark.asyncio
async def test_update_token_count_resets_pending(tmp_path: Path) -> None:
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    await ctx.append_message(_msg("user", "a" * 400))
    assert ctx.token_count_with_pending > 0

    await ctx.update_token_count(5000)

    assert ctx.token_count == 5000
    assert ctx.token_count_with_pending == 5000  # pending is 0


@pytest.mark.asyncio
async def test_pending_only_tracks_post_update_messages(tmp_path: Path) -> None:
    """After update_token_count, only newly appended messages contribute to pending."""
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    await ctx.append_message(_msg("user", "a" * 400))
    await ctx.update_token_count(10000)  # API returned precise count → resets pending

    new_msg = _msg("tool", "b" * 800)  # 800 chars → 200 estimated tokens
    await ctx.append_message(new_msg)

    assert ctx.token_count == 10000
    assert ctx.token_count_with_pending == 10000 + estimate_text_tokens([new_msg])


# --- Reset on clear ---


@pytest.mark.asyncio
async def test_clear_resets_pending(tmp_path: Path) -> None:
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    await ctx.append_message(_msg("user", "a" * 400))
    assert ctx.token_count_with_pending > 0

    await ctx.clear()

    assert ctx.token_count == 0
    assert ctx.token_count_with_pending == 0


# --- Reset on revert_to ---


@pytest.mark.asyncio
async def test_revert_to_resets_runtime_pending(tmp_path: Path) -> None:
    """Pending accumulated during the current process is discarded on revert."""
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "before checkpoint"),
            {"role": "_usage", "token_count": 1000},
            {"role": "_checkpoint", "id": 0},
            _message_dict("assistant", "after checkpoint"),
            {"role": "_checkpoint", "id": 1},
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()

    # Simulate appending more messages (would happen during a step)
    await ctx.append_message(_msg("user", "extra message " * 50))
    assert ctx.token_count_with_pending > ctx.token_count

    await ctx.revert_to(1)

    # After revert: "assistant" message is after _usage, so pending should account for it
    expected_pending = estimate_text_tokens([_msg("assistant", "after checkpoint")])
    assert ctx.token_count == 1000
    assert ctx.token_count_with_pending == 1000 + expected_pending


@pytest.mark.asyncio
async def test_revert_to_rebuilds_pending_from_messages_after_usage(tmp_path: Path) -> None:
    """revert_to() must rebuild pending for messages between the last _usage and the checkpoint."""
    tool_text = "x" * 4000  # ~1000 estimated tokens
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "question"),
            {"role": "_usage", "token_count": 5000},
            _message_dict("assistant", "let me check"),
            _message_dict("tool", tool_text),
            {"role": "_checkpoint", "id": 0},
            _message_dict("user", "follow up"),
            {"role": "_checkpoint", "id": 1},
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()
    await ctx.revert_to(1)

    # After revert to checkpoint 1: assistant, tool, and "follow up" are all after _usage
    expected_pending = estimate_text_tokens(
        [
            _msg("assistant", "let me check"),
            _msg("tool", tool_text),
            _msg("user", "follow up"),
        ]
    )
    assert ctx.token_count == 5000
    assert ctx.token_count_with_pending == 5000 + expected_pending


@pytest.mark.asyncio
async def test_revert_to_no_pending_when_usage_is_last(tmp_path: Path) -> None:
    """If the last record before the checkpoint is a _usage, pending should be 0."""
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "question"),
            _message_dict("assistant", "answer"),
            {"role": "_usage", "token_count": 3000},
            {"role": "_checkpoint", "id": 0},
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()
    await ctx.revert_to(0)

    assert ctx.token_count == 3000
    assert ctx.token_count_with_pending == 3000  # no pending


# --- Restore rebuilds pending for messages after last _usage ---


@pytest.mark.asyncio
async def test_restore_no_pending_when_usage_is_last(tmp_path: Path) -> None:
    """When the last record is a _usage, pending should be 0."""
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "hello"),
            _message_dict("assistant", "world"),
            {"role": "_usage", "token_count": 500},
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()

    assert ctx.token_count == 500
    assert ctx.token_count_with_pending == 500


@pytest.mark.asyncio
async def test_restore_rebuilds_pending_for_messages_after_usage(tmp_path: Path) -> None:
    """Messages after the last _usage should be counted as pending on restore."""
    tool_text = "y" * 8000  # ~2000 estimated tokens
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "hello"),
            {"role": "_usage", "token_count": 10000},
            _message_dict("assistant", "let me read that file"),
            _message_dict("tool", tool_text),
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()

    expected_pending = estimate_text_tokens(
        [
            _msg("assistant", "let me read that file"),
            _msg("tool", tool_text),
        ]
    )
    assert ctx.token_count == 10000
    assert ctx.token_count_with_pending == 10000 + expected_pending
    assert expected_pending > 0


@pytest.mark.asyncio
async def test_restore_pending_uses_last_usage_only(tmp_path: Path) -> None:
    """Only messages after the *last* _usage contribute to pending, not earlier ones."""
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "first question"),
            {"role": "_usage", "token_count": 1000},
            _message_dict("assistant", "first answer"),
            _message_dict("tool", "a" * 4000),
            {"role": "_usage", "token_count": 5000},  # second usage covers assistant+tool
            _message_dict("assistant", "second answer"),  # only this is after last usage
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()

    # Only "second answer" is after the last _usage
    expected_pending = estimate_text_tokens([_msg("assistant", "second answer")])
    assert ctx.token_count == 5000
    assert ctx.token_count_with_pending == 5000 + expected_pending


@pytest.mark.asyncio
async def test_restore_no_usage_records_all_messages_pending(tmp_path: Path) -> None:
    """If there are no _usage records, all messages should be pending."""
    path = tmp_path / "ctx.jsonl"
    _write_lines(
        path,
        [
            _message_dict("user", "hello"),
            _message_dict("assistant", "world"),
        ],
    )

    ctx = Context(file_backend=path)
    await ctx.restore()

    expected_pending = estimate_text_tokens(
        [
            _msg("user", "hello"),
            _msg("assistant", "world"),
        ]
    )
    assert ctx.token_count == 0
    assert ctx.token_count_with_pending == expected_pending


# --- Simulates the real _grow_context → should_auto_compact cycle ---


@pytest.mark.asyncio
async def test_grow_context_cycle(tmp_path: Path) -> None:
    """Simulate the real cycle:
    1. update_token_count(usage.total) — after API returns
    2. append tool result messages — large, unaccounted by API
    3. should_auto_compact uses token_count_with_pending
    """
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    max_context = 1_000_000

    # Step 1: API returned, total tokens = 840K (below 85% of 1M = 850K)
    await ctx.update_token_count(840_000)

    # Step 2: Large tool results appended (e.g. file content)
    tool_msg = _msg("tool", "x" * 60_000)  # ~15K estimated tokens
    await ctx.append_message(tool_msg)

    # Without pending: 840K < 850K → no compaction (BUG: actual is ~855K)
    assert not should_auto_compact(
        ctx.token_count, max_context, trigger_ratio=0.85, reserved_context_size=50_000
    )

    # With pending: 840K + 15K = 855K ≥ 850K → triggers compaction (FIXED)
    assert should_auto_compact(
        ctx.token_count_with_pending, max_context, trigger_ratio=0.85, reserved_context_size=50_000
    )


@pytest.mark.asyncio
async def test_reserved_threshold_with_pending(tmp_path: Path) -> None:
    """Pending tokens can also push past the reserved-based threshold."""
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    max_context = 200_000

    # token_count alone: 140K + 50K reserved = 190K < 200K → no trigger
    await ctx.update_token_count(140_000)
    assert not should_auto_compact(
        ctx.token_count, max_context, trigger_ratio=0.85, reserved_context_size=50_000
    )

    # Append 10K+ estimated tokens of tool output → pushes past reserved threshold
    tool_msg = _msg("tool", "y" * 44_000)  # ~11K estimated tokens
    await ctx.append_message(tool_msg)

    # 140K + 11K + 50K = 201K ≥ 200K → triggers
    assert should_auto_compact(
        ctx.token_count_with_pending, max_context, trigger_ratio=0.85, reserved_context_size=50_000
    )


# --- Pending is not persisted ---


@pytest.mark.asyncio
async def test_pending_rebuilt_on_restore(tmp_path: Path) -> None:
    """A fresh Context from the same file rebuilds pending from messages after the last _usage."""
    path = tmp_path / "ctx.jsonl"
    path.touch()

    tool_msg = _msg("tool", "b" * 800)

    ctx1 = Context(file_backend=path)
    await ctx1.append_message(_msg("user", "a" * 400))
    await ctx1.update_token_count(1000)
    await ctx1.append_message(tool_msg)
    assert ctx1.token_count_with_pending > 1000

    # Load from same file — pending is rebuilt for messages after _usage
    ctx2 = Context(file_backend=path)
    await ctx2.restore()
    assert ctx2.token_count == 1000
    expected_pending = estimate_text_tokens([tool_msg])
    assert ctx2.token_count_with_pending == 1000 + expected_pending


# --- Multiple update cycles ---


@pytest.mark.asyncio
async def test_multiple_update_cycles(tmp_path: Path) -> None:
    """Simulate multiple step cycles to verify pending resets correctly each time."""
    ctx = Context(file_backend=tmp_path / "ctx.jsonl")
    (tmp_path / "ctx.jsonl").touch()

    # Cycle 1: API returns → append tools → pending accumulates
    await ctx.update_token_count(50_000)
    tool_msg1 = _msg("tool", "a" * 2000)
    await ctx.append_message(tool_msg1)
    assert ctx.token_count_with_pending == 50_000 + estimate_text_tokens([tool_msg1])

    # Cycle 2: Next API call → resets pending, new precise count
    await ctx.update_token_count(55_000)
    assert ctx.token_count_with_pending == 55_000  # pending reset

    # Append more tool results
    tool_msg2 = _msg("tool", "b" * 4000)
    await ctx.append_message(tool_msg2)
    assert ctx.token_count_with_pending == 55_000 + estimate_text_tokens([tool_msg2])

    # Cycle 3: Another API call
    await ctx.update_token_count(60_000)
    assert ctx.token_count_with_pending == 60_000  # pending reset again
