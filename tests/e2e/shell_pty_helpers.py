from __future__ import annotations

import contextlib
import errno
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tests_e2e.wire_helpers import TRACE_ENV, make_env, repo_root
from tests_e2e.wire_helpers import make_home_dir as _make_home_dir
from tests_e2e.wire_helpers import make_work_dir as _make_work_dir
from tests_e2e.wire_helpers import write_scripted_config as write_scripted_config

DEFAULT_TIMEOUT = 15.0
PROMPT_SYMBOL = "✨"
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
OTHER_ESCAPE_RE = re.compile(r"\x1b[@-_]")


def _print_trace(label: str, text: str) -> None:
    if os.getenv(TRACE_ENV) == "1":
        print("-----")
        print(f"{label}: {text}")


def make_home_dir(tmp_path: Path) -> Path:
    return _make_home_dir(tmp_path)


def make_work_dir(tmp_path: Path) -> Path:
    return _make_work_dir(tmp_path)


def _normalize_terminal_text(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = text.replace("\r", "\n")
    text = OSC_RE.sub("", text)
    text = CSI_RE.sub("", text)
    text = OTHER_ESCAPE_RE.sub("", text)
    text = text.replace("\x00", "")
    text = text.replace("\x08", "")
    return text


def _set_window_size(fd: int, *, columns: int, lines: int) -> None:
    packed = struct.pack("HHHH", lines, columns, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _preexec_for_tty(slave_fd: int):
    def _run() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    return _run


@dataclass
class ShellPTYProcess:
    process: subprocess.Popen[bytes]
    master_fd: int
    _raw_chunks: list[bytes] = field(default_factory=list)

    def normalized_text(self) -> str:
        return _normalize_terminal_text(self.raw_text())

    def raw_text(self) -> str:
        return b"".join(self._raw_chunks).decode("utf-8", errors="replace")

    def mark(self) -> int:
        return len(self.normalized_text())

    def _append_output(self, chunk: bytes) -> None:
        if not chunk:
            return
        self._raw_chunks.append(chunk)
        _print_trace("STDOUT", chunk.decode("utf-8", errors="replace"))

    def read_available(self, timeout: float = 0.1) -> bytes:
        ready, _, _ = select.select([self.master_fd], [], [], timeout)
        if not ready:
            return b""
        try:
            chunk = os.read(self.master_fd, 4096)
        except OSError as exc:
            if exc.errno == errno.EIO:
                return b""
            raise
        self._append_output(chunk)
        return chunk

    def read_until_contains(
        self, text: str, *, timeout: float = DEFAULT_TIMEOUT, after: int = 0
    ) -> str:
        deadline = time.monotonic() + timeout
        while True:
            normalized = self.normalized_text()
            if text in normalized[after:]:
                return normalized
            if self.process.poll() is not None:
                # Drain any final PTY output before failing.
                while self.read_available(timeout=0.01):
                    normalized = self.normalized_text()
                    if text in normalized[after:]:
                        return normalized
                raise AssertionError(
                    f"Missing {text!r} before process exit.\n"
                    f"Return code: {self.process.returncode}\n"
                    f"Normalized transcript:\n{self.normalized_text()}\n"
                    f"Raw transcript:\n{self.raw_text()}"
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"Timed out waiting for {text!r}.\n"
                    f"Normalized transcript:\n{self.normalized_text()}\n"
                    f"Raw transcript:\n{self.raw_text()}"
                )
            self.read_available(timeout=min(0.2, remaining))

    def send_text(self, text: str) -> None:
        _print_trace("STDIN", text)
        os.write(self.master_fd, text.encode("utf-8"))

    def send_key(self, key: str) -> None:
        key_map = {
            "enter": b"\r",
            "escape": b"\x1b",
            "tab": b"\t",
            "s_tab": b"\x1b[Z",
            "up": b"\x1b[A",
            "down": b"\x1b[B",
            "left": b"\x1b[D",
            "right": b"\x1b[C",
            "ctrl_c": b"\x03",
            "ctrl_d": b"\x04",
            "ctrl_x": b"\x18",
        }
        payload = key_map.get(key)
        if payload is None:
            if len(key) != 1:
                raise ValueError(f"Unsupported key: {key}")
            payload = key.encode("utf-8")
        _print_trace("STDIN", repr(payload))
        os.write(self.master_fd, payload)

    def send_line(self, text: str) -> None:
        if text:
            self.send_text(text)
        self.send_key("enter")

    def wait(self, timeout: float = DEFAULT_TIMEOUT) -> int:
        deadline = time.monotonic() + timeout
        while True:
            result = self.process.poll()
            if result is not None:
                while self.read_available(timeout=0.01):
                    pass
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    "Timed out waiting for shell process to exit.\n"
                    f"Normalized transcript:\n{self.normalized_text()}\n"
                    f"Raw transcript:\n{self.raw_text()}"
                )
            self.read_available(timeout=min(0.2, remaining))

    def wait_for_quiet(
        self, *, timeout: float = 1.0, quiet_period: float = 0.2, after: int = 0
    ) -> str:
        deadline = time.monotonic() + timeout
        while True:
            if time.monotonic() >= deadline:
                raise AssertionError(
                    "Timed out waiting for terminal output to settle.\n"
                    f"Normalized transcript:\n{self.normalized_text()}\n"
                    f"Raw transcript:\n{self.raw_text()}"
                )
            chunk = self.read_available(timeout=quiet_period)
            if not chunk:
                return self.normalized_text()[after:]

    def close(self) -> None:
        with contextlib.suppress(Exception):
            os.close(self.master_fd)
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)


def start_shell_pty(
    *,
    config_path: Path,
    work_dir: Path,
    home_dir: Path,
    yolo: bool,
    extra_args: list[str] | None = None,
    columns: int = 120,
    lines: int = 40,
) -> ShellPTYProcess:
    master_fd, slave_fd = pty.openpty()
    _set_window_size(master_fd, columns=columns, lines=lines)
    _set_window_size(slave_fd, columns=columns, lines=lines)
    os.set_blocking(master_fd, False)

    env = make_env(home_dir)
    env["KIMI_CLI_NO_AUTO_UPDATE"] = "1"
    env["COLUMNS"] = str(columns)
    env["LINES"] = str(lines)
    env["TERM"] = "xterm-256color"
    env["PYTHONUTF8"] = "1"
    env["PROMPT_TOOLKIT_NO_CPR"] = "1"
    env.pop("NO_COLOR", None)

    cmd = [sys.executable, "-m", "kimi_cli.cli"]
    if yolo:
        cmd.append("--yolo")
    cmd.extend(["--config-file", str(config_path), "--work-dir", str(work_dir)])
    if extra_args:
        cmd.extend(extra_args)

    process = subprocess.Popen(
        cmd,
        cwd=repo_root(),
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        preexec_fn=_preexec_for_tty(slave_fd),
        close_fds=True,
    )
    os.close(slave_fd)
    return ShellPTYProcess(process=process, master_fd=master_fd)


def find_session_dir(home_dir: Path, work_dir: Path) -> Path:
    path_md5 = hashlib.md5(str(work_dir.resolve()).encode("utf-8")).hexdigest()
    sessions_root = home_dir / ".kimi" / "sessions" / path_md5
    session_dirs = [path for path in sessions_root.iterdir() if path.is_dir()]
    if len(session_dirs) != 1:
        raise AssertionError(f"Expected exactly one session dir, got {session_dirs!r}")
    return session_dirs[0]


def find_tool_result_output(home_dir: Path, work_dir: Path, tool_call_id: str) -> Any:
    session_dir = find_session_dir(home_dir, work_dir)
    wire_path = session_dir / "wire.jsonl"
    with wire_path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("type") == "metadata":
                continue
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            if message.get("type") != "ToolResult":
                continue
            payload = message.get("payload", {})
            if not isinstance(payload, dict):
                continue
            if payload.get("tool_call_id") != tool_call_id:
                continue
            return_value = payload.get("return_value", {})
            if not isinstance(return_value, dict):
                continue
            return return_value.get("output")
    raise AssertionError(f"Missing ToolResult output for tool call {tool_call_id!r}")


def list_turn_begin_inputs(home_dir: Path, work_dir: Path) -> list[str]:
    session_dir = find_session_dir(home_dir, work_dir)
    wire_path = session_dir / "wire.jsonl"
    inputs: list[str] = []
    with wire_path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("type") == "metadata":
                continue
            message = record.get("message")
            if not isinstance(message, dict) or message.get("type") != "TurnBegin":
                continue
            payload = message.get("payload", {})
            if not isinstance(payload, dict):
                continue
            user_input = payload.get("user_input")
            if isinstance(user_input, str):
                inputs.append(user_input)
                continue
            if isinstance(user_input, list):
                text_parts = []
                for part in user_input:
                    if isinstance(part, dict) and part.get("type") == "text":
                        text = part.get("text")
                        if isinstance(text, str):
                            text_parts.append(text)
                inputs.append("".join(text_parts))
    return inputs


def count_wire_messages(home_dir: Path, work_dir: Path, message_type: str) -> int:
    session_dir = find_session_dir(home_dir, work_dir)
    wire_path = session_dir / "wire.jsonl"
    count = 0
    with wire_path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("type") == "metadata":
                continue
            message = record.get("message")
            if isinstance(message, dict) and message.get("type") == message_type:
                count += 1
    return count


def wait_for_wire_message_count(
    home_dir: Path,
    work_dir: Path,
    *,
    message_type: str,
    expected_count: int,
    timeout: float = DEFAULT_TIMEOUT,
) -> None:
    deadline = time.monotonic() + timeout
    last_count = 0
    while True:
        with contextlib.suppress(FileNotFoundError):
            last_count = count_wire_messages(home_dir, work_dir, message_type)
            if last_count >= expected_count:
                return
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"Timed out waiting for {message_type} count >= {expected_count}. "
                f"Observed count: {last_count}."
            )
        time.sleep(0.05)


def read_until_prompt_ready(
    shell: ShellPTYProcess,
    *,
    after: int,
    timeout: float = DEFAULT_TIMEOUT,
    quiet_period: float = 0.2,
) -> str:
    shell.read_until_contains(PROMPT_SYMBOL, after=after, timeout=timeout)
    shell.wait_for_quiet(timeout=timeout, quiet_period=quiet_period, after=after)
    return shell.normalized_text()
