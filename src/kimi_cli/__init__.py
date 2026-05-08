from __future__ import annotations

from typing import Any, cast


class _LazyLogger:
    """Import loguru only when logging is actually used."""

    def __init__(self) -> None:
        self._logger: Any | None = None

    def _get(self) -> Any:
        if self._logger is None:
            from loguru import logger as real_logger

            # Disable logging by default for library usage.
            # Application entry points (e.g., kimi_cli.cli) should call logger.enable("kimi_cli")
            # to enable logging.
            real_logger.disable("kimi_cli")
            self._logger = real_logger
        return self._logger

    def __getattr__(self, name: str) -> Any:
        return getattr(self._get(), name)


logger = cast(Any, _LazyLogger())

__all__ = ["logger"]
