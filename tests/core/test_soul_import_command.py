from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, Mock

from kosong.message import Message

from kimi_cli.soul import slash as soul_slash
from kimi_cli.wire.types import TextPart


def _make_soul(work_dir: Path) -> Mock:
    from kimi_cli.soul.kimisoul import KimiSoul

    soul = Mock(spec=KimiSoul)
    soul.runtime.session.work_dir = work_dir
    soul.runtime.session.id = "soul-session-id"
    soul.context.history = []
    soul.context.token_count = 50
    soul.context.append_message = AsyncMock()
    soul.context.update_token_count = AsyncMock()
    soul.wire_file.append_message = AsyncMock()
    return soul


async def test_import_directory_path_reports_clear_error(tmp_path: Path, monkeypatch) -> None:
    captured: list[TextPart] = []

    def fake_wire_send(message: TextPart) -> None:
        captured.append(message)

    monkeypatch.setattr(soul_slash, "wire_send", fake_wire_send)

    target_dir = tmp_path / "import-dir"
    target_dir.mkdir()

    soul = Mock()
    await soul_slash.import_context(soul, str(target_dir))  # type: ignore[reportGeneralTypeIssues]

    assert len(captured) == 1
    assert "directory" in captured[0].text.lower()
    assert "provide a file" in captured[0].text.lower()


async def test_export_writes_file_and_sends_wire(tmp_path: Path, monkeypatch) -> None:
    captured: list[TextPart] = []

    def fake_wire_send(message: TextPart) -> None:
        captured.append(message)

    monkeypatch.setattr(soul_slash, "wire_send", fake_wire_send)

    soul = _make_soul(tmp_path)
    soul.context.history = [
        Message(role="user", content=[TextPart(text="Hello")]),
        Message(role="assistant", content=[TextPart(text="Hi!")]),
    ]

    output = tmp_path / "export.md"
    await soul_slash.export(soul, str(output))  # type: ignore[reportGeneralTypeIssues]

    assert output.exists()
    content = output.read_text(encoding="utf-8")
    assert "# Kimi Session Export" in content
    assert "Hello" in content

    # Should send export path + sensitive info warning
    assert len(captured) == 2
    assert "Exported 2 messages" in captured[0].text
    assert "sensitive information" in captured[1].text.lower()


async def test_import_file_sends_wire_markers(tmp_path: Path, monkeypatch) -> None:
    captured: list[TextPart] = []

    def fake_wire_send(message: TextPart) -> None:
        captured.append(message)

    monkeypatch.setattr(soul_slash, "wire_send", fake_wire_send)

    soul = _make_soul(tmp_path)
    source = tmp_path / "context.md"
    source.write_text("important context from before", encoding="utf-8")

    await soul_slash.import_context(soul, str(source))  # type: ignore[reportGeneralTypeIssues]

    # Context message appended
    assert soul.context.append_message.await_count == 1
    imported_msg = soul.context.append_message.await_args.args[0]
    assert imported_msg.role == "user"

    # No direct wire_file writes — KimiSoul.run() handles TurnBegin/TurnEnd
    assert soul.wire_file.append_message.await_count == 0

    # Success message sent
    assert len(captured) == 1
    assert "Imported context" in captured[0].text


async def test_import_env_file_sends_warning(tmp_path: Path, monkeypatch) -> None:
    captured: list[TextPart] = []

    def fake_wire_send(message: TextPart) -> None:
        captured.append(message)

    monkeypatch.setattr(soul_slash, "wire_send", fake_wire_send)

    soul = _make_soul(tmp_path)
    env_file = tmp_path / ".env"
    env_file.write_text("API_KEY=secret123", encoding="utf-8")

    await soul_slash.import_context(soul, str(env_file))  # type: ignore[reportGeneralTypeIssues]

    assert len(captured) == 2
    assert "Imported context" in captured[0].text
    assert "secrets" in captured[1].text.lower()
