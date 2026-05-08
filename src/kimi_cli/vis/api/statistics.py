"""Vis API for aggregate statistics across all sessions."""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter

from kimi_cli.share import get_share_dir
from kimi_cli.vis.api.sessions import collect_events, get_work_dir_for_hash
from kimi_cli.wire.file import WireFileMetadata, parse_wire_file_line

router = APIRouter(prefix="/api/vis", tags=["vis"])


# Simple in-memory cache: (result, timestamp)
_cache: dict[str, tuple[dict[str, Any], float]] = {}
_CACHE_TTL = 60  # seconds


@router.get("/statistics")
def get_statistics() -> dict[str, Any]:
    """Aggregate statistics across all sessions."""
    now = time.time()
    cached = _cache.get("statistics")
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    sessions_root = get_share_dir() / "sessions"
    if not sessions_root.exists():
        empty: dict[str, Any] = {
            "total_sessions": 0,
            "total_turns": 0,
            "total_tokens": {"input": 0, "output": 0},
            "total_duration_sec": 0,
            "tool_usage": [],
            "daily_usage": [],
            "per_project": [],
        }
        _cache["statistics"] = (empty, now)
        return empty

    total_sessions = 0
    total_turns = 0
    total_input_tokens = 0
    total_output_tokens = 0
    total_duration_sec = 0.0

    # tool_name -> { count, error_count }
    tool_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"count": 0, "error_count": 0})

    # date_str -> { sessions, turns }
    daily_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"sessions": 0, "turns": 0})

    # work_dir -> { sessions, turns }
    project_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"sessions": 0, "turns": 0})

    for work_dir_hash_dir in sessions_root.iterdir():
        if not work_dir_hash_dir.is_dir():
            continue
        work_dir = get_work_dir_for_hash(work_dir_hash_dir.name) or work_dir_hash_dir.name

        for session_dir in work_dir_hash_dir.iterdir():
            if not session_dir.is_dir():
                continue

            wire_path = session_dir / "wire.jsonl"
            if not wire_path.exists():
                continue

            total_sessions += 1
            session_turns = 0
            session_input_tokens = 0
            session_output_tokens = 0
            first_ts = 0.0
            last_ts = 0.0
            session_date: str | None = None

            # Track pending tool calls for error attribution
            pending_tools: dict[str, str] = {}  # tool_call_id -> tool_name

            try:
                with wire_path.open(encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            parsed = parse_wire_file_line(line)
                        except Exception:
                            continue
                        if isinstance(parsed, WireFileMetadata):
                            continue

                        ts = parsed.timestamp
                        msg_type = parsed.message.type
                        payload = parsed.message.payload

                        if first_ts == 0:
                            first_ts = ts
                            # Determine date from first timestamp
                            try:
                                dt = datetime.fromtimestamp(ts, tz=UTC)
                                session_date = dt.strftime("%Y-%m-%d")
                            except Exception:
                                pass
                        last_ts = ts

                        # Collect (type, payload) pairs, unwrapping SubagentEvent recursively
                        events_to_process: list[tuple[str, dict[str, Any]]] = []
                        collect_events(msg_type, payload, events_to_process)

                        for ev_type, ev_payload in events_to_process:
                            if ev_type == "TurnBegin":
                                session_turns += 1
                            elif ev_type == "ToolCall":
                                fn: dict[str, Any] | None = ev_payload.get("function")
                                tool_id: str = ev_payload.get("id", "")
                                if isinstance(fn, dict):
                                    name: str = fn.get("name", "unknown")
                                    tool_stats[name]["count"] += 1
                                    if tool_id:
                                        pending_tools[tool_id] = name
                            elif ev_type == "ToolResult":
                                tool_call_id: str = ev_payload.get("tool_call_id", "")
                                rv: dict[str, Any] | None = ev_payload.get("return_value")
                                if isinstance(rv, dict) and rv.get("is_error"):
                                    tool_name = pending_tools.get(tool_call_id)
                                    if tool_name:
                                        tool_stats[tool_name]["error_count"] += 1
                                pending_tools.pop(tool_call_id, None)
                            elif ev_type == "StatusUpdate":
                                tu: dict[str, Any] | None = ev_payload.get("token_usage")
                                if isinstance(tu, dict):
                                    session_input_tokens += (
                                        int(tu.get("input_other", 0))
                                        + int(tu.get("input_cache_read", 0))
                                        + int(tu.get("input_cache_creation", 0))
                                    )
                                    session_output_tokens += int(tu.get("output", 0))
            except Exception:
                continue

            total_turns += session_turns
            total_input_tokens += session_input_tokens
            total_output_tokens += session_output_tokens

            duration = last_ts - first_ts if last_ts > first_ts else 0
            total_duration_sec += duration

            # Aggregate daily
            if session_date:
                daily_stats[session_date]["sessions"] += 1
                daily_stats[session_date]["turns"] += session_turns

            # Aggregate per project
            project_stats[work_dir]["sessions"] += 1
            project_stats[work_dir]["turns"] += session_turns

    # Build tool_usage: top 20 by count
    tool_usage = sorted(
        [
            {"name": name, "count": stats["count"], "error_count": stats["error_count"]}
            for name, stats in tool_stats.items()
        ],
        key=lambda x: x["count"],
        reverse=True,
    )[:20]

    # Build daily_usage: last 30 days
    today = datetime.now(tz=UTC)
    daily_usage: list[dict[str, Any]] = []
    for i in range(29, -1, -1):
        d = today - timedelta(days=i)
        date_str = d.strftime("%Y-%m-%d")
        entry = daily_stats.get(date_str, {"sessions": 0, "turns": 0})
        daily_usage.append(
            {
                "date": date_str,
                "sessions": entry["sessions"],
                "turns": entry["turns"],
            }
        )

    # Build per_project: top 10 by turns
    per_project = sorted(
        [
            {"work_dir": wd, "sessions": stats["sessions"], "turns": stats["turns"]}
            for wd, stats in project_stats.items()
        ],
        key=lambda x: x["turns"],
        reverse=True,
    )[:10]

    result: dict[str, Any] = {
        "total_sessions": total_sessions,
        "total_turns": total_turns,
        "total_tokens": {"input": total_input_tokens, "output": total_output_tokens},
        "total_duration_sec": total_duration_sec,
        "tool_usage": tool_usage,
        "daily_usage": daily_usage,
        "per_project": per_project,
    }

    _cache["statistics"] = (result, now)
    return result
