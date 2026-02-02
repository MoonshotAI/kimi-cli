from __future__ import annotations

import hashlib
from pathlib import Path

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    collect_until_response,
    make_home_dir,
    make_work_dir,
    send_initialize,
    share_dir,
    start_wire,
    summarize_messages,
    write_scripted_config,
)


def _session_dir(home_dir: Path, work_dir: Path) -> Path:
    digest = hashlib.md5(str(work_dir).encode("utf-8")).hexdigest()
    return share_dir(home_dir) / "sessions" / digest


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    return len(path.read_text(encoding="utf-8").splitlines())


def test_session_files_created(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: hello"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    session_id = "e2e-session"

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        extra_args=["--session", session_id],
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "hi"},
            }
        )
        resp, _ = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
    finally:
        wire.close()

    session_dir = _session_dir(home_dir, work_dir) / session_id
    context_file = session_dir / "context.jsonl"
    wire_file = session_dir / "wire.jsonl"
    assert context_file.exists()
    assert wire_file.exists()
    assert context_file.stat().st_size > 0
    assert wire_file.stat().st_size > 0
    assert sorted(p.name for p in session_dir.iterdir()) == snapshot(
        ["context.jsonl", "wire.jsonl"]
    )


def test_continue_session_appends(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: first", "text: second"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "first"},
            }
        )
        resp, _ = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
    finally:
        wire.close()

    session_root = _session_dir(home_dir, work_dir)
    session_ids = [p.name for p in session_root.iterdir() if p.is_dir()]
    assert len(session_ids) == 1
    session_id = session_ids[0]
    session_dir = session_root / session_id
    context_file = session_dir / "context.jsonl"
    wire_file = session_dir / "wire.jsonl"
    context_before = _count_lines(context_file)
    wire_before = _count_lines(wire_file)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        extra_args=["--continue"],
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-2",
                "method": "prompt",
                "params": {"user_input": "second"},
            }
        )
        resp, _ = collect_until_response(wire, "prompt-2")
        assert resp.get("result", {}).get("status") == "finished"
    finally:
        wire.close()

    context_after = _count_lines(context_file)
    wire_after = _count_lines(wire_file)
    assert context_after > context_before
    assert wire_after > wire_before
    assert {
        "context_before": context_before,
        "context_after": context_after,
        "wire_before": wire_before,
        "wire_after": wire_after,
    } == snapshot({"context_before": 4, "context_after": 8, "wire_before": 6, "wire_after": 11})


def test_clear_context_rotates(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: hello"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "hi"},
            }
        )
        resp, _ = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"

        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-2",
                "method": "prompt",
                "params": {"user_input": "/clear"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-2")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "/clear"}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "The context has been cleared."},
                },
                {"method": "event", "type": "TurnEnd", "payload": {}},
            ]
        )
    finally:
        wire.close()

    session_root = _session_dir(home_dir, work_dir)
    session_ids = [p.name for p in session_root.iterdir() if p.is_dir()]
    assert len(session_ids) == 1
    session_dir = session_root / session_ids[0]
    context_file = session_dir / "context.jsonl"
    assert context_file.stat().st_size == 0
    rotated = sorted(p.name for p in session_dir.iterdir() if p.name.startswith("context.jsonl."))
    assert rotated == snapshot([])


def test_manual_compact(tmp_path) -> None:
    scripts = [
        "text: hello",
        "text: compacted summary",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "hi"},
            }
        )
        resp, _ = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"

        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-2",
                "method": "prompt",
                "params": {"user_input": "/compact"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-2")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "/compact"}},
                {"method": "event", "type": "CompactionBegin", "payload": {}},
                {"method": "event", "type": "CompactionEnd", "payload": {}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "The context has been compacted."},
                },
                {"method": "event", "type": "TurnEnd", "payload": {}},
            ]
        )
    finally:
        wire.close()
