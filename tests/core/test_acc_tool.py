from __future__ import annotations

from kimi_cli.soul.acc_tool import AccCompactContextTool


async def test_acc_tool_rejects_when_disabled() -> None:
    called = False

    async def _compact(_: str) -> None:
        nonlocal called
        called = True

    tool = AccCompactContextTool(is_acc_enabled=lambda: False, compact_context=_compact)
    result = await tool.call({"task_summary": "task summary"})

    assert result.is_error is True
    assert "disabled" in (result.message or "").lower()
    assert called is False


async def test_acc_tool_compacts_when_enabled() -> None:
    called_with: list[str] = []

    async def _compact(summary: str) -> None:
        called_with.append(summary)

    tool = AccCompactContextTool(is_acc_enabled=lambda: True, compact_context=_compact)
    result = await tool.call({"task_summary": "task summary"})

    assert result.is_error is False
    assert called_with == ["task summary"]
