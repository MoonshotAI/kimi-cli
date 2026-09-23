"""Tests for project-level MCP config loading (.kimi/mcp.json)."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from typer.testing import CliRunner

from kimi_cli.cli import cli
from kimi_cli.cli.mcp import collect_file_mcp_configs, get_project_mcp_config_file

# ---------------------------------------------------------------------------
# get_project_mcp_config_file
# ---------------------------------------------------------------------------


def test_get_project_mcp_config_file_returns_path_when_exists(tmp_path: Path) -> None:
    mcp_file = tmp_path / ".kimi" / "mcp.json"
    mcp_file.parent.mkdir(parents=True)
    mcp_file.write_text("{}", encoding="utf-8")

    result = get_project_mcp_config_file(tmp_path)

    assert result == mcp_file


def test_get_project_mcp_config_file_returns_none_when_missing(tmp_path: Path) -> None:
    result = get_project_mcp_config_file(tmp_path)
    assert result is None


# ---------------------------------------------------------------------------
# collect_file_mcp_configs
# ---------------------------------------------------------------------------


def test_collect_merge_includes_global_and_project(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    work_dir = tmp_path / "work"
    work_dir.mkdir()
    project_mcp = work_dir / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"p": {"command": "p"}}}))

    configs = collect_file_mcp_configs("merge", work_dir=work_dir)

    assert len(configs) == 2
    assert configs[0]["mcpServers"]["g"]["command"] == "g"
    assert configs[1]["mcpServers"]["p"]["command"] == "p"


def test_collect_merge_project_overrides_global_duplicate(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"srv": {"command": "g"}}}))

    work_dir = tmp_path / "work"
    work_dir.mkdir()
    project_mcp = work_dir / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"srv": {"command": "p"}}}))

    configs = collect_file_mcp_configs("merge", work_dir=work_dir)

    # In merge mode both configs are returned; the toolset will overwrite duplicates
    assert len(configs) == 2
    assert configs[0]["mcpServers"]["srv"]["command"] == "g"
    assert configs[1]["mcpServers"]["srv"]["command"] == "p"


def test_collect_override_uses_only_project_when_present(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    work_dir = tmp_path / "work"
    work_dir.mkdir()
    project_mcp = work_dir / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"p": {"command": "p"}}}))

    configs = collect_file_mcp_configs("override", work_dir=work_dir)

    assert len(configs) == 1
    assert configs[0]["mcpServers"]["p"]["command"] == "p"


def test_collect_override_fallback_to_global_when_no_project(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    work_dir = tmp_path / "work"
    work_dir.mkdir()

    configs = collect_file_mcp_configs("override", work_dir=work_dir)

    assert len(configs) == 1
    assert configs[0]["mcpServers"]["g"]["command"] == "g"


def test_collect_override_prefers_explicit_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    work_dir = tmp_path / "work"
    work_dir.mkdir()
    project_mcp = work_dir / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"p": {"command": "p"}}}))

    explicit = tmp_path / "exp.json"
    explicit.write_text(json.dumps({"mcpServers": {"e": {"command": "e"}}}))

    configs = collect_file_mcp_configs("override", work_dir=work_dir, explicit_files=[explicit])

    assert len(configs) == 1
    assert configs[0]["mcpServers"]["e"]["command"] == "e"


def test_collect_merge_includes_explicit_and_raw_on_top(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    work_dir = tmp_path / "work"
    work_dir.mkdir()

    explicit = tmp_path / "exp.json"
    explicit.write_text(json.dumps({"mcpServers": {"e": {"command": "e"}}}))

    configs = collect_file_mcp_configs(
        "merge",
        work_dir=work_dir,
        explicit_files=[explicit],
        raw_jsons=[json.dumps({"mcpServers": {"r": {"command": "r"}}})],
    )

    assert len(configs) == 3
    names = [list(c["mcpServers"].keys())[0] for c in configs]
    assert names == ["g", "e", "r"]


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------


def _patch_kimi_cli_create(monkeypatch):
    """Patch KimiCLI.create to capture mcp_configs without doing real I/O."""
    calls: list[dict] = []

    async def fake_create(session, *, mcp_configs=None, **kwargs):
        calls.append({"mcp_configs": mcp_configs, **kwargs})
        return SimpleNamespace(
            soul=SimpleNamespace(
                runtime=SimpleNamespace(config=SimpleNamespace(default_model="test")),
                hook_engine=SimpleNamespace(trigger=AsyncMock()),
            ),
            run_print=AsyncMock(return_value=0),
            shutdown_background_tasks=AsyncMock(),
            await_bg_tasks_shutdown=AsyncMock(),
        )

    monkeypatch.setattr("kimi_cli.app.KimiCLI.create", fake_create)
    return calls


def test_cli_uses_project_mcp_config_when_no_explicit_file(tmp_path: Path, monkeypatch) -> None:
    # Isolate share dir so the real ~/.kimi/mcp.json is not picked up.
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    calls = _patch_kimi_cli_create(monkeypatch)

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"proj": {"command": "proj"}}}))

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(tmp_path), "--print", "--prompt", "hello"],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    mcp_configs = calls[0]["mcp_configs"]
    assert len(mcp_configs) == 1
    assert mcp_configs[0]["mcpServers"]["proj"]["command"] == "proj"


def test_cli_prefers_explicit_mcp_config_file_over_project(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    calls = _patch_kimi_cli_create(monkeypatch)

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"proj": {"command": "proj"}}}))

    explicit_mcp = tmp_path / "explicit.json"
    explicit_mcp.write_text(json.dumps({"mcpServers": {"exp": {"command": "exp"}}}))

    result = CliRunner().invoke(
        cli,
        [
            "--work-dir",
            str(tmp_path),
            "--mcp-config-file",
            str(explicit_mcp),
            "--print",
            "--prompt",
            "hello",
        ],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    mcp_configs = calls[0]["mcp_configs"]
    # In merge mode (default) explicit files are appended on top of project
    assert len(mcp_configs) == 2
    assert mcp_configs[0]["mcpServers"]["proj"]["command"] == "proj"
    assert mcp_configs[1]["mcpServers"]["exp"]["command"] == "exp"


def test_cli_falls_back_to_global_mcp_config_when_no_project_config(
    tmp_path: Path, monkeypatch
) -> None:
    calls = _patch_kimi_cli_create(monkeypatch)
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"global": {"command": "global"}}}))

    monkeypatch.setenv("KIMI_SHARE_DIR", str(share_dir))

    work_dir = tmp_path / "work"
    work_dir.mkdir()

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(work_dir), "--print", "--prompt", "hello"],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    mcp_configs = calls[0]["mcp_configs"]
    assert len(mcp_configs) == 1
    assert mcp_configs[0]["mcpServers"]["global"]["command"] == "global"


def test_cli_ignores_invalid_project_mcp_config(tmp_path: Path, monkeypatch) -> None:
    _patch_kimi_cli_create(monkeypatch)
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"global": {"command": "global"}}}))

    monkeypatch.setenv("KIMI_SHARE_DIR", str(share_dir))

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text("not json")

    result = CliRunner().invoke(
        cli,
        ["--work-dir", str(tmp_path), "--print", "--prompt", "hello"],
    )

    # Invalid JSON should raise a BadParameter error before reaching create()
    assert result.exit_code != 0
    assert "Invalid JSON" in result.output


def test_cli_merge_strategy_merges_global_and_project(tmp_path: Path, monkeypatch) -> None:
    calls = _patch_kimi_cli_create(monkeypatch)
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    monkeypatch.setenv("KIMI_SHARE_DIR", str(share_dir))

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"p": {"command": "p"}}}))

    config_file = tmp_path / "config.toml"
    config_file.write_text('[mcp]\nmerge_strategy = "merge"\n')

    result = CliRunner().invoke(
        cli,
        [
            "--work-dir",
            str(tmp_path),
            "--config-file",
            str(config_file),
            "--print",
            "--prompt",
            "hello",
        ],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    mcp_configs = calls[0]["mcp_configs"]
    assert len(mcp_configs) == 2
    assert mcp_configs[0]["mcpServers"]["g"]["command"] == "g"
    assert mcp_configs[1]["mcpServers"]["p"]["command"] == "p"


def test_cli_override_strategy_uses_only_project(tmp_path: Path, monkeypatch) -> None:
    calls = _patch_kimi_cli_create(monkeypatch)
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    global_mcp = share_dir / "mcp.json"
    global_mcp.write_text(json.dumps({"mcpServers": {"g": {"command": "g"}}}))

    monkeypatch.setenv("KIMI_SHARE_DIR", str(share_dir))

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"p": {"command": "p"}}}))

    config_file = tmp_path / "config.toml"
    config_file.write_text('[mcp]\nmerge_strategy = "override"\n')

    result = CliRunner().invoke(
        cli,
        [
            "--work-dir",
            str(tmp_path),
            "--config-file",
            str(config_file),
            "--print",
            "--prompt",
            "hello",
        ],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    mcp_configs = calls[0]["mcp_configs"]
    assert len(mcp_configs) == 1
    assert mcp_configs[0]["mcpServers"]["p"]["command"] == "p"


# ---------------------------------------------------------------------------
# ACP server integration tests
# ---------------------------------------------------------------------------


@pytest.fixture
def isolated_acp_share_dir(monkeypatch, tmp_path: Path):
    """Isolate ACP tests from the real ~/.kimi directory."""
    share_dir = tmp_path / "share"
    share_dir.mkdir()
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share_dir))
    return share_dir


@pytest.mark.asyncio
async def test_acp_server_loads_project_mcp_config(
    tmp_path: Path, isolated_acp_share_dir: Path
) -> None:
    from kimi_cli.acp.server import _collect_acp_mcp_configs

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text(json.dumps({"mcpServers": {"proj": {"command": "proj"}}}))

    configs = _collect_acp_mcp_configs(str(tmp_path))

    # merge mode: project config + empty ACP config
    assert len(configs) == 2
    assert isinstance(configs[0], dict)
    assert configs[0]["mcpServers"]["proj"]["command"] == "proj"


@pytest.mark.asyncio
async def test_acp_server_skips_invalid_project_mcp_config(
    tmp_path: Path, isolated_acp_share_dir: Path
) -> None:
    from kimi_cli.acp.server import _collect_acp_mcp_configs

    project_mcp = tmp_path / ".kimi" / "mcp.json"
    project_mcp.parent.mkdir(parents=True)
    project_mcp.write_text("not json")

    configs = _collect_acp_mcp_configs(str(tmp_path))

    # invalid project skipped, only empty ACP config remains
    assert len(configs) == 1


@pytest.mark.asyncio
async def test_acp_server_returns_empty_when_no_project_config(
    tmp_path: Path, isolated_acp_share_dir: Path
) -> None:
    from kimi_cli.acp.server import _collect_acp_mcp_configs

    configs = _collect_acp_mcp_configs(str(tmp_path))
    # no file configs + empty ACP config
    assert len(configs) == 1
