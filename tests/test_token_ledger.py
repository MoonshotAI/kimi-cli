"""Tests for TokenLedger — persistent daily/weekly token usage tracker."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pytest
from kosong.chat_provider import TokenUsage

from kimi_cli.token_ledger import TokenLedger


def _usage(input_other: int = 0, output: int = 0) -> TokenUsage:
    return TokenUsage(input_other=input_other, output=output)


# ── fresh ledger ──────────────────────────────────────────────────────────────


def test_initial_zero(tmp_path: Path) -> None:
    ledger = TokenLedger(tmp_path / "stats.json")
    assert ledger.daily.total == 0
    assert ledger.weekly.total == 0


def test_record_accumulates(tmp_path: Path) -> None:
    ledger = TokenLedger(tmp_path / "stats.json")
    ledger.record(_usage(input_other=100, output=50))
    ledger.record(_usage(input_other=200, output=30))
    assert ledger.daily.input_other == 300
    assert ledger.daily.output == 80
    assert ledger.weekly.input_other == 300
    assert ledger.weekly.output == 80


# ── persistence ───────────────────────────────────────────────────────────────


def test_persists_across_sessions(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    ledger = TokenLedger(f)
    ledger.record(_usage(input_other=500, output=100))

    # new instance reads the same file
    ledger2 = TokenLedger(f)
    assert ledger2.daily.input_other == 500
    assert ledger2.daily.output == 100
    assert ledger2.weekly.input_other == 500


def test_file_created_on_record(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    assert not f.exists()
    ledger = TokenLedger(f)
    ledger.record(_usage(output=10))
    assert f.exists()


def test_saved_json_structure(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    ledger = TokenLedger(f)
    ledger.record(_usage(input_other=10, output=5))
    data = json.loads(f.read_text())
    assert "daily" in data and "weekly" in data
    assert data["daily"]["date"] == date.today().isoformat()
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    assert data["weekly"]["week_start"] == week_start.isoformat()


# ── date boundary resets ──────────────────────────────────────────────────────


def test_stale_daily_resets(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    # Write a file with yesterday's date
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    f.write_text(json.dumps({
        "daily": {"date": yesterday, "input_other": 999, "output": 999,
                  "input_cache_read": 0, "input_cache_creation": 0},
        "weekly": {"week_start": week_start, "input_other": 999, "output": 999,
                   "input_cache_read": 0, "input_cache_creation": 0},
    }))
    ledger = TokenLedger(f)
    # daily should be reset; weekly should carry over
    assert ledger.daily.total == 0
    assert ledger.weekly.input_other == 999


def test_stale_weekly_resets(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    today = date.today()
    today_str = today.isoformat()
    old_week = (today - timedelta(weeks=1)).isoformat()
    f.write_text(json.dumps({
        "daily": {"date": today_str, "input_other": 100, "output": 50,
                  "input_cache_read": 0, "input_cache_creation": 0},
        "weekly": {"week_start": old_week, "input_other": 888, "output": 888,
                   "input_cache_read": 0, "input_cache_creation": 0},
    }))
    ledger = TokenLedger(f)
    assert ledger.daily.input_other == 100
    assert ledger.weekly.total == 0


# ── resilience ────────────────────────────────────────────────────────────────


def test_corrupt_file_ignored(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    f.write_text("not valid json{{")
    ledger = TokenLedger(f)
    assert ledger.daily.total == 0
    # should still be able to record without error
    ledger.record(_usage(output=1))
    assert ledger.daily.output == 1


def test_missing_fields_default_zero(tmp_path: Path) -> None:
    f = tmp_path / "stats.json"
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    f.write_text(json.dumps({
        "daily": {"date": today.isoformat(), "output": 42},
        "weekly": {"week_start": week_start.isoformat()},
    }))
    ledger = TokenLedger(f)
    assert ledger.daily.output == 42
    assert ledger.daily.input_other == 0
    assert ledger.weekly.total == 0
