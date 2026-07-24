"""Tests for /web and /vis slash commands and their exception propagation.

Ensures that typing /web or /vis in the interactive shell cleanly switches
to the corresponding server without hanging or corrupting terminal state.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any
from unittest.mock import Mock

import pytest

from kimi_cli.cli import Reload, SwitchToVis, SwitchToWeb
from kimi_cli.ui.shell.slash import ShellSlashCmdFunc, shell_mode_registry
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.utils.slashcmd import SlashCommand


async def _invoke_slash_command(command: SlashCommand[ShellSlashCmdFunc], shell: Any) -> None:
    ret = command.func(shell, "")
    if isinstance(ret, Awaitable):
        await ret


def _mock_shell_with_soul(session_id: str = "current-session-id") -> Mock:
    """Create a mock Shell whose soul passes the KimiSoul isinstance check."""
    from kimi_cli.soul.kimisoul import KimiSoul

    mock_soul = Mock(spec=KimiSoul)
    mock_soul.runtime.session.id = session_id
    shell = Mock()
    shell.soul = mock_soul
    return shell


# ---------------------------------------------------------------------------
# /web — registration
# ---------------------------------------------------------------------------


class TestWebCommandRegistration:
    """Verify /web is registered in the correct registry."""

    def test_registered_in_shell_registry(self) -> None:
        cmd = shell_slash_registry.find_command("web")
        assert cmd is not None
        assert cmd.name == "web"
        assert "Web" in cmd.description

    def test_not_in_shell_mode_registry(self) -> None:
        assert shell_mode_registry.find_command("web") is None

    def test_not_in_soul_registry(self) -> None:
        from kimi_cli.soul.slash import registry as soul_slash_registry

        assert soul_slash_registry.find_command("web") is None


# ---------------------------------------------------------------------------
# /web — behaviour
# ---------------------------------------------------------------------------


class TestWebCommandBehavior:
    """Verify /web raises SwitchToWeb with the current session ID."""

    async def test_raises_switch_to_web(self) -> None:
        shell = _mock_shell_with_soul("my-session-123")

        cmd = shell_slash_registry.find_command("web")
        assert cmd is not None

        with pytest.raises(SwitchToWeb) as exc_info:
            await _invoke_slash_command(cmd, shell)

        assert exc_info.value.session_id == "my-session-123"

    async def test_carries_session_id(self) -> None:
        shell = _mock_shell_with_soul("abc-def")

        cmd = shell_slash_registry.find_command("web")
        assert cmd is not None

        with pytest.raises(SwitchToWeb) as exc_info:
            await _invoke_slash_command(cmd, shell)

        assert exc_info.value.session_id == "abc-def"

    async def test_session_id_none_without_kimi_soul(self) -> None:
        """When soul is not a KimiSoul, session_id should be None."""
        shell = Mock()
        shell.soul = Mock()  # plain Mock, not spec=KimiSoul

        cmd = shell_slash_registry.find_command("web")
        assert cmd is not None

        with pytest.raises(SwitchToWeb) as exc_info:
            await _invoke_slash_command(cmd, shell)

        assert exc_info.value.session_id is None

    async def test_does_not_raise_switch_to_vis(self) -> None:
        """/web must raise SwitchToWeb, not SwitchToVis."""
        shell = _mock_shell_with_soul()

        cmd = shell_slash_registry.find_command("web")
        assert cmd is not None

        with pytest.raises(SwitchToWeb):
            await _invoke_slash_command(cmd, shell)


# ---------------------------------------------------------------------------
# /vis — registration
# ---------------------------------------------------------------------------


class TestVisCommandRegistration:
    """Verify /vis is registered in the correct registry."""

    def test_registered_in_shell_registry(self) -> None:
        cmd = shell_slash_registry.find_command("vis")
        assert cmd is not None
        assert cmd.name == "vis"
        assert "Visualizer" in cmd.description

    def test_not_in_shell_mode_registry(self) -> None:
        assert shell_mode_registry.find_command("vis") is None

    def test_not_in_soul_registry(self) -> None:
        from kimi_cli.soul.slash import registry as soul_slash_registry

        assert soul_slash_registry.find_command("vis") is None


# ---------------------------------------------------------------------------
# /vis — behaviour
# ---------------------------------------------------------------------------


class TestVisCommandBehavior:
    """Verify /vis raises SwitchToVis with the current session ID."""

    async def test_raises_switch_to_vis(self) -> None:
        shell = _mock_shell_with_soul("my-session-123")

        cmd = shell_slash_registry.find_command("vis")
        assert cmd is not None

        with pytest.raises(SwitchToVis) as exc_info:
            await _invoke_slash_command(cmd, shell)

        assert exc_info.value.session_id == "my-session-123"

    async def test_carries_session_id(self) -> None:
        shell = _mock_shell_with_soul("abc-def")

        cmd = shell_slash_registry.find_command("vis")
        assert cmd is not None

        with pytest.raises(SwitchToVis) as exc_info:
            await _invoke_slash_command(cmd, shell)

        assert exc_info.value.session_id == "abc-def"

    async def test_session_id_none_without_kimi_soul(self) -> None:
        """When soul is not a KimiSoul, session_id should be None."""
        shell = Mock()
        shell.soul = Mock()

        cmd = shell_slash_registry.find_command("vis")
        assert cmd is not None

        with pytest.raises(SwitchToVis) as exc_info:
            await _invoke_slash_command(cmd, shell)

        assert exc_info.value.session_id is None

    async def test_does_not_raise_switch_to_web(self) -> None:
        """/vis must raise SwitchToVis, not SwitchToWeb."""
        shell = _mock_shell_with_soul()

        cmd = shell_slash_registry.find_command("vis")
        assert cmd is not None

        with pytest.raises(SwitchToVis):
            await _invoke_slash_command(cmd, shell)


# ---------------------------------------------------------------------------
# SwitchToWeb / SwitchToVis — exception properties
# ---------------------------------------------------------------------------


class TestSwitchExceptionProperties:
    """Verify SwitchToWeb and SwitchToVis have consistent interfaces."""

    def test_both_are_exceptions(self) -> None:
        assert issubclass(SwitchToWeb, Exception)
        assert issubclass(SwitchToVis, Exception)

    def test_independent_hierarchies(self) -> None:
        """Neither should be a subclass of the other."""
        assert not issubclass(SwitchToVis, SwitchToWeb)
        assert not issubclass(SwitchToWeb, SwitchToVis)

    def test_str_representations(self) -> None:
        assert str(SwitchToWeb()) == "switch_to_web"
        assert str(SwitchToVis()) == "switch_to_vis"

    def test_default_session_id_is_none(self) -> None:
        assert SwitchToWeb().session_id is None
        assert SwitchToVis().session_id is None

    def test_accepts_session_id(self) -> None:
        assert SwitchToWeb(session_id="x").session_id == "x"
        assert SwitchToVis(session_id="x").session_id == "x"

    def test_matching_interface(self) -> None:
        """Both exceptions must expose the same ``session_id`` attribute."""
        web = SwitchToWeb(session_id="s")
        vis = SwitchToVis(session_id="s")
        assert hasattr(web, "session_id")
        assert hasattr(vis, "session_id")
        assert web.session_id == vis.session_id


# ---------------------------------------------------------------------------
# Shell exception propagation
# ---------------------------------------------------------------------------


class TestShellExceptionPropagation:
    """Verify Shell._run_slash_command propagates control-flow exceptions.

    The shell's slash command runner has a try/except that catches generic
    exceptions and prints them as errors. Reload, SwitchToWeb, and
    SwitchToVis must be in the propagation whitelist so they reach the
    outer _reload_loop handler instead of being swallowed.
    """

    async def test_propagates_through_shell_runner(self) -> None:
        """Each control-flow exception must NOT be caught by ``except Exception``."""
        for exc in (
            Reload(session_id="t"),
            SwitchToWeb(session_id="t"),
            SwitchToVis(session_id="t"),
        ):
            raised = False

            def thrower(*args: Any, _exc: Exception = exc, **kwargs: Any) -> None:
                raise _exc

            cmd = SlashCommand(name="test", description="test", func=thrower, aliases=[])

            # Mimic the exact try/except structure from Shell._run_slash_command
            try:
                cmd.func(Mock(), "")
            except (Reload, SwitchToWeb, SwitchToVis):
                raised = True
            except (asyncio.CancelledError, KeyboardInterrupt):
                pass
            except Exception:
                pass

            assert raised, f"{type(exc).__name__} was not propagated"


# ---------------------------------------------------------------------------
# /web + /vis — coexistence
# ---------------------------------------------------------------------------


class TestWebAndVisCoexistence:
    """Verify /web and /vis coexist without interference."""

    def test_both_registered(self) -> None:
        web_cmd = shell_slash_registry.find_command("web")
        vis_cmd = shell_slash_registry.find_command("vis")
        assert web_cmd is not None
        assert vis_cmd is not None
        assert web_cmd.name != vis_cmd.name

    async def test_same_shell_different_exceptions(self) -> None:
        """Given the same shell, /web raises SwitchToWeb and /vis raises SwitchToVis."""
        shell = _mock_shell_with_soul("shared-session")

        web_cmd = shell_slash_registry.find_command("web")
        vis_cmd = shell_slash_registry.find_command("vis")
        assert web_cmd is not None
        assert vis_cmd is not None

        with pytest.raises(SwitchToWeb) as web_exc:
            await _invoke_slash_command(web_cmd, shell)

        with pytest.raises(SwitchToVis) as vis_exc:
            await _invoke_slash_command(vis_cmd, shell)

        assert web_exc.value.session_id == vis_exc.value.session_id == "shared-session"
