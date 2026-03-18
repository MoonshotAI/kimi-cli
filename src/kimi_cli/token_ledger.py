"""Persistent daily and weekly token usage tracker.

Stats are stored at ``~/.kimi/token-stats.json`` and reset automatically
when the date/ISO-week boundary is crossed.
"""

from __future__ import annotations

import contextlib
import json
import math
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, cast

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
    def from_dict(cls, d: dict[str, Any]) -> _PeriodStats:
        """Create _PeriodStats from dict, coercing values to int."""

        def _to_int(v: Any) -> int:
            if isinstance(v, int):
                return v
            if isinstance(v, float):
                # Guard against non-finite numbers (inf, nan)
                if not math.isfinite(v):
                    return 0
                return int(v)
            if isinstance(v, str):
                try:
                    fv = float(v)
                    if not math.isfinite(fv):
                        return 0
                    return int(fv)
                except (ValueError, TypeError):
                    return 0
            return 0

        return cls(
            input_other=_to_int(d.get("input_other", 0)),
            output=_to_int(d.get("output", 0)),
            input_cache_read=_to_int(d.get("input_cache_read", 0)),
            input_cache_creation=_to_int(d.get("input_cache_creation", 0)),
        )


class TokenLedger:
    """Accumulate and persist daily / weekly token usage across sessions."""

    def __init__(self, stats_file: Path) -> None:
        self._file = stats_file

        self._daily = _PeriodStats()
        self._weekly = _PeriodStats()
        self._load()

    # ── public interface ──────────────────────────────────────────────────

    def record(self, usage: TokenUsage) -> None:
        """Add *usage* to both daily and weekly buckets, then persist.

        Recomputes period boundaries before recording to handle long-running
        sessions that cross midnight or Monday boundaries.
        """
        # Reload from disk to pick up any concurrent updates, then add and save
        self._reload_and_merge()
        self._daily.add(usage)
        self._weekly.add(usage)
        self._save()

    @property
    def daily(self) -> TokenUsage:
        """Total token usage for today (all sessions)."""
        # Reload from disk to pick up concurrent updates before returning
        self._reload_and_merge()
        return self._daily.to_token_usage()

    @property
    def weekly(self) -> TokenUsage:
        """Total token usage for the current ISO week (all sessions)."""
        # Reload from disk to pick up concurrent updates before returning
        self._reload_and_merge()
        return self._weekly.to_token_usage()

    # ── internal helpers ──────────────────────────────────────────────────

    def _get_today_str(self) -> str:
        """Get current date as ISO string."""
        return date.today().isoformat()

    def _get_week_start_str(self) -> str:
        """Get current week start (Monday) as ISO string."""
        today = date.today()
        week_start = today - timedelta(days=today.weekday())
        return week_start.isoformat()

    def _reload_and_merge(self) -> None:
        """Reload from disk and merge, handling date boundaries.

        This ensures that if another process has written stats, we pick them up
        before adding our own.
        """
        # First check if we need to reset due to date boundary
        self._maybe_reset_boundaries()

        # Then reload and merge disk data
        disk_daily, disk_weekly = self._read_from_disk()
        if disk_daily is not None:
            self._daily = disk_daily
        if disk_weekly is not None:
            self._weekly = disk_weekly

    def _read_from_disk(self) -> tuple[_PeriodStats | None, _PeriodStats | None]:
        """Read stats from disk and return (daily, weekly) if valid for current period."""
        if not self._file.exists():
            return (None, None)

        today_str = self._get_today_str()
        week_start_str = self._get_week_start_str()

        try:
            raw_data = json.loads(self._file.read_text())
        except (json.JSONDecodeError, OSError):
            return (None, None)

        # Validate root type is a mapping before accessing
        if not isinstance(raw_data, dict):
            return (None, None)
        data: dict[str, Any] = raw_data

        daily = None
        weekly = None

        # Safely extract daily stats with type checking
        daily_data = data.get("daily")
        if isinstance(daily_data, dict):
            daily_dict = cast(dict[str, Any], daily_data)
            if daily_dict.get("date") == today_str:
                with contextlib.suppress(TypeError, AttributeError):
                    daily = _PeriodStats.from_dict(daily_dict)

        # Safely extract weekly stats with type checking
        weekly_data = data.get("weekly")
        if isinstance(weekly_data, dict):
            weekly_dict = cast(dict[str, Any], weekly_data)
            if weekly_dict.get("week_start") == week_start_str:
                with contextlib.suppress(TypeError, AttributeError):
                    weekly = _PeriodStats.from_dict(weekly_dict)

        return (daily, weekly)

    def _maybe_reset_boundaries(self) -> None:
        """Reset daily/weekly stats if we've crossed a boundary.

        Called before any read or write operation to ensure stats are
        attributed to the correct period for long-running sessions.
        """
        today_str = self._get_today_str()
        week_start_str = self._get_week_start_str()

        # Load current saved state to check dates
        if self._file.exists():
            try:
                data = cast(dict[str, Any], json.loads(self._file.read_text()))
                daily_data = cast(dict[str, Any] | None, data.get("daily"))
                if isinstance(daily_data, dict):
                    saved_daily_date = cast(str | None, daily_data.get("date"))
                else:
                    saved_daily_date = None
                weekly_data = cast(dict[str, Any] | None, data.get("weekly"))
                if isinstance(weekly_data, dict):
                    saved_week_start = cast(str | None, weekly_data.get("week_start"))
                else:
                    saved_week_start = None

                # Reset daily if date changed
                if saved_daily_date != today_str:
                    self._daily = _PeriodStats()

                # Reset weekly if week changed
                if saved_week_start != week_start_str:
                    self._weekly = _PeriodStats()
            except (json.JSONDecodeError, OSError, AttributeError):
                # If file is corrupted, continue with current in-memory stats
                pass

    def _load(self) -> None:
        """Load stats from file, respecting date boundaries."""
        daily, weekly = self._read_from_disk()
        if daily is not None:
            self._daily = daily
        if weekly is not None:
            self._weekly = weekly

    def _save(self) -> None:
        today_str = self._get_today_str()
        week_start_str = self._get_week_start_str()

        data = {
            "daily": {"date": today_str, **self._daily.to_dict()},
            "weekly": {"week_start": week_start_str, **self._weekly.to_dict()},
        }
        try:
            tmp = self._file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data))
            tmp.replace(self._file)
        except OSError:
            pass  # best effort — never crash the agent over stats
