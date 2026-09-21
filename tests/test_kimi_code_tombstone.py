"""Tests for the legacy `kimi-code` PyPI package (packages/kimi-code)."""

from __future__ import annotations

import tomllib
from pathlib import Path

import kimi_code
import pytest

KIMI_CODE_PYPROJECT = Path(__file__).parents[1] / "packages" / "kimi-code" / "pyproject.toml"


def test_kimi_code_is_not_an_alias_of_kimi_cli() -> None:
    assert kimi_code.__name__ == "kimi_code"


def test_main_prints_install_instructions_and_fails(capsys: pytest.CaptureFixture[str]) -> None:
    assert kimi_code.main() == 1

    err = capsys.readouterr().err
    assert "NOT the new Kimi Code CLI" in err
    assert "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" in err
    assert "irm https://code.kimi.com/kimi-code/install.ps1 | iex" in err
    assert "https://moonshotai.github.io/kimi-code/en/guides/migration" in err


def test_package_no_longer_installs_legacy_cli() -> None:
    project = tomllib.loads(KIMI_CODE_PYPROJECT.read_text(encoding="utf-8"))["project"]

    assert project["dependencies"] == []
    assert project["scripts"] == {"kimi-code": "kimi_code:main"}
