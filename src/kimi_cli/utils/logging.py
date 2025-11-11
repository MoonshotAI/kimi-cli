from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from loguru import Record
else:  # pragma: no cover - runtime fallback for typing-only import
    Record = dict[str, Any]  # type: ignore[assignment]

MODULE_ROOTS = ("kimi_cli", "kosong")
DEFAULT_LEVEL_KEY = "default"

logger.remove()


def configure_file_logging(
    log_file: Path,
    *,
    base_level: str,
    module_levels: Mapping[str, str] | None = None,
    rotation: str = "06:00",
    retention: str = "10 days",
) -> None:
    """Configure the global loguru logger with per-module filtering."""

    logger.remove()
    log_file.parent.mkdir(parents=True, exist_ok=True)
    normalized_levels = _normalize_levels(module_levels or {}, base_level)
    module_filter = _ModuleLevelFilter(normalized_levels)
    logger.add(
        log_file,
        level="TRACE",  # capture everything, filter decides what to keep
        rotation=rotation,
        retention=retention,
        filter=module_filter,
    )
    logger.debug("Configured log levels: {levels}", levels=normalized_levels)


def _normalize_levels(levels: Mapping[str, str], base_level: str) -> dict[str, int]:
    normalized: dict[str, int] = {}
    for module, level_name in levels.items():
        key = module.strip().rstrip(".").lower() or DEFAULT_LEVEL_KEY
        if key == DEFAULT_LEVEL_KEY:
            key = DEFAULT_LEVEL_KEY
        normalized[key] = _level_to_no(level_name)
    if DEFAULT_LEVEL_KEY not in normalized:
        normalized[DEFAULT_LEVEL_KEY] = _level_to_no(base_level)
    return normalized


def _level_to_no(level_name: str) -> int:
    normalized = level_name.strip().upper()
    try:
        return logger.level(normalized).no
    except ValueError as exc:  # pragma: no cover - loguru raises ValueError
        raise ValueError(f"Invalid log level '{level_name}'") from exc


class _ModuleLevelFilter:
    """Filter that enforces module-specific log levels."""

    def __init__(self, levels: Mapping[str, int]) -> None:
        self._levels = dict(levels)
        self._module_keys = sorted(
            (key for key in self._levels if key != DEFAULT_LEVEL_KEY),
            key=len,
            reverse=True,
        )

    def __call__(self, record: Record) -> bool:
        module_path = self._derive_module_path(record)
        threshold = self._resolve_threshold(module_path)
        return record["level"].no >= threshold

    def _resolve_threshold(self, module_path: str | None) -> int:
        if module_path:
            for key in self._module_keys:
                if module_path == key or module_path.startswith(f"{key}."):
                    return self._levels[key]
        return self._levels[DEFAULT_LEVEL_KEY]

    @staticmethod
    def _derive_module_path(record: Record) -> str | None:
        file_info = record.get("file")
        path_str = getattr(file_info, "path", None)
        if not path_str:
            return None
        path = Path(path_str)
        module_parts = path.with_suffix("").parts
        for idx, part in enumerate(module_parts):
            if part.lower() in MODULE_ROOTS:
                return ".".join(module_parts[idx:]).lower()
        module_name = record.get("module")
        return module_name.lower() if module_name else None


class StreamToLogger(IO[str]):
    def __init__(self, level: str = "ERROR"):
        self._level = level

    def write(self, buffer: str) -> int:
        for line in buffer.rstrip().splitlines():
            logger.opt(depth=1).log(self._level, line.rstrip())
        return len(buffer)

    def flush(self) -> None:
        pass
