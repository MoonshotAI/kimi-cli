from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest
from kaos.path import KaosPath

from kimi_cli.session import Session
from kimi_cli.session_state import load_session_state, save_session_state
from kimi_cli.web.api import sessions as sessions_api
from kimi_cli.web.models import GenerateTitleRequest


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


class _FakeOAuthManager:
    def __init__(self, _config: object) -> None:
        pass

    async def ensure_fresh(self) -> None:
        return None


class _FakeLLM:
    chat_provider = object()


class _FakeMessage:
    def __init__(self, text: str) -> None:
        self._text = text

    def extract_text(self) -> str:
        return self._text


class _FakeResult:
    def __init__(self, text: str) -> None:
        self.message = _FakeMessage(text)


@pytest.mark.anyio
async def test_generate_title_preserves_concurrent_manual_title(
    isolated_share_dir: Path,
    work_dir: KaosPath,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = await Session.create(work_dir)

    config = SimpleNamespace(
        default_model="test-model",
        models={"test-model": SimpleNamespace(provider="test-provider")},
        providers={"test-provider": object()},
    )

    monkeypatch.setattr("kimi_cli.config.load_config", lambda: config)
    monkeypatch.setattr(
        "kimi_cli.llm.create_llm",
        lambda provider_config, model_config, oauth=None: _FakeLLM(),
    )
    monkeypatch.setattr("kimi_cli.auth.oauth.OAuthManager", _FakeOAuthManager)

    async def fake_generate(*, chat_provider, system_prompt, tools, history):
        state = load_session_state(session.dir)
        state.custom_title = "Manual Title"
        state.title_generated = True
        save_session_state(state, session.dir)
        return _FakeResult("AI Title")

    monkeypatch.setattr("kosong.generate", fake_generate)

    response = await sessions_api.generate_session_title(
        UUID(session.id),
        GenerateTitleRequest(
            user_message="debug the flaky web session rename issue",
            assistant_response="I'll inspect the session state writes.",
        ),
    )

    state = load_session_state(session.dir)
    assert response.title == "Manual Title"
    assert state.custom_title == "Manual Title"
    assert state.title_generated is True
    assert state.title_generate_attempts == 0
