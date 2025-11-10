import types

import click
import pytest

from kimi_cli.cli import _parse_log_level_overrides
from kimi_cli.utils.logging import _ModuleLevelFilter


def _make_record(path: str, level_no: int):
    return {
        "file": types.SimpleNamespace(path=path),
        "module": path.rsplit("/", 1)[-1].split(".")[0],
        "level": types.SimpleNamespace(no=level_no),
    }


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
