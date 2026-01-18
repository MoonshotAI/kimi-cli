from __future__ import annotations

from typing import IO, AnyStr

from loguru import logger


class StreamToLogger(IO[str]):
    def __init__(self, level: str = "ERROR"):
        self._level = level

    def write(self, s: AnyStr, /) -> int:
        text = repr(s) if isinstance(s, bytes) else s
        for line in text.rstrip().splitlines():
            logger.opt(depth=1).log(self._level, line.rstrip())
        return len(s)

    def flush(self) -> None:
        pass
