from __future__ import annotations

import contextlib
import json
import os
import queue
import shlex
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

TRACE_ENV = "KIMI_TEST_TRACE"
WIRE_COMMAND_ENV = "KIMI_E2E_WIRE_CMD"
DEFAULT_TIMEOUT = 5.0
_PATH_REPLACEMENTS: dict[str, str] = {}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _print_trace(label: str, text: str) -> None:
    if os.getenv(TRACE_ENV) == "1":
        print("-----")
        print(f"{label}: {text}")


def make_home_dir(tmp_path: Path) -> Path:
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    register_path_replacements(tmp_path=tmp_path, home_dir=home_dir)
    return home_dir


def make_work_dir(tmp_path: Path) -> Path:
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    register_path_replacements(tmp_path=tmp_path, work_dir=work_dir)
    return work_dir


def make_env(home_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home_dir)
    env["USERPROFILE"] = str(home_dir)
    env["KIMI_SHARE_DIR"] = str(share_dir(home_dir))
    return env


def share_dir(home_dir: Path) -> Path:
    return home_dir / ".kimi"


def register_path_replacements(
    *,
    tmp_path: Path | None = None,
    home_dir: Path | None = None,
    work_dir: Path | None = None,
) -> None:
    _add_replacement(tmp_path, "<tmp>")
    _add_replacement(home_dir, "<home_dir>")
    _add_replacement(work_dir, "<work_dir>")


def _add_replacement(path: Path | None, token: str) -> None:
    if path is None:
        return
    _PATH_REPLACEMENTS[str(path)] = token
    resolved = path.resolve()
    _PATH_REPLACEMENTS[str(resolved)] = token


def write_scripts_file(tmp_path: Path, scripts: list[str], name: str = "scripts.json") -> Path:
    scripts_path = tmp_path / name
    scripts_path.write_text(json.dumps(scripts), encoding="utf-8")
    return scripts_path


def write_scripted_config(
    tmp_path: Path,
    scripts: list[str],
    *,
    model_name: str = "scripted",
    provider_name: str = "scripted_provider",
    capabilities: list[str] | None = None,
    loop_control: dict[str, Any] | None = None,
) -> Path:
    scripts_path = write_scripts_file(tmp_path, scripts)
    model_config: dict[str, Any] = {
        "provider": provider_name,
        "model": "scripted_echo",
        "max_context_size": 100000,
    }
    if capabilities:
        model_config["capabilities"] = capabilities

    config_data: dict[str, Any] = {
        "default_model": model_name,
        "models": {model_name: model_config},
        "providers": {
            provider_name: {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_path)},
            }
        },
    }
    if loop_control:
        config_data["loop_control"] = loop_control

    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config_data), encoding="utf-8")
    return config_path


def build_shell_tool_call(tool_call_id: str, command: str) -> str:
    payload = {
        "id": tool_call_id,
        "name": "Shell",
        "arguments": json.dumps({"command": command}),
    }
    return f"tool_call: {json.dumps(payload)}"


def build_set_todo_call(tool_call_id: str, todos: list[dict[str, str]]) -> str:
    payload = {
        "id": tool_call_id,
        "name": "SetTodoList",
        "arguments": json.dumps({"todos": todos}),
    }
    return f"tool_call: {json.dumps(payload)}"


class LineReader:
    def __init__(self, stream: IO[str]) -> None:
        # Use a background reader so Windows pipes don't rely on select().
        self._stream = stream
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            for line in self._stream:
                self._queue.put(line)
        except Exception:
            self._queue.put(None)
            return
        self._queue.put(None)

    def read_line(self, timeout: float) -> str | None:
        return self._queue.get(timeout=timeout)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._stream.close()
        self._thread.join(timeout=0.5)


@dataclass
class WireProcess:
    process: subprocess.Popen[str]
    reader: LineReader

    def send_json(self, payload: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        line = json.dumps(payload)
        _print_trace("STDIN", line)
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def send_raw(self, line: str) -> None:
        assert self.process.stdin is not None
        _print_trace("STDIN", line)
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def read_json(self, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for wire output")
            try:
                line = self.reader.read_line(timeout=remaining)
            except queue.Empty:
                continue
            if line is None:
                raise EOFError("Wire process closed output stream")
            line = line.strip()
            if not line:
                continue
            _print_trace("STDOUT", line)
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict):
                return msg

    def close(self) -> None:
        if self.process.stdin is not None:
            with contextlib.suppress(Exception):
                self.process.stdin.close()
        self.reader.close()
        if self.process.stdout is not None:
            with contextlib.suppress(Exception):
                self.process.stdout.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def start_wire(
    *,
    config_path: Path | None,
    config_text: str | None,
    work_dir: Path,
    home_dir: Path,
    extra_args: list[str] | None = None,
    yolo: bool = False,
    mcp_config_path: Path | None = None,
    skills_dir: Path | None = None,
    agent_file: Path | None = None,
) -> WireProcess:
    cmd = _wire_base_command()
    if yolo:
        cmd.append("--yolo")
    if config_path is not None:
        cmd.extend(["--config-file", str(config_path)])
    if config_text is not None:
        cmd.extend(["--config", config_text])
    if mcp_config_path is not None:
        cmd.extend(["--mcp-config-file", str(mcp_config_path)])
    if skills_dir is not None:
        cmd.extend(["--skills-dir", str(skills_dir)])
    if agent_file is not None:
        cmd.extend(["--agent-file", str(agent_file)])
    if extra_args:
        cmd.extend(extra_args)
    cmd.extend(["--work-dir", str(work_dir)])

    process = subprocess.Popen(
        cmd,
        cwd=repo_root(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=make_env(home_dir),
    )
    assert process.stdout is not None
    reader = LineReader(process.stdout)
    return WireProcess(process=process, reader=reader)


def send_initialize(
    wire: WireProcess, *, external_tools: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    params: dict[str, Any] = {"protocol_version": "1.1"}
    if external_tools:
        params["external_tools"] = external_tools
    wire.send_json({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": params})
    return read_response(wire, "init")


def read_response(wire: WireProcess, response_id: str) -> dict[str, Any]:
    while True:
        msg = wire.read_json()
        if msg.get("id") == response_id:
            return msg


def collect_until_response(
    wire: WireProcess,
    response_id: str,
    *,
    request_handler: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    messages: list[dict[str, Any]] = []
    while True:
        msg = wire.read_json()
        if msg.get("method") in {"event", "request"}:
            messages.append(msg)
        if msg.get("method") == "request" and request_handler is not None:
            wire.send_json(request_handler(msg))
        if msg.get("id") == response_id:
            return msg, messages


def collect_until_request(
    wire: WireProcess,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    messages: list[dict[str, Any]] = []
    while True:
        msg = wire.read_json()
        if msg.get("method") in {"event", "request"}:
            messages.append(msg)
        if msg.get("method") == "request":
            return msg, messages


def build_approval_response(request_msg: dict[str, Any], response: str) -> dict[str, Any]:
    request_id = request_msg.get("id")
    payload = request_msg.get("params", {}).get("payload", {})
    approval_id = payload.get("id")
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {"request_id": approval_id, "response": response},
    }


def build_tool_result_response(
    request_msg: dict[str, Any],
    *,
    output: str,
    is_error: bool = False,
) -> dict[str, Any]:
    payload = request_msg.get("params", {}).get("payload", {})
    tool_call_id = payload.get("id")
    return {
        "jsonrpc": "2.0",
        "id": request_msg.get("id"),
        "result": {
            "tool_call_id": tool_call_id,
            "return_value": {
                "is_error": is_error,
                "output": output,
                "message": "ok" if not is_error else "error",
                "display": [],
            },
        },
    }


def normalize_value(value: Any, *, replacements: Mapping[str, str] | None = None) -> Any:
    active_replacements = _PATH_REPLACEMENTS if replacements is None else replacements
    if isinstance(value, dict):
        normalized = {
            k: normalize_value(v, replacements=active_replacements) for k, v in value.items()
        }
        normalized = _normalize_shell_display(normalized)
        normalized = _normalize_error_data(normalized)
        normalized = _normalize_tool_result_extras(normalized)
        return normalized
    if isinstance(value, list):
        return [normalize_value(v, replacements=active_replacements) for v in value]
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, str):
        value = _replace_paths(value, active_replacements)
        value = _normalize_line_endings(value)
        value = _normalize_path_separators(value, active_replacements)
        value = _normalize_echo_error_message(value)
        try:
            uuid.UUID(value)
        except (ValueError, AttributeError, TypeError):
            return value
        return "<uuid>"
    return value


def _normalize_shell_display(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("type") != "shell":
        return value
    language = value.get("language")
    if isinstance(language, str) and language.lower() in {"powershell", "pwsh"}:
        value["language"] = "bash"
    return value


def _normalize_error_data(value: dict[str, Any]) -> dict[str, Any]:
    error = value.get("error")
    if isinstance(error, dict) and "data" not in error:
        error["data"] = None
    if "code" in value and "message" in value and "data" not in value:
        value["data"] = None
    return value


def _normalize_tool_result_extras(value: dict[str, Any]) -> dict[str, Any]:
    return_value = value.get("return_value")
    if isinstance(return_value, dict) and "extras" not in return_value:
        return_value["extras"] = None
    return value


def _normalize_line_endings(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _normalize_path_separators(value: str, replacements: Mapping[str, str]) -> str:
    if not replacements:
        return value
    tokens = set(replacements.values())
    if not tokens:
        return value
    if any(token in value for token in tokens):
        return value.replace("\\", "/")
    return value


def _replace_paths(value: str, replacements: Mapping[str, str]) -> str:
    if not replacements:
        return value
    for old, new in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        if old and old in value:
            value = value.replace(old, new)
    return value


def _normalize_echo_error_message(value: str) -> str:
    if not value.startswith("Invalid echo DSL at line") and not value.startswith(
        "Unknown echo DSL kind"
    ):
        return value
    if ": " not in value:
        return value
    prefix, raw = value.rsplit(": ", 1)
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1]
    return f"{prefix}: '{raw}'"


def summarize_messages(
    messages: list[dict[str, Any]], *, replacements: Mapping[str, str] | None = None
) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for msg in messages:
        method = msg.get("method")
        if method not in {"event", "request"}:
            continue
        params = msg.get("params", {})
        entry = {
            "method": method,
            "type": params.get("type"),
            "payload": normalize_value(params.get("payload"), replacements=replacements),
        }
        summary.append(entry)
    return _normalize_message_order(summary)


def _normalize_server_version(value: Any) -> Any:
    """Normalize the server version in initialize response to '<VERSION>'."""
    if isinstance(value, dict):
        value = {k: _normalize_server_version(v) for k, v in value.items()}
        if value.get("name") == "Kimi Code CLI" and "version" in value:
            value = {**value, "version": "<VERSION>"}
    elif isinstance(value, list):
        value = [_normalize_server_version(v) for v in value]
    return value


def normalize_response(
    msg: dict[str, Any], *, replacements: Mapping[str, str] | None = None
) -> dict[str, Any]:
    if "result" in msg:
        result = normalize_value(msg["result"], replacements=replacements)
        result = _normalize_server_version(result)
        return {"result": result}
    if "error" in msg:
        normalized = {"error": normalize_value(msg["error"], replacements=replacements)}
        return _normalize_server_version(normalized)
    return _normalize_server_version(normalize_value(msg, replacements=replacements))


def base_command() -> list[str]:
    override = os.getenv(WIRE_COMMAND_ENV)
    if override is not None:
        override = override.strip()
    parts = shlex.split(override, posix=os.name != "nt") if override else ["uv", "run", "kimi"]
    return [part for part in parts if part != "--wire"]


def _wire_base_command() -> list[str]:
    cmd = base_command()
    if "--wire" not in cmd:
        cmd.append("--wire")
    return cmd


def _normalize_message_order(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = list(messages)
    step_boundaries = {"StepBegin", "TurnBegin", "CompactionBegin"}
    idx = 0
    while idx < len(normalized):
        if normalized[idx].get("type") != "StepBegin":
            idx += 1
            continue
        start = idx
        end = start + 1
        while end < len(normalized):
            msg_type = normalized[end].get("type")
            if msg_type in step_boundaries:
                break
            end += 1
        block = normalized[start:end]
        normalized[start:end] = _normalize_step_block(block)
        idx = end
    return normalized


def _normalize_step_block(block: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not block or block[0].get("type") != "StepBegin":
        return block
    head = block[:1]
    tail = block[1:]
    if not tail:
        return block
    stream_events: list[dict[str, Any]] = []
    status_updates: list[dict[str, Any]] = []
    requests: list[dict[str, Any]] = []
    approvals: list[dict[str, Any]] = []
    tool_results: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    tool_call_order: list[str] = []
    for msg in tail:
        msg_type = msg.get("type")
        method = msg.get("method")
        if msg_type == "ToolCall":
            payload = msg.get("payload")
            tool_call_id = payload.get("id") if isinstance(payload, dict) else None
            if isinstance(tool_call_id, str) and tool_call_id not in tool_call_order:
                tool_call_order.append(tool_call_id)
        if msg_type in {"ContentPart", "ToolCall", "ToolCallPart"}:
            stream_events.append(msg)
        elif msg_type == "StatusUpdate":
            status_updates.append(msg)
        elif method == "request":
            requests.append(msg)
        elif msg_type == "ApprovalResponse":
            approvals.append(msg)
        elif msg_type == "ToolResult":
            tool_results.append(msg)
        else:
            other.append(msg)
    tool_results = _order_tool_results(tool_results, tool_call_order)
    return head + stream_events + status_updates + requests + approvals + tool_results + other


def _order_tool_results(
    tool_results: list[dict[str, Any]], tool_call_order: list[str]
) -> list[dict[str, Any]]:
    if not tool_call_order:
        return tool_results
    by_id: dict[str, list[dict[str, Any]]] = {}
    unknown: list[dict[str, Any]] = []
    for msg in tool_results:
        payload = msg.get("payload")
        tool_call_id = payload.get("tool_call_id") if isinstance(payload, dict) else None
        if isinstance(tool_call_id, str) and tool_call_id in tool_call_order:
            by_id.setdefault(tool_call_id, []).append(msg)
        else:
            unknown.append(msg)
    ordered: list[dict[str, Any]] = []
    for tool_call_id in tool_call_order:
        ordered.extend(by_id.get(tool_call_id, []))
    ordered.extend(unknown)
    return ordered
