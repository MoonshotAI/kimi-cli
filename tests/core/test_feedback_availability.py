from __future__ import annotations

from types import SimpleNamespace

import pytest

import kimi_cli.app as app_module
from kimi_cli.app import KimiCLI


@pytest.mark.asyncio
async def test_run_acp_disables_user_feedback(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = SimpleNamespace(can_request_user_feedback=True)
    cli = KimiCLI(SimpleNamespace(), runtime, {})
    observed: list[bool] = []

    class _FakeACP:
        def __init__(self, _soul) -> None:
            observed.append(runtime.can_request_user_feedback)

        async def run(self) -> None:
            observed.append(runtime.can_request_user_feedback)

    class _Env:
        async def __aenter__(self):
            observed.append(runtime.can_request_user_feedback)
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(app_module, "ACP", _FakeACP, raising=False)
    monkeypatch.setattr(cli, "_env", lambda: _Env())

    from kimi_cli.ui import acp as acp_module

    monkeypatch.setattr(acp_module, "ACP", _FakeACP)

    await cli.run_acp()

    assert observed == [False, False, False]
