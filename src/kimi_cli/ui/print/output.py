import builtins
import sys
from typing import Any, TextIO, cast

from rich.console import Console


def _encode_for_stream(text: str, stream: TextIO) -> str:
    encoding = getattr(stream, "encoding", None)
    if encoding is None:
        return text

    try:
        return text.encode(encoding, errors="replace").decode(encoding, errors="replace")
    except (LookupError, UnicodeError):
        return text.encode("ascii", errors="replace").decode("ascii")


class EncodingSafeStream:
    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    @property
    def encoding(self) -> str | None:
        return getattr(self._stream, "encoding", None)

    def write(self, text: str) -> int:
        return self._stream.write(_encode_for_stream(text, self._stream))

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def safe_print(text: str) -> None:
    """Print text while replacing characters unsupported by stdout's encoding."""
    builtins.print(_encode_for_stream(text, sys.stdout), flush=True)


def safe_rich_print(text: str) -> None:
    """Render Rich text through the same encoding-safe stdout as visualizers."""
    Console(file=cast(TextIO, EncodingSafeStream(sys.stdout))).print(text)
