from kimi_cli.background.models import MonitorPayload, TaskSpec, monitor_payload


def test_monitor_payload_defaults():
    p = MonitorPayload()
    assert (p.batch_ms, p.max_lines_per_window, p.volume_window_s, p.notify_offset) == (
        200,
        200,
        5.0,
        0,
    )


def test_monitor_payload_from_spec_roundtrip():
    spec = TaskSpec(
        id="monitor-x",
        kind="monitor",
        session_id="s",
        description="d",
        tool_call_id="t",
        kind_payload={"notify_offset": 42, "batch_ms": 100},
    )
    p = monitor_payload(spec)
    assert p.notify_offset == 42 and p.batch_ms == 100


def test_monitor_payload_missing_payload_is_defaults():
    spec = TaskSpec(
        id="monitor-y", kind="monitor", session_id="s", description="d", tool_call_id="t"
    )
    assert monitor_payload(spec).notify_offset == 0
