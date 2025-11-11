import types
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import click
import pytest

from kimi_cli.cli import _parse_log_level_overrides
from kimi_cli.utils.logging import _ModuleLevelFilter

if TYPE_CHECKING:
    from loguru import Record
else:  # pragma: no cover - typing fallback
    Record = dict[str, Any]  # type: ignore[assignment]


def _make_record(path: str, level_no: int) -> "Record":
    module = Path(path).stem
    return cast(
        Record,
        {
            "elapsed": timedelta(),
            "exception": None,
            "extra": {},
            "file": types.SimpleNamespace(path=path, name=Path(path).name),
            "function": "func",
            "level": types.SimpleNamespace(name="X", no=level_no, icon=""),
            "line": 0,
            "message": "",
            "module": module,
            "name": None,
            "process": types.SimpleNamespace(id=0, name="proc"),
            "thread": types.SimpleNamespace(id=0, name="thread"),
            "time": datetime.now(),
        },
    )


def test_parse_log_level_overrides_accepts_default_and_modules():
    overrides = _parse_log_level_overrides(
        (
            "debug",
            " kimi_cli.tools = warning ",
            "kosong=TRACE",
        )
    )
    assert overrides == {
        "default": "debug",
        "kimi_cli.tools": "warning",
        "kosong": "TRACE",
    }


def test_parse_log_level_overrides_is_case_insensitive():
    overrides = _parse_log_level_overrides(("KIMI_CLI.Tools=info",))
    assert overrides == {"kimi_cli.tools": "info"}


def test_parse_log_level_overrides_rejects_missing_module():
    with pytest.raises(click.BadOptionUsage):
        _parse_log_level_overrides(("=INFO",))


def test_module_level_filter_prefers_more_specific_prefix():
    levels = {
        "default": 30,
        "kimi_cli.tools": 20,
        "kimi_cli.tools.file": 10,
    }
    module_filter = _ModuleLevelFilter(levels)

    record = _make_record("/tmp/src/kimi_cli/tools/file/grep.py", 15)
    assert module_filter(record) is True  # threshold 10

    record_low = _make_record("/tmp/src/kimi_cli/tools/file/grep.py", 5)
    assert module_filter(record_low) is False

    record_default = _make_record("/tmp/src/kimi_cli/ui/app.py", 25)
    assert module_filter(record_default) is False  # default threshold 30


def test_module_level_filter_is_case_insensitive():
    levels = {
        "default": 30,
        "kimi_cli.tools": 20,
    }
    module_filter = _ModuleLevelFilter(levels)
    record = _make_record("/tmp/src/KIMI_CLI/Tools/file/grep.py", 25)
    assert module_filter(record) is True
