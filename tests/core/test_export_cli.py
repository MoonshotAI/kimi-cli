from __future__ import annotations

import asyncio
import zipfile
from pathlib import Path

import pytest
from kaos.path import KaosPath
from kosong.message import Message
from typer.testing import CliRunner

from kimi_cli.cli import cli
from kimi_cli.cli.export import _format_message_timestamp
from kimi_cli.metadata import load_metadata, save_metadata
from kimi_cli.session import Session
from kimi_cli.wire.types import TextPart, TurnBegin


@pytest.fixture
def isolated_share_dir(monkeypatch, tmp_path: Path) -> Path:
    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir() -> Path:
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.share.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    return share_dir


@pytest.fixture
def work_dir(tmp_path: Path) -> KaosPath:
    path = tmp_path / "work"
    path.mkdir()
    return KaosPath.unsafe_from_local_path(path)


def _write_context_message(context_file: Path, text: str) -> None:
    message = Message(role="user", content=[TextPart(text=text)])
    context_file.write_text(message.model_dump_json(exclude_none=True) + "\n", encoding="utf-8")


async def _create_previous_session(work_dir: KaosPath) -> tuple[Session, float]:
    session = await Session.create(work_dir)
    _write_context_message(session.context_file, "export me")

    first_ts = 1_700_000_000.0
    last_ts = 1_700_000_100.0
    await session.wire_file.append_message(
        TurnBegin(user_input=[TextPart(text="previous export target")]),
        timestamp=first_ts,
    )
    await session.wire_file.append_message(
        TurnBegin(user_input=[TextPart(text="latest user message")]),
        timestamp=last_ts,
    )
    await session.refresh()

    metadata = load_metadata()
    work_dir_meta = metadata.get_work_dir_meta(work_dir)
    assert work_dir_meta is not None
    work_dir_meta.last_session_id = session.id
    save_metadata(metadata)

    return session, last_ts


def test_export_previous_session_requires_confirmation(
    isolated_share_dir: Path, work_dir: KaosPath, tmp_path: Path
) -> None:
    session, last_ts = asyncio.run(_create_previous_session(work_dir))
    output = tmp_path / "previous.zip"

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(work_dir), "export", "--output", str(output)],
        input="n\n",
    )

    assert result.exit_code == 0, result.output
    assert "About to export the previous session for this working directory:" in result.output
    assert f"Work dir: {work_dir}" in result.output
    assert f"Session ID: {session.id}" in result.output
    assert "Title: previous export target" in result.output
    assert f"Last user message: {_format_message_timestamp(last_ts)}" in result.output
    assert "Export cancelled." in result.output
    assert not output.exists()


def test_export_previous_session_after_confirmation(
    isolated_share_dir: Path, work_dir: KaosPath, tmp_path: Path
) -> None:
    session, last_ts = asyncio.run(_create_previous_session(work_dir))
    output = tmp_path / "confirmed.zip"

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(work_dir), "export", "--output", str(output)],
        input="y\n",
    )

    assert result.exit_code == 0, result.output
    assert f"Session ID: {session.id}" in result.output
    assert f"Last user message: {_format_message_timestamp(last_ts)}" in result.output
    assert str(output) in result.output
    assert output.exists()

    with zipfile.ZipFile(output) as zf:
        names = set(zf.namelist())
        assert "context.jsonl" in names
        assert "wire.jsonl" in names
        assert "manifest.json" in names


def test_export_previous_session_can_skip_confirmation_with_yes(
    isolated_share_dir: Path, work_dir: KaosPath, tmp_path: Path
) -> None:
    asyncio.run(_create_previous_session(work_dir))
    output = tmp_path / "skip-confirm.zip"

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(work_dir), "export", "--yes", "--output", str(output)],
    )

    assert result.exit_code == 0, result.output
    assert "About to export the previous session" not in result.output
    assert "Export this session?" not in result.output
    assert output.exists()


def test_export_explicit_session_id_skips_confirmation(
    isolated_share_dir: Path, work_dir: KaosPath, tmp_path: Path
) -> None:
    session, _ = asyncio.run(_create_previous_session(work_dir))
    output = tmp_path / "explicit.zip"

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(work_dir), "export", "--output", str(output), session.id],
    )

    assert result.exit_code == 0, result.output
    assert "About to export the previous session" not in result.output
    assert "Export this session?" not in result.output
    assert output.exists()


def test_export_explicit_session_id_accepts_options_after_argument(
    isolated_share_dir: Path, work_dir: KaosPath, tmp_path: Path
) -> None:
    session, _ = asyncio.run(_create_previous_session(work_dir))
    output = tmp_path / "explicit-after.zip"

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(work_dir), "export", session.id, "--output", str(output)],
    )

    assert result.exit_code == 0, result.output
    assert output.exists()


def test_export_previous_session_errors_when_missing(
    isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    result = CliRunner().invoke(cli, ["--work-dir", str(work_dir), "export"])

    assert result.exit_code == 1
    assert "Error: no previous session found for the working directory." in result.output


def test_export_help_is_leaf_command() -> None:
    result = CliRunner().invoke(cli, ["export", "--help"])

    assert result.exit_code == 0, result.output
    assert "Usage: root export [OPTIONS] [SESSION_ID]" in result.output
    assert "COMMAND [ARGS]..." not in result.output
