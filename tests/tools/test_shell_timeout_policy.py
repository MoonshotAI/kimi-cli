from __future__ import annotations

from types import SimpleNamespace

from kimi_cli.tools.shell import DEFAULT_TIMEOUT, Params, Shell, _effective_timeout


def test_effective_timeout_keeps_normal_commands_at_default() -> None:
    assert _effective_timeout("echo ok", DEFAULT_TIMEOUT, max_timeout=300) == DEFAULT_TIMEOUT


def test_effective_timeout_extends_known_long_commands() -> None:
    assert _effective_timeout("git submodule deinit -f deps/hal", 60, max_timeout=300) == 300
    assert _effective_timeout("git show HEAD -- vendor/sdk", 60, max_timeout=300) == 120
    assert _effective_timeout("npm run build", 60, max_timeout=300) == 180


def test_effective_timeout_keeps_larger_explicit_timeout() -> None:
    assert _effective_timeout("npm install", 240, max_timeout=300) == 240


async def test_shell_uses_adaptive_timeout(shell_tool: Shell, monkeypatch) -> None:
    seen: dict[str, int] = {}

    async def fake_run_shell_command(command, stdout_cb, stderr_cb, timeout):
        seen["timeout"] = timeout
        return 0

    monkeypatch.setattr(shell_tool, "_run_shell_command", fake_run_shell_command)

    result = await shell_tool(Params(command="git submodule deinit -f deps/hal"))

    assert not result.is_error
    assert seen["timeout"] == 300


async def test_background_shell_uses_adaptive_timeout(shell_tool: Shell, monkeypatch) -> None:
    seen: dict[str, int] = {}

    def fake_create_bash_task(**kwargs):
        seen["timeout"] = kwargs["timeout_s"]
        return SimpleNamespace(
            spec=SimpleNamespace(
                id="bash-test",
                kind="shell",
                kind_payload=None,
                description=kwargs["description"],
                command=kwargs["command"],
            ),
            runtime=SimpleNamespace(status="running", exit_code=None, failure_reason=None),
        )

    monkeypatch.setattr(
        shell_tool._runtime.background_tasks, "create_bash_task", fake_create_bash_task
    )

    result = await shell_tool(
        Params(
            command="npm install",
            run_in_background=True,
            description="install dependencies",
        )
    )

    assert not result.is_error
    assert seen["timeout"] == 180
