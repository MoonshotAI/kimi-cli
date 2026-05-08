#!/usr/bin/env python3
"""Locate and summarize a Kimi CLI session for smoke-test review."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Locate and summarize a Kimi CLI session for smoke-test review."
    )
    parser.add_argument("--share-dir", type=Path, help="Share dir that contains sessions/")
    parser.add_argument("--session-dir", type=Path, help="Explicit session directory to inspect")
    parser.add_argument(
        "--tail-lines", type=int, default=12, help="How many recent records to show"
    )
    parser.add_argument(
        "--max-text",
        type=int,
        default=220,
        help="Maximum characters to show for any text preview",
    )
    return parser.parse_args()


def truncate(text: str, max_text: int) -> str:
    text = " ".join(text.split())
    if len(text) <= max_text:
        return text
    return text[: max_text - 3] + "..."


def extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                parts.append(str(item))
                continue
            kind = item.get("type")
            if kind == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif kind == "think" and isinstance(item.get("think"), str):
                parts.append(item["think"])
            elif kind == "shell" and isinstance(item.get("command"), str):
                parts.append(item["command"])
            else:
                parts.append(json.dumps(item, ensure_ascii=False))
        return " ".join(parts)
    return json.dumps(content, ensure_ascii=False)


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def iter_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                obj = {"_raw": line}
            records.append(obj)
    return records


def find_latest_session(share_dir: Path) -> Path:
    sessions_root = share_dir / "sessions"
    if not sessions_root.exists():
        raise FileNotFoundError(f"sessions directory not found: {sessions_root}")

    candidates: list[tuple[float, Path]] = []
    for path in sessions_root.glob("*/*"):
        if not path.is_dir():
            continue
        context_path = path / "context.jsonl"
        wire_path = path / "wire.jsonl"
        if context_path.exists():
            mtime = context_path.stat().st_mtime
        elif wire_path.exists():
            mtime = wire_path.stat().st_mtime
        else:
            mtime = path.stat().st_mtime
        candidates.append((mtime, path))

    if not candidates:
        raise FileNotFoundError(f"no session directories found under: {sessions_root}")

    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def print_header(title: str) -> None:
    print()
    print(f"== {title} ==")


def summarize_context_record(record: dict[str, Any], max_text: int) -> str:
    if "_raw" in record:
        return truncate(record["_raw"], max_text)

    role = record.get("role", "<unknown>")
    if role == "_system_prompt":
        return "role=_system_prompt"
    if role == "_checkpoint":
        return f"role=_checkpoint id={record.get('id')}"
    if role == "_usage":
        return f"role=_usage token_count={record.get('token_count')}"

    text = truncate(extract_text(record.get("content")), max_text)

    if role == "assistant":
        tool_calls = record.get("tool_calls") or []
        tool_names = [
            call.get("function", {}).get("name")
            for call in tool_calls
            if isinstance(call, dict) and isinstance(call.get("function"), dict)
        ]
        parts: list[str] = [f"role={role}"]
        if tool_names:
            parts.append("tools=" + ",".join(name for name in tool_names if name))
        if text:
            parts.append(f"text={text}")
        return " | ".join(parts)

    if role == "tool":
        parts = [f"role={role}"]
        if record.get("tool_call_id"):
            parts.append(f"tool_call_id={record['tool_call_id']}")
        if text:
            parts.append(f"text={text}")
        return " | ".join(parts)

    if text:
        return f"role={role} | text={text}"
    return f"role={role}"


def summarize_wire_record(record: dict[str, Any], max_text: int) -> str:
    if "_raw" in record:
        return truncate(record["_raw"], max_text)

    message = record.get("message")
    if not isinstance(message, dict):
        return truncate(json.dumps(record, ensure_ascii=False), max_text)

    message_type = message.get("type", "<unknown>")
    payload = message.get("payload", {})
    parts = [f"type={message_type}"]

    if message_type == "StepBegin":
        parts.append(f"n={payload.get('n')}")
    elif message_type == "ContentPart":
        part_type = payload.get("type")
        parts.append(f"part={part_type}")
        if part_type in {"text", "think"}:
            raw = payload.get("text") or payload.get("think") or ""
            parts.append("text=" + truncate(raw, max_text))
    elif message_type == "ToolCall":
        function = payload.get("function", {})
        if isinstance(function, dict):
            parts.append(f"tool={function.get('name')}")
    elif message_type == "ApprovalRequest":
        parts.append(f"action={payload.get('action')}")
        if payload.get("description"):
            parts.append("desc=" + truncate(str(payload["description"]), max_text))
    elif message_type == "TurnBegin":
        user_input = payload.get("user_input") or []
        parts.append(f"user_parts={len(user_input)}")
    elif message_type == "StatusUpdate":
        parts.append(f"context_tokens={payload.get('context_tokens')}")

    return " | ".join(parts)


def print_jsonl_summary(title: str, path: Path, tail_lines: int, max_text: int) -> None:
    if not path.exists():
        print_header(title)
        print("missing")
        return

    records = iter_jsonl(path)
    print_header(title)
    print(path)
    print(f"records: {len(records)}")

    if path.name == "context.jsonl":
        counter = Counter(record.get("role", "<raw>") for record in records)
        print("roles:", ", ".join(f"{key}={value}" for key, value in sorted(counter.items())))
        tail = records[-tail_lines:]
        for idx, record in enumerate(tail, start=max(1, len(records) - len(tail) + 1)):
            print(f"[{idx}] {summarize_context_record(record, max_text)}")
    else:
        counter = Counter(
            record.get("message", {}).get("type", "<raw>")
            if isinstance(record.get("message"), dict)
            else "<raw>"
            for record in records
        )
        print("types:", ", ".join(f"{key}={value}" for key, value in sorted(counter.items())))
        tail = records[-tail_lines:]
        for idx, record in enumerate(tail, start=max(1, len(records) - len(tail) + 1)):
            print(f"[{idx}] {summarize_wire_record(record, max_text)}")


def print_file_inventory(session_dir: Path) -> None:
    print_header("Files")
    for path in sorted(session_dir.rglob("*")):
        if path.is_dir():
            continue
        relative = path.relative_to(session_dir)
        size = path.stat().st_size
        print(f"{relative} ({size} bytes)")


def tail_text_file(path: Path, tail_lines: int, max_text: int) -> list[str]:
    if not path.exists():
        return []
    lines = path.read_text(errors="replace").splitlines()
    return [truncate(line, max_text) for line in lines[-tail_lines:]]


def print_task_summary(session_dir: Path, tail_lines: int, max_text: int) -> None:
    tasks_dir = session_dir / "tasks"
    if not tasks_dir.exists():
        return

    task_dirs = sorted(path for path in tasks_dir.iterdir() if path.is_dir())
    if not task_dirs:
        return

    print_header("Background Tasks")
    for task_dir in task_dirs:
        spec = load_json(task_dir / "spec.json") or {}
        runtime = load_json(task_dir / "runtime.json") or {}
        control = load_json(task_dir / "control.json") or {}
        consumer = load_json(task_dir / "consumer.json") or {}
        print(f"task_id: {task_dir.name}")
        print(f"  description: {spec.get('description')}")
        print(f"  kind: {spec.get('kind')}")
        print(f"  status: {runtime.get('status')}")
        if runtime.get("exit_code") is not None:
            print(f"  exit_code: {runtime.get('exit_code')}")
        if spec.get("cwd"):
            print(f"  cwd: {spec.get('cwd')}")
        if spec.get("timeout_s") is not None:
            print(f"  timeout_s: {spec.get('timeout_s')}")
        for key in (
            "created_at",
            "started_at",
            "finished_at",
            "heartbeat_at",
            "failure_reason",
            "worker_pid",
            "child_pid",
        ):
            value = runtime.get(key)
            if value is not None:
                print(f"  {key}: {value}")
        for key in ("kill_requested_at", "kill_reason"):
            value = control.get(key)
            if value is not None:
                print(f"  {key}: {value}")
        for key in ("last_read_offset", "last_viewed_at"):
            value = consumer.get(key)
            if value is not None:
                print(f"  {key}: {value}")
        output_path = task_dir / "output.log"
        if output_path.exists():
            print(f"  output_log: {output_path}")
            for line in tail_text_file(output_path, tail_lines, max_text):
                print(f"    {line}")
        print()


def main() -> int:
    args = parse_args()

    try:
        if args.session_dir:
            session_dir = args.session_dir.expanduser().resolve()
        elif args.share_dir:
            session_dir = find_latest_session(args.share_dir.expanduser().resolve())
        else:
            print("error: pass --session-dir or --share-dir", file=sys.stderr)
            return 1
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not session_dir.is_dir():
        print(f"error: session directory does not exist: {session_dir}", file=sys.stderr)
        return 1

    print(f"Session dir: {session_dir}")
    print_file_inventory(session_dir)
    print_jsonl_summary("Context", session_dir / "context.jsonl", args.tail_lines, args.max_text)
    print_jsonl_summary("Wire", session_dir / "wire.jsonl", args.tail_lines, args.max_text)
    print_task_summary(session_dir, args.tail_lines, args.max_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
