"""Tests for TPS (tokens-per-second) meter functionality in KimiSoul."""

import time
from collections import deque
from pathlib import Path

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul


class TestKimiSoulTPSTracking:
    def test_estimate_tokens_for_tps(self):
        """Token estimation uses correct heuristics for CJK and ASCII text."""
        # Empty string
        assert KimiSoul._estimate_tokens_for_tps("") == 0.0
        # ASCII: 40 chars / 4 = 10 tokens
        assert KimiSoul._estimate_tokens_for_tps("abcd" * 10) == pytest.approx(10.0, abs=0.1)
        # CJK: 40 chars * 1.5 = 60 tokens
        assert KimiSoul._estimate_tokens_for_tps("中文测试" * 10) == pytest.approx(60.0, abs=0.1)
        # Mixed: 20 CJK (30) + 20 ASCII (5) = 35
        assert KimiSoul._estimate_tokens_for_tps("中文测试" * 5 + "abcd" * 5) == pytest.approx(
            35.0, abs=0.1
        )

    def test_calculate_tps(self, runtime: Runtime, tmp_path: Path):
        """TPS calculation handles edge cases and normal flow."""
        soul = self._make_soul(runtime, tmp_path)
        now = time.monotonic()

        # Empty: need at least 2 timestamps
        assert soul._calculate_tps() == 0.0

        # Single timestamp: need delta
        soul._streaming_token_timestamps = deque([(now, 100.0)])
        assert soul._calculate_tps() == 0.0

        # Zero duration: same timestamp
        soul._streaming_token_timestamps = deque([(now, 0.0), (now, 100.0)])
        assert soul._calculate_tps() == 0.0

        # Normal: 300 tokens over 3 seconds = 100 tps
        soul._streaming_token_timestamps = deque(
            [
                (now + t, count)
                for t, count in [(0.0, 0.0), (1.0, 100.0), (2.0, 200.0), (3.0, 300.0)]
            ]
        )
        assert soul._calculate_tps() == pytest.approx(100.0, rel=0.01)

    def test_track_streaming_tokens_and_pruning(self, runtime: Runtime, tmp_path: Path):
        """Tracking accumulates tokens and prunes old entries."""
        soul = self._make_soul(runtime, tmp_path)
        now = time.monotonic()

        # Add entries: one old (outside 3s window), one recent
        soul._streaming_token_timestamps.append((now - 4.0, 0.0))
        soul._streaming_token_timestamps.append((now - 1.0, 100.0))
        soul._streaming_token_count = 100.0

        # Track new tokens - should trigger pruning of old entry
        soul._track_streaming_tokens(50.0)

        # Should have 2 entries (recent + new), old pruned
        assert len(soul._streaming_token_timestamps) == 2
        assert soul._streaming_token_timestamps[0][0] > now - 3.5
        assert soul._streaming_token_count == 150.0

    def test_reset_streaming_tps(self, runtime: Runtime, tmp_path: Path):
        """Reset clears timestamps and token count."""
        soul = self._make_soul(runtime, tmp_path)
        soul._streaming_token_timestamps = deque(
            [
                (time.monotonic(), 100.0),
                (time.monotonic(), 200.0),
            ]
        )
        soul._streaming_token_count = 200.0

        soul._reset_streaming_tps()

        assert len(soul._streaming_token_timestamps) == 0
        assert soul._streaming_token_count == 0.0

    def test_status_tps(self, runtime: Runtime, tmp_path: Path):
        """Status snapshot includes TPS when streaming, zero otherwise."""
        soul = self._make_soul(runtime, tmp_path)

        # Not streaming: TPS should be 0.0
        status = soul.status
        assert status.tps == 0.0

        # Streaming: TPS calculated from timestamps
        now = time.monotonic()
        soul._streaming_token_timestamps = deque(
            [
                (now - 2.0, 0.0),
                (now - 1.0, 50.0),
                (now, 100.0),
            ]
        )
        status = soul.status
        assert status.tps == pytest.approx(50.0, rel=0.1)  # 100 tokens / 2 seconds

    @staticmethod
    def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
        agent = Agent(
            name="TPS Test Agent",
            system_prompt="Test prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        )
        return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
