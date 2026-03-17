"""Persistent daily and weekly token usage tracker.

Stats are stored at ``~/.kimi/token-stats.json`` and reset automatically
when the date/ISO-week boundary is crossed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from kosong.chat_provider import TokenUsage


@dataclass
class _PeriodStats:
    input_other: int = 0
    output: int = 0
    input_cache_read: int = 0
    input_cache_creation: int = 0

    def add(self, usage: TokenUsage) -> None:
        self.input_other += usage.input_other
        self.output += usage.output
        self.input_cache_read += usage.input_cache_read
        self.input_cache_creation += usage.input_cache_creation

    def to_token_usage(self) -> TokenUsage:
        return TokenUsage(
            input_other=self.input_other,
            output=self.output,
            input_cache_read=self.input_cache_read,
            input_cache_creation=self.input_cache_creation,
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "input_other": self.input_other,
            "output": self.output,
            "input_cache_read": self.input_cache_read,
            "input_cache_creation": self.input_cache_creation,
        }

    @classmethod
    def from_dict(cls, d: dict[str, int]) -> _PeriodStats:
        return cls(
            input_other=d.get("input_other", 0),
            output=d.get("output", 0),
            input_cache_read=d.get("input_cache_read", 0),
            input_cache_creation=d.get("input_cache_creation", 0),
        )


class TokenLedger:
    """Accumulate and persist daily / weekly token usage across sessions."""

    def __init__(self, stats_file: Path) -> None:
        self._file = stats_file
        today = date.today()
        week_start = today - timedelta(days=today.weekday())  # Monday

        self._today_str = today.isoformat()
        self._week_start_str = week_start.isoformat()

        self._daily = _PeriodStats()
        self._weekly = _PeriodStats()
        self._load()

    # ── public interface ──────────────────────────────────────────────────

    def record(self, usage: TokenUsage) -> None:
        """Add *usage* to both daily and weekly buckets, then persist."""
        self._daily.add(usage)
        self._weekly.add(usage)
        self._save()

    @property
    def daily(self) -> TokenUsage:
        """Total token usage for today (all sessions)."""
        return self._daily.to_token_usage()

    @property
    def weekly(self) -> TokenUsage:
        """Total token usage for the current ISO week (all sessions)."""
        return self._weekly.to_token_usage()

    # ── internal helpers ──────────────────────────────────────────────────

    def _load(self) -> None:
        if not self._file.exists():
            return
        try:
            data: dict[str, Any] = json.loads(self._file.read_text())
        except (json.JSONDecodeError, OSError):
            return

        if data.get("daily", {}).get("date") == self._today_str:
            self._daily = _PeriodStats.from_dict(data["daily"])

        if data.get("weekly", {}).get("week_start") == self._week_start_str:
            self._weekly = _PeriodStats.from_dict(data["weekly"])

    def _save(self) -> None:
        data = {
            "daily": {"date": self._today_str, **self._daily.to_dict()},
            "weekly": {"week_start": self._week_start_str, **self._weekly.to_dict()},
        }
        try:
            tmp = self._file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data))
            tmp.rename(self._file)
        except OSError:
            pass  # best effort — never crash the agent over stats
