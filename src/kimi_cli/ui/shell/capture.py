"""Shared utilities for shell output capture, cleaning, and context injection.

Both Ctrl+X shell mode and the ``!`` prefix route through these functions
so there is a single implementation for output cleaning, truncation, and
context injection.
"""

from __future__ import annotations

import fcntl
import os
import re
import sys
import termios
from collections.abc import Callable, Coroutine
from typing import Any

import asyncio

from kosong.message import Message
from rich.text import Text

from kimi_cli import logger
from kimi_cli.soul.message import system_reminder

SHELL_OUTPUT_MAX_BYTES = 50_000
"""Maximum bytes of shell output to inject into context."""

_CAPTURE_HARD_LIMIT = 2 * SHELL_OUTPUT_MAX_BYTES
"""Hard cap on in-memory capture to prevent unbounded growth from binary / infinite output."""


# ---------------------------------------------------------------------------
# Output cleaning
# ---------------------------------------------------------------------------

def clean_output(raw: str) -> str:
    """Strip ANSI escapes and resolve carriage-return overwrites.

    Processing order:
    1. Normalise ``\\r\\n`` → ``\\n`` (terminal / ``script`` line endings).
    2. Strip C0 control characters (``\\x00``–``\\x08``, ``\\x0e``–``\\x1f``)
       except ``\\n``, ``\\r``, ``\\t`` which carry meaning.
    3. Resolve standalone ``\\r`` overwrites (``"50%\\r100%"`` → ``"100%"``).
    4. Let ``rich.text.Text.from_ansi`` strip SGR / CSI / OSC sequences.
    """
    # 1. Normalise line endings
    text = raw.replace("\r\n", "\n")

    # 2. Strip troublesome C0 control chars (e.g. \x08 backspace).
    #    Preserve \x1b (ESC) so ANSI sequences survive until step 4.
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]", "", text)

    # 3. Resolve \r overwrites
    lines: list[str] = []
    for line in text.split("\n"):
        parts = line.split("\r")
        if len(parts) > 1:
            line = parts[-1]
        lines.append(line)
    text = "\n".join(lines)

    # 4. Strip ANSI via rich
    return Text.from_ansi(text).plain


# ---------------------------------------------------------------------------
# PTY-based execution with capture
# ---------------------------------------------------------------------------

async def execute_with_pty_capture(
    command: str,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> tuple[int | None, str]:
    """Run *command* in a pseudo-terminal, teeing output to the real terminal.

    The subprocess's **stdin** is inherited (the real terminal) so interactive
    input works.  **stdout** and **stderr** are routed through a PTY so that
    programs see ``isatty() == True`` and produce coloured / formatted output.
    We read from the PTY master and write every chunk to the real stdout *and*
    an in-memory buffer.

    Returns ``(exit_code, raw_output)``.
    """
    master_fd, slave_fd = os.openpty()

    # Match PTY size to real terminal so columnar output renders correctly.
    try:
        ws = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\x00" * 8)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, ws)
    except OSError:
        pass

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            cwd=cwd,
        )
    except Exception:
        os.close(master_fd)
        raise
    finally:
        # Parent no longer needs slave fd after subprocess inherits it.
        # On success the child owns a dup; on failure the except branch
        # already closed master_fd so we only need to close slave_fd here.
        os.close(slave_fd)

    # Save terminal state so we can restore it if the child corrupts it.
    stdin_fd = sys.stdin.fileno()
    saved_termios: list[Any] | None = None
    try:
        saved_termios = termios.tcgetattr(stdin_fd)
    except (OSError, termios.error):
        pass

    loop = asyncio.get_running_loop()
    captured: list[bytes] = []
    captured_bytes = 0
    eof_event = asyncio.Event()

    try:
        stdout_fd = sys.stdout.fileno()
    except (AttributeError, OSError):
        stdout_fd = 1  # fallback

    def _on_master_readable() -> None:
        nonlocal captured_bytes
        try:
            data = os.read(master_fd, 4096)
        except OSError:
            loop.remove_reader(master_fd)
            eof_event.set()
            return
        if data:
            try:
                os.write(stdout_fd, data)
            except OSError:
                pass
            # Cap in-memory capture to avoid unbounded growth (e.g. `cat /dev/urandom`).
            # We keep the tail, which is usually more informative.
            if captured_bytes < _CAPTURE_HARD_LIMIT:
                captured.append(data)
                captured_bytes += len(data)
        else:
            loop.remove_reader(master_fd)
            eof_event.set()

    loop.add_reader(master_fd, _on_master_readable)

    try:
        await proc.wait()
        # Drain any remaining buffered output after process exits.
        try:
            await asyncio.wait_for(eof_event.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            pass
    except KeyboardInterrupt:
        # Forward SIGINT to child if it is still running.
        if proc.returncode is None:
            proc.send_signal(2)  # SIGINT
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                proc.kill()
    finally:
        loop.remove_reader(master_fd)
        os.close(master_fd)
        # Restore terminal state unconditionally.
        if saved_termios is not None:
            try:
                termios.tcsetattr(stdin_fd, termios.TCSAFLUSH, saved_termios)
            except (OSError, termios.error):
                pass

    raw = b"".join(captured).decode("utf-8", errors="replace")
    return proc.returncode, raw


# ---------------------------------------------------------------------------
# PIPE-based execution with tee (for ``!`` prefix / non-TTY contexts)
# ---------------------------------------------------------------------------

async def execute_with_pipe_capture(
    command: str,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> tuple[int | None, str]:
    """Run *command* with PIPE capture, printing output as it arrives.

    Simpler than PTY — programs won't see a TTY, so colours are lost.
    Suitable for the ``!`` prefix where TTY fidelity is less important.

    Returns ``(exit_code, raw_output)``.
    """
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
        cwd=cwd,
    )
    assert proc.stdout is not None
    chunks: list[bytes] = []
    captured_bytes = 0
    while True:
        chunk = await proc.stdout.read(4096)
        if not chunk:
            break
        try:
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        except (OSError, AttributeError):
            pass
        if captured_bytes < _CAPTURE_HARD_LIMIT:
            chunks.append(chunk)
            captured_bytes += len(chunk)
    await proc.wait()
    raw = b"".join(chunks).decode("utf-8", errors="replace")
    return proc.returncode, raw


# ---------------------------------------------------------------------------
# Context injection
# ---------------------------------------------------------------------------

async def inject_to_context(
    append_message: Callable[[Message], Coroutine[Any, Any, None]],
    command: str,
    raw_output: str,
    exit_code: int | None,
) -> None:
    """Build a context message from shell output and append it.

    The caller provides an ``append_message`` callback (e.g.
    ``soul.context.append_message``) so this module stays decoupled from
    any specific soul / context implementation.

    The output is cleaned, truncated, wrapped in ``<system-reminder>``, and
    appended as a user message.
    """
    output = clean_output(raw_output)

    # Truncate, keeping the tail (usually more informative).
    truncated = False
    encoded = output.encode("utf-8")
    if len(encoded) > SHELL_OUTPUT_MAX_BYTES:
        output = encoded[-SHELL_OUTPUT_MAX_BYTES:].decode("utf-8", errors="replace")
        truncated = True

    status = f"exit code {exit_code}" if exit_code is not None else "unknown exit code"
    parts = [
        f"The user ran a shell command in shell mode ({status}).",
        "This is output from a command the user ran directly, not from the AI.",
        "The output may be useful context for subsequent requests.",
    ]
    if truncated:
        parts.append(f"(Output truncated to last {SHELL_OUTPUT_MAX_BYTES} bytes)")

    header = " ".join(parts)
    body = f"$ {command}\n{output}"

    message = Message(
        role="user",
        content=[system_reminder(f"{header}\n\n{body}")],
    )
    await append_message(message)
