"""Input payload builders for each hook event type."""

from __future__ import annotations

from typing import Any


def _base(event: str, session_id: str, cwd: str) -> dict[str, Any]:
    return {"hook_event_name": event, "session_id": session_id, "cwd": cwd}


def pre_tool_use(
    *,
    session_id: str,
    cwd: str,
    tool_name: str,
    tool_input: dict[str, Any],
    tool_call_id: str = "",
) -> dict[str, Any]:
    return {
        **_base("PreToolUse", session_id, cwd),
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_call_id": tool_call_id,
    }


def post_tool_use(
    *,
    session_id: str,
    cwd: str,
    tool_name: str,
    tool_input: dict[str, Any],
    tool_output: str = "",
    tool_call_id: str = "",
) -> dict[str, Any]:
    return {
        **_base("PostToolUse", session_id, cwd),
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_output": tool_output,
        "tool_call_id": tool_call_id,
    }


def post_tool_use_failure(
    *,
    session_id: str,
    cwd: str,
    tool_name: str,
    tool_input: dict[str, Any],
    error: str,
    tool_call_id: str = "",
) -> dict[str, Any]:
    return {
        **_base("PostToolUseFailure", session_id, cwd),
        "tool_name": tool_name,
        "tool_input": tool_input,
        "error": error,
        "tool_call_id": tool_call_id,
    }


def user_prompt_submit(
    *,
    session_id: str,
    cwd: str,
    prompt: str,
) -> dict[str, Any]:
    return {**_base("UserPromptSubmit", session_id, cwd), "prompt": prompt}


def stop(
    *,
    session_id: str,
    cwd: str,
    stop_hook_active: bool = False,
) -> dict[str, Any]:
    return {
        **_base("Stop", session_id, cwd),
        "stop_hook_active": stop_hook_active,
    }


def stop_failure(
    *,
    session_id: str,
    cwd: str,
    error_type: str,
    error_message: str,
) -> dict[str, Any]:
    return {
        **_base("StopFailure", session_id, cwd),
        "error_type": error_type,
        "error_message": error_message,
    }


def session_start(
    *,
    session_id: str,
    cwd: str,
    source: str,
) -> dict[str, Any]:
    return {**_base("SessionStart", session_id, cwd), "source": source}


def session_end(
    *,
    session_id: str,
    cwd: str,
    reason: str,
) -> dict[str, Any]:
    return {**_base("SessionEnd", session_id, cwd), "reason": reason}


def subagent_start(
    *,
    session_id: str,
    cwd: str,
    agent_name: str,
    prompt: str,
) -> dict[str, Any]:
    return {
        **_base("SubagentStart", session_id, cwd),
        "agent_name": agent_name,
        "prompt": prompt,
    }


def subagent_stop(
    *,
    session_id: str,
    cwd: str,
    agent_name: str,
    response: str = "",
) -> dict[str, Any]:
    return {
        **_base("SubagentStop", session_id, cwd),
        "agent_name": agent_name,
        "response": response,
    }


def pre_compact(
    *,
    session_id: str,
    cwd: str,
    trigger: str,
    token_count: int,
) -> dict[str, Any]:
    return {
        **_base("PreCompact", session_id, cwd),
        "trigger": trigger,
        "token_count": token_count,
    }


def post_compact(
    *,
    session_id: str,
    cwd: str,
    trigger: str,
    estimated_token_count: int,
) -> dict[str, Any]:
    return {
        **_base("PostCompact", session_id, cwd),
        "trigger": trigger,
        "estimated_token_count": estimated_token_count,
    }


def notification(
    *,
    session_id: str,
    cwd: str,
    sink: str,
    notification_type: str,
    title: str = "",
    body: str = "",
    severity: str = "info",
) -> dict[str, Any]:
    return {
        **_base("Notification", session_id, cwd),
        "sink": sink,
        "notification_type": notification_type,
        "title": title,
        "body": body,
        "severity": severity,
    }
