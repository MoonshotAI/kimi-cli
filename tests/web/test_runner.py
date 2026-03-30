from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient

from kimi_cli.web import app as web_app
from kimi_cli.web.runner.embedded_process import EmbeddedSessionProcess
from kimi_cli.web.runner.process import KimiCLIRunner


def test_runner_creates_embedded_session_process() -> None:
    runner = KimiCLIRunner(runtime_mode="embedded")

    session_process = runner._create_session_process(uuid4())

    assert isinstance(session_process, EmbeddedSessionProcess)


def test_create_app_defaults_to_embedded_runtime(monkeypatch) -> None:
    captured: dict[str, str] = {}

    class FakeRunner:
        def __init__(self, *, runtime_mode: str) -> None:
            captured["runtime_mode"] = runtime_mode

        def start(self) -> None:
            pass

        async def stop(self) -> None:
            pass

    monkeypatch.setattr(web_app, "KimiCLIRunner", FakeRunner)

    with TestClient(web_app.create_app()) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert captured["runtime_mode"] == "embedded"


def test_create_app_explicit_process_runtime(monkeypatch) -> None:
    captured: dict[str, str] = {}

    class FakeRunner:
        def __init__(self, *, runtime_mode: str) -> None:
            captured["runtime_mode"] = runtime_mode

        def start(self) -> None:
            pass

        async def stop(self) -> None:
            pass

    monkeypatch.setenv(web_app.ENV_RUNTIME, "process")
    monkeypatch.setattr(web_app, "KimiCLIRunner", FakeRunner)

    with TestClient(web_app.create_app()) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert captured["runtime_mode"] == "process"


def test_create_app_invalid_runtime_falls_back_to_embedded(monkeypatch) -> None:
    captured: dict[str, str] = {}

    class FakeRunner:
        def __init__(self, *, runtime_mode: str) -> None:
            captured["runtime_mode"] = runtime_mode

        def start(self) -> None:
            pass

        async def stop(self) -> None:
            pass

    monkeypatch.setenv(web_app.ENV_RUNTIME, "invalid")
    monkeypatch.setattr(web_app, "KimiCLIRunner", FakeRunner)

    with TestClient(web_app.create_app()) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert captured["runtime_mode"] == "embedded"
