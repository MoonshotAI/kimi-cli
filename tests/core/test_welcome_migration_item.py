from __future__ import annotations

from pathlib import Path

from kimi_cli.ui.shell.migration_nudge import (
    already_installed_text,
    kimi_code_installed,
    welcome_card_text,
)


def test_card_when_not_installed(tmp_path: Path):
    assert kimi_code_installed(tmp_path) is False
    assert "/upgrade" in welcome_card_text().plain


def test_note_when_installed(tmp_path: Path):
    (tmp_path / ".kimi-code").mkdir()
    assert kimi_code_installed(tmp_path) is True
    assert "already installed" in already_installed_text().plain
