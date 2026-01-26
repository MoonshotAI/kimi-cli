from __future__ import annotations

import contextlib
import json
import os
import queue
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

TRACE_ENV = "KIMI_TEST_TRACE"
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
    return env


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
    cmd = ["uv", "run", "kimi", "--wire"]
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
        return _normalize_shell_display(normalized)
    if isinstance(value, list):
        return [normalize_value(v, replacements=active_replacements) for v in value]
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, str):
        value = _replace_paths(value, active_replacements)
        value = _normalize_line_endings(value)
        value = _normalize_path_separators(value, active_replacements)
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
    return summary


def normalize_response(
    msg: dict[str, Any], *, replacements: Mapping[str, str] | None = None
) -> dict[str, Any]:
    if "result" in msg:
        return {"result": normalize_value(msg["result"], replacements=replacements)}
    if "error" in msg:
        return {"error": normalize_value(msg["error"], replacements=replacements)}
    return normalize_value(msg, replacements=replacements)
