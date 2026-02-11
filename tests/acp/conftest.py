"""ACP test configuration and fixtures."""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import acp
import pytest
import pytest_asyncio


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _kimi_bin() -> str:
    """Return the path to the kimi entry-point script inside the venv."""
    return str(_repo_root() / ".venv" / "bin" / "kimi")


class ACPTestClient:
    """Minimal ACP client for tests — collects session_update callbacks."""

    def __init__(self) -> None:
        self.updates: list[Any] = []
        self.conn: acp.Agent | None = None

    def on_connect(self, conn: acp.Agent) -> None:
        self.conn = conn

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        self.updates.append(update)

    async def request_permission(
        self,
        options: list[acp.schema.PermissionOption],
        session_id: str,
        tool_call: acp.schema.ToolCallUpdate,
        **kwargs: Any,
    ) -> acp.schema.RequestPermissionResponse:
        return acp.schema.RequestPermissionResponse(
            outcome=acp.schema.AllowedOutcome(
                outcome="selected",
                option_id="allow",
            )
        )

    async def read_text_file(
        self,
        path: str,
        session_id: str,
        limit: int | None = None,
        line: int | None = None,
        **kwargs: Any,
    ) -> Any:
        raise NotImplementedError

    async def write_text_file(self, content: str, path: str, session_id: str, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def create_terminal(
        self,
        command: str,
        session_id: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: list[acp.schema.EnvVariable] | None = None,
        output_byte_limit: int | None = None,
        **kwargs: Any,
    ) -> Any:
        raise NotImplementedError

    async def terminal_output(self, session_id: str, terminal_id: str, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def wait_for_terminal_exit(self, session_id: str, terminal_id: str, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def kill_terminal(self, session_id: str, terminal_id: str, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def release_terminal(self, session_id: str, terminal_id: str, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        pass


@pytest.fixture
def acp_share_dir(tmp_path: Path) -> Path:
    """Create a share dir with _scripted_echo config at config.toml."""
    share_dir = tmp_path / "share"
    share_dir.mkdir()

    scripts = [
        "text: Hello from scripted echo!",
        "text: Second response from scripted echo.",
    ]
    scripts_path = tmp_path / "scripts.json"
    scripts_path.write_text(json.dumps(scripts), encoding="utf-8")

    trace_env = os.getenv("KIMI_SCRIPTED_ECHO_TRACE", "0")
    config_data = {
        "default_model": "scripted",
        "models": {
            "scripted": {
                "provider": "scripted_provider",
                "model": "scripted_echo",
                "max_context_size": 100000,
            }
        },
        "providers": {
            "scripted_provider": {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {
                    "KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_path),
                    "KIMI_SCRIPTED_ECHO_TRACE": trace_env,
                },
            }
        },
    }

    import tomlkit

    config_path = share_dir / "config.toml"
    config_path.write_text(tomlkit.dumps(config_data), encoding="utf-8")
    return share_dir


@pytest_asyncio.fixture
async def acp_client(
    acp_share_dir: Path, tmp_path: Path
) -> AsyncIterator[tuple[acp.ClientSideConnection, ACPTestClient]]:
    """Spawn a kimi ACP subprocess and return the SDK connection + test client."""
    test_client = ACPTestClient()
    env = {
        **os.environ,
        "KIMI_SHARE_DIR": str(acp_share_dir),
    }

    async with acp.spawn_agent_process(
        test_client,
        _kimi_bin(),
        "acp",
        env=env,
        cwd=str(_repo_root()),
        use_unstable_protocol=True,
    ) as (conn, process):
        yield conn, test_client
