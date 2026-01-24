from __future__ import annotations

import contextlib
import os
import sys
import threading

from loguru import logger


class StderrRedirector:
    def __init__(self, level: str = "ERROR") -> None:
        self._level = level
        self._installed = False
        self._lock = threading.Lock()
        self._read_fd: int | None = None
        self._thread: threading.Thread | None = None

    def install(self) -> None:
        with self._lock:
            if self._installed:
                return
            with contextlib.suppress(Exception):
                sys.stderr.flush()
            read_fd, write_fd = os.pipe()
            os.dup2(write_fd, 2)
            os.close(write_fd)
            self._read_fd = read_fd
            self._thread = threading.Thread(
                target=self._drain, name="kimi-stderr-redirect", daemon=True
            )
            self._thread.start()
            self._installed = True

    def _drain(self) -> None:
        buffer = ""
        read_fd = self._read_fd
        if read_fd is None:
            return
        try:
            while True:
                chunk = os.read(read_fd, 4096)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    self._log_line(line)
        except Exception:
            logger.exception("Failed to read redirected stderr")
        finally:
            if buffer:
                self._log_line(buffer)
            with contextlib.suppress(OSError):
                os.close(read_fd)

    def _log_line(self, line: str) -> None:
        text = line.rstrip("\r")
        if not text:
            return
        logger.opt(depth=2).log(self._level, text)


_stderr_redirector: StderrRedirector | None = None


def redirect_stderr_to_logger(level: str = "ERROR") -> None:
    global _stderr_redirector
    if _stderr_redirector is None:
        _stderr_redirector = StderrRedirector(level=level)
    _stderr_redirector.install()
