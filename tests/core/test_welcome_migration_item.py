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
    note = already_installed_text("darwin").plain
    assert "already installed" in note
    assert "which kimi" in note
    # Windows shows the Windows-appropriate verify command
    assert "where kimi" in already_installed_text("win32").plain
