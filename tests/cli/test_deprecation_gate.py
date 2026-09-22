from __future__ import annotations

import subprocess
import sys

import pytest

import kimi_cli.deprecation as deprecation
from kimi_cli.__main__ import main


@pytest.fixture(autouse=True)
def _english_locale(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        monkeypatch.delenv(var, raising=False)
    # Isolate from the host's real tips cache (~/.kimi/kimi_code_tips.json).
    monkeypatch.setattr(deprecation, "_tips_cache_file", lambda: tmp_path / "kimi_code_tips.json")


def test_no_args_runs_installer(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    def fake_installer() -> int:
        nonlocal called
        called = True
        return 0

    monkeypatch.setattr("kimi_cli.deprecation.run_kimi_code_installer", fake_installer)
    assert main([]) == 0
    assert called


@pytest.mark.parametrize(
    "args",
    [
        ["--help"],
        ["-h"],
        ["-p", "hello"],
        ["--print", "-p", "hello"],
        ["mcp", "list"],
        ["info", "--json"],
    ],
)
def test_other_args_print_deprecation_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], args: list[str]
) -> None:
    def fake_installer() -> int:
        raise AssertionError("installer must not run for non-empty args")

    monkeypatch.setattr("kimi_cli.deprecation.run_kimi_code_installer", fake_installer)
    assert main(args) == 0
    out = capsys.readouterr().out
    assert "no longer maintained" in out
    assert "kimi, version" not in out


def test_version_prints_version_and_deprecation(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--version"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("kimi, version ")
    assert "no longer maintained" in out


async def _fake_scripts() -> tuple[str, str]:
    return (
        "curl -fsSL https://example.com/install.sh | bash",
        "irm https://example.com/install.ps1 | iex",
    )


def test_installer_runs_cdn_script(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(deprecation, "_fetch_install_scripts", _fake_scripts)
    ran: list[list[str]] = []

    def fake_run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
        ran.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(deprecation.subprocess, "run", fake_run)
    assert deprecation.run_kimi_code_installer() == 0
    if sys.platform == "win32":
        assert ran[0][:2] == ["powershell", "-NoProfile"]
        assert ran[0][-1] == "irm https://example.com/install.ps1 | iex"
    else:
        assert ran[0] == [
            "bash",
            "-o",
            "pipefail",
            "-c",
            "curl -fsSL https://example.com/install.sh | bash",
        ]
    assert "Running the Kimi Code install script" in capsys.readouterr().out


def test_installer_falls_back_to_default_script(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom() -> tuple[str, str]:
        raise RuntimeError("network down")

    monkeypatch.setattr(deprecation, "_fetch_install_scripts", boom)
    ran: list[list[str]] = []
    monkeypatch.setattr(
        deprecation.subprocess,
        "run",
        lambda cmd: ran.append(cmd) or subprocess.CompletedProcess(cmd, 0),
    )
    assert deprecation.run_kimi_code_installer() == 0
    assert "code.kimi.com/kimi-code/install" in ran[0][-1]


def test_installer_reports_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(deprecation, "_fetch_install_scripts", _fake_scripts)
    monkeypatch.setattr(
        deprecation.subprocess,
        "run",
        lambda cmd: subprocess.CompletedProcess(cmd, 3),
    )
    assert deprecation.run_kimi_code_installer() == 3
    assert "Installation failed" in capsys.readouterr().out


def test_install_command_follows_cached_tips(
    monkeypatch: pytest.MonkeyPatch, tmp_path, capsys: pytest.CaptureFixture[str]
) -> None:
    cache = tmp_path / "tips.json"
    cache.write_text(
        '{"migration": {"install_script": {"sh": "cdn-sh", "ps1": "cdn-ps1"}}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(deprecation, "_tips_cache_file", lambda: cache)

    assert deprecation.install_command() == "cdn-sh"
    monkeypatch.setattr(deprecation.sys, "platform", "win32")
    assert deprecation.install_command() == "cdn-ps1"
    assert "cdn-ps1" in deprecation.deprecation_message()


def test_install_command_default_without_cache() -> None:
    if sys.platform == "win32":
        assert "install.ps1" in deprecation.install_command()
    else:
        assert "install.sh" in deprecation.install_command()


def test_install_command_default_on_malformed_cache(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    cache = tmp_path / "tips.json"
    cache.write_text('{"migration": {"install_script": {"sh": 1}}}', encoding="utf-8")
    monkeypatch.setattr(deprecation, "_tips_cache_file", lambda: cache)
    if sys.platform == "win32":
        assert "install.ps1" in deprecation.install_command()
    else:
        assert "install.sh" in deprecation.install_command()
