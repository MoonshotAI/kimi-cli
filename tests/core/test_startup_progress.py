from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import SecretStr

import kimi_cli.app as app_module
import kimi_cli.ui.shell.startup as startup_module
from kimi_cli.app import KimiCLI
from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.exception import ConfigError
from kimi_cli.plugin import PluginError
from kimi_cli.ui.shell.startup import ShellStartupProgress


def test_shell_startup_progress_starts_once_and_updates_messages(monkeypatch) -> None:
    events: list[tuple[str, str]] = []

    class FakeStatus:
        def start(self) -> None:
            events.append(("start", ""))

        def update(self, message: str) -> None:
            events.append(("update", message))

        def stop(self) -> None:
            events.append(("stop", ""))

    def fake_status(message: str, *, spinner: str) -> FakeStatus:
        events.append(("create", message))
        assert spinner == "dots"
        return FakeStatus()

    monkeypatch.setattr(startup_module.console, "status", fake_status)

    progress = ShellStartupProgress(enabled=True)
    progress.update("Preparing session...")
    progress.update("Loading agent...")
    progress.stop()

    assert events == [
        ("create", "[cyan]Preparing session...[/cyan]"),
        ("start", ""),
        ("update", "[cyan]Loading agent...[/cyan]"),
        ("stop", ""),
    ]


def test_shell_startup_progress_is_noop_when_disabled(monkeypatch) -> None:
    called = False

    def fake_status(message: str, *, spinner: str):
        nonlocal called
        called = True
        raise AssertionError(f"status() should not be called, got {message!r} {spinner!r}")

    monkeypatch.setattr(startup_module.console, "status", fake_status)

    progress = ShellStartupProgress(enabled=False)
    progress.update("Preparing session...")
    progress.stop()

    assert called is False


@pytest.mark.asyncio
async def test_kimi_cli_create_reports_startup_phases(session, config, monkeypatch) -> None:
    phases: list[str] = []
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)

    class _FakeSoul:
        def __init__(self, agent, context):
            pass

        def set_hook_engine(self, engine):
            pass

    monkeypatch.setattr(app_module, "KimiSoul", _FakeSoul)

    cli = await KimiCLI.create(session, config=config, startup_progress=phases.append)

    assert isinstance(cli, KimiCLI)
    assert phases == [
        "Loading configuration...",
        "Scanning workspace...",
        "Loading agent...",
        "Restoring conversation...",
    ]
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_passes_compaction_llm(session, config, monkeypatch) -> None:
    config.default_model = "main"
    config.models = {
        "main": LLMModel(provider="main-provider", model="main-model", max_context_size=4096),
        "compact": LLMModel(
            provider="compact-provider",
            model="compact-model",
            max_context_size=8192,
        ),
    }
    config.providers = {
        "main-provider": LLMProvider(
            type="_echo",
            base_url="",
            api_key=SecretStr(""),
        ),
        "compact-provider": LLMProvider(
            type="_echo",
            base_url="",
            api_key=SecretStr(""),
        ),
    }
    config.loop_control.compaction_model = "compact"

    main_llm = SimpleNamespace(name="main-llm", max_context_size=4096)
    compact_llm = SimpleNamespace(name="compact-llm", max_context_size=8192)
    captured: dict[str, object] = {}

    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=main_llm,
        compaction_llm=compact_llm,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    def fake_create_llm(provider, model, **kwargs):
        if model.model == "compact-model":
            return compact_llm
        if model.model == "main-model":
            return main_llm
        raise AssertionError(f"Unexpected model {model.model!r}")

    async def fake_runtime_create(
        config_arg, oauth, llm, compaction_llm, session_arg, yolo, skills_dir
    ):
        captured["llm"] = llm
        captured["compaction_llm"] = compaction_llm
        captured["session"] = session_arg
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", fake_create_llm)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", lambda agent, context: (agent, context))

    cli = await KimiCLI.create(session, config=config)

    assert isinstance(cli, KimiCLI)
    assert captured == {
        "llm": main_llm,
        "compaction_llm": compact_llm,
        "session": session,
    }
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_cleans_stale_running_foreground_subagents(
    session, config, monkeypatch
) -> None:
    update_instance = Mock()
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
        subagent_store=SimpleNamespace(
            list_instances=lambda: [
                SimpleNamespace(agent_id="afg1", status="running_foreground"),
                SimpleNamespace(agent_id="abg1", status="running_background"),
                SimpleNamespace(agent_id="aidle1", status="idle"),
            ],
            update_instance=update_instance,
        ),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)

    class _FakeSoul:
        def __init__(self, agent, context):
            pass

        def set_hook_engine(self, engine):
            pass

    monkeypatch.setattr(app_module, "KimiSoul", _FakeSoul)

    await KimiCLI.create(session, config=config)

    update_instance.assert_called_once_with("afg1", status="failed")


@pytest.mark.asyncio
async def test_kimi_cli_create_warns_for_unknown_model_name(session, config, monkeypatch) -> None:
    warnings: list[str] = []
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    def fake_warning(message: str, **kwargs) -> None:
        warnings.append(message.format(**kwargs))

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", lambda agent, context: (agent, context))
    monkeypatch.setattr(app_module.logger, "warning", fake_warning)

    cli = await KimiCLI.create(session, config=config, model_name="missing")

    assert isinstance(cli, KimiCLI)
    assert warnings == ["Model 'missing' not found in config, using placeholder"]
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_warns_for_missing_model_provider(
    session, config, monkeypatch
) -> None:
    config.default_model = "main"
    config.models = {
        "main": LLMModel(provider="missing-provider", model="main-model", max_context_size=4096),
    }
    config.providers = {}

    warnings: list[str] = []
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    def fake_warning(message: str, **kwargs) -> None:
        warnings.append(message.format(**kwargs))

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", lambda agent, context: (agent, context))
    monkeypatch.setattr(app_module.logger, "warning", fake_warning)

    cli = await KimiCLI.create(session, config=config)

    assert isinstance(cli, KimiCLI)
    assert warnings == ["Provider 'missing-provider' for model 'main' missing; using placeholder"]
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_skips_compaction_llm_when_provider_is_missing(
    session, config, monkeypatch
) -> None:
    config.default_model = "main"
    config.models = {
        "main": LLMModel(provider="main-provider", model="main-model", max_context_size=4096),
        "compact": LLMModel(
            provider="missing-provider",
            model="compact-model",
            max_context_size=8192,
        ),
    }
    config.providers = {
        "main-provider": LLMProvider(
            type="_echo",
            base_url="",
            api_key=SecretStr(""),
        ),
    }
    config.loop_control.compaction_model = "compact"

    warnings: list[str] = []
    main_llm = SimpleNamespace(name="main-llm", max_context_size=4096)
    captured: dict[str, object] = {}
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=main_llm,
        compaction_llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    def fake_create_llm(provider, model, **kwargs):
        assert model.model == "main-model"
        return main_llm

    async def fake_runtime_create(
        config_arg, oauth, llm, compaction_llm, session_arg, yolo, skills_dir
    ):
        captured["llm"] = llm
        captured["compaction_llm"] = compaction_llm
        captured["session"] = session_arg
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    def fake_warning(message: str, **kwargs) -> None:
        warnings.append(message.format(**kwargs))

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", fake_create_llm)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", lambda agent, context: (agent, context))
    monkeypatch.setattr(app_module.logger, "warning", fake_warning)

    cli = await KimiCLI.create(session, config=config)

    assert isinstance(cli, KimiCLI)
    assert captured == {
        "llm": main_llm,
        "compaction_llm": None,
        "session": session,
    }
    assert warnings == ["Compaction provider 'missing-provider' not found in config, skipping"]
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_rejects_smaller_compaction_model(
    session, config, monkeypatch
) -> None:
    config.default_model = "main"
    config.models = {
        "main": LLMModel(provider="main-provider", model="main-model", max_context_size=8192),
        "compact": LLMModel(
            provider="compact-provider",
            model="compact-model",
            max_context_size=4096,
        ),
    }
    config.providers = {
        "main-provider": LLMProvider(type="_echo", base_url="", api_key=SecretStr("")),
        "compact-provider": LLMProvider(type="_echo", base_url="", api_key=SecretStr("")),
    }
    config.loop_control.compaction_model = "compact"

    runtime_create_called = False

    def fake_create_llm(provider, model, **kwargs):
        return SimpleNamespace(name=model.model, max_context_size=model.max_context_size)

    async def fake_runtime_create(*args, **kwargs):
        nonlocal runtime_create_called
        runtime_create_called = True
        raise AssertionError("Runtime.create should not be called for invalid compaction sizing")

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", fake_create_llm)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)

    with pytest.raises(ConfigError, match="smaller than active model"):
        await KimiCLI.create(session, config=config)

    assert runtime_create_called is False


@pytest.mark.asyncio
async def test_kimi_cli_create_allows_smaller_compaction_model_without_active_llm(
    session, config, monkeypatch
) -> None:
    config.models = {
        "compact": LLMModel(
            provider="compact-provider",
            model="compact-model",
            max_context_size=4096,
        ),
    }
    config.providers = {
        "compact-provider": LLMProvider(type="_echo", base_url="", api_key=SecretStr("")),
    }
    config.loop_control.compaction_model = "compact"

    captured: dict[str, object] = {}
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        compaction_llm=SimpleNamespace(name="compact-model", max_context_size=4096),
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    def fake_create_llm(provider, model, **kwargs):
        if model.model == "":
            return None
        return SimpleNamespace(name=model.model, max_context_size=model.max_context_size)

    async def fake_runtime_create(
        config_arg, oauth, llm, compaction_llm, session_arg, yolo, skills_dir
    ):
        captured["llm"] = llm
        captured["compaction_llm"] = compaction_llm
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", fake_create_llm)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", lambda agent, context: (agent, context))

    cli = await KimiCLI.create(session, config=config)

    assert isinstance(cli, KimiCLI)
    assert captured["llm"] is None
    assert getattr(captured["compaction_llm"], "name", None) == "compact-model"
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_keeps_explicit_compaction_model_under_env_override(
    session, config, monkeypatch
) -> None:
    config.default_model = "main"
    config.models = {
        "main": LLMModel(provider="main-provider", model="main-model", max_context_size=4096),
        "compact": LLMModel(
            provider="compact-provider",
            model="compact-model",
            max_context_size=8192,
        ),
    }
    config.providers = {
        "main-provider": LLMProvider(
            type="kimi",
            base_url="https://config.test/v1",
            api_key=SecretStr("config-main"),
        ),
        "compact-provider": LLMProvider(
            type="kimi",
            base_url="https://config.test/v1",
            api_key=SecretStr("config-compact"),
        ),
    }
    config.loop_control.compaction_model = "compact"

    captured_calls: list[tuple[str, int, str, str]] = []
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=SimpleNamespace(name="main-llm"),
        compaction_llm=SimpleNamespace(name="compact-llm"),
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    def fake_create_llm(provider, model, **kwargs):
        captured_calls.append(
            (
                model.model,
                model.max_context_size,
                provider.base_url,
                provider.api_key.get_secret_value(),
            )
        )
        return SimpleNamespace(name=model.model, max_context_size=model.max_context_size)

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setenv("KIMI_MODEL_NAME", "env-main-model")
    monkeypatch.setenv("KIMI_BASE_URL", "https://env.test/v1")
    monkeypatch.setenv("KIMI_API_KEY", "env-key")
    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "create_llm", fake_create_llm)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", lambda agent, context: (agent, context))

    cli = await KimiCLI.create(session, config=config)

    assert isinstance(cli, KimiCLI)
    assert captured_calls == [
        ("env-main-model", 4096, "https://env.test/v1", "env-key"),
        ("compact-model", 8192, "https://env.test/v1", "env-key"),
    ]
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_surfaces_invalid_compaction_plugin(
    session, config, monkeypatch
) -> None:
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(
        "kimi_cli.plugin.compaction.resolve_plugin_compactor",
        lambda *args, **kwargs: (_ for _ in ()).throw(PluginError("broken entrypoint")),
    )
    monkeypatch.setattr(
        "kimi_cli.plugin.manager.get_plugins_dir", lambda: session.context_file.parent
    )

    config.loop_control.compaction_plugin = "broken-plugin"

    with pytest.raises(ConfigError, match="Invalid compaction plugin 'broken-plugin'"):
        await KimiCLI.create(session, config=config)


@pytest.mark.asyncio
async def test_kimi_cli_create_wraps_plugin_import_failures_as_config_error(
    session, config, monkeypatch, tmp_path
) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "broken-plugin"
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "broken_compaction.py").write_text(
        "import missing_helper\n\nclass BrokenCompaction:\n    async def compact(self, messages, llm, *, custom_instruction=''):\n        return messages\n",
        encoding="utf-8",
    )
    (pdir / "plugin.json").write_text(
        json.dumps(
            {
                "name": "broken-plugin",
                "version": "1.0.0",
                "compaction": {"entrypoint": "broken_compaction.BrokenCompaction"},
            }
        ),
        encoding="utf-8",
    )

    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(
        app_module, "augment_provider_credentials_with_env_vars", lambda provider: {}
    )
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr("kimi_cli.plugin.manager.get_plugins_dir", lambda: plugins)

    config.loop_control.compaction_plugin = "broken-plugin"

    with pytest.raises(
        ConfigError,
        match="Invalid compaction plugin 'broken-plugin': Failed to import compaction module 'broken_compaction'",
    ):
        await KimiCLI.create(session, config=config)
