from __future__ import annotations

import json
from pathlib import Path

import pytest
from kosong.chat_provider.echo import EchoChatProvider
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.config import LLMModel
from kimi_cli.llm import LLM
from kimi_cli.plugin import PluginError, parse_plugin_json
from kimi_cli.plugin.compaction import resolve_plugin_compactor
from kimi_cli.soul import _current_wire
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire import Wire
from kimi_cli.wire.types import CompactionBegin, CompactionEnd, TextPart


def _write_alpha_compactor(plugin_root: Path) -> None:
    plugin_root.mkdir(parents=True, exist_ok=True)
    (plugin_root / "alpha_compaction.py").write_text(
        """
from collections.abc import Sequence

from kosong.message import Message

from kimi_cli.llm import LLM
from kimi_cli.soul.compaction import CompactionResult
from kimi_cli.wire.types import TextPart


class AlphaCompaction:
    PLUGIN_MARK = "alpha"

    def __init__(self) -> None:
        self.calls = 0
        self.last_model = None

    async def compact(
        self, messages: Sequence[Message], llm: LLM, *, custom_instruction: str = ""
    ) -> CompactionResult:
        self.calls += 1
        self.last_model = llm.model_config.model if llm.model_config is not None else None
        return CompactionResult(
            messages=[Message(role="user", content=[TextPart(text=f"plugin compacted via {self.last_model}")])],
            usage=None,
        )
""".strip(),
        encoding="utf-8",
    )


def _write_beta_compactor(plugin_root: Path) -> None:
    plugin_root.mkdir(parents=True, exist_ok=True)
    (plugin_root / "beta_compaction.py").write_text(
        """
from collections.abc import Sequence

from kosong.message import Message

from kimi_cli.llm import LLM
from kimi_cli.soul.compaction import CompactionResult


class BetaCompaction:
    PLUGIN_MARK = "beta"

    async def compact(
        self, messages: Sequence[Message], llm: LLM, *, custom_instruction: str = ""
    ) -> CompactionResult:
        return CompactionResult(messages=messages, usage=None)
""".strip(),
        encoding="utf-8",
    )


def _write_plugin(plugin_root: Path, *, name: str, entrypoint: str) -> None:
    plugin_root.mkdir(parents=True, exist_ok=True)
    (plugin_root / "plugin.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": "1.0.0",
                "compaction": {"entrypoint": entrypoint},
            }
        ),
        encoding="utf-8",
    )


def _make_test_llm(model_name: str) -> LLM:
    return LLM(
        chat_provider=EchoChatProvider(),
        max_context_size=100_000,
        capabilities=set(),
        model_config=LLMModel(
            provider="_echo",
            model=model_name,
            max_context_size=100_000,
        ),
    )


def _make_soul(runtime: Runtime, tmp_path: Path) -> tuple[KimiSoul, Context]:
    runtime = Runtime(
        config=runtime.config,
        llm=runtime.llm,
        session=runtime.session,
        builtin_args=runtime.builtin_args,
        denwa_renji=runtime.denwa_renji,
        approval=runtime.approval,
        labor_market=runtime.labor_market,
        environment=runtime.environment,
        notifications=runtime.notifications,
        background_tasks=runtime.background_tasks,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
        compaction_llm=runtime.compaction_llm,
        compaction=runtime.compaction,
        role=runtime.role,
    )
    agent = Agent(
        name="Plugin Compaction Agent",
        system_prompt="System prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    context = Context(file_backend=tmp_path / "history.jsonl")
    return KimiSoul(agent, context=context), context


def test_parse_plugin_json_rejects_compaction_entrypoint_without_dot(tmp_path: Path) -> None:
    path = tmp_path / "plugin.json"
    path.write_text(
        json.dumps(
            {
                "name": "bad",
                "version": "1.0.0",
                "compaction": {"entrypoint": "NoDot"},
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(PluginError, match="Invalid plugin.json schema"):
        parse_plugin_json(path)


def test_resolve_plugin_compactor_returns_none_when_unconfigured(tmp_path: Path) -> None:
    assert resolve_plugin_compactor(tmp_path / "plugins", None) is None


@pytest.mark.asyncio
async def test_resolve_plugin_compactor_loads_selected_plugin(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "alpha-plugin"
    _write_alpha_compactor(pdir)
    _write_plugin(
        pdir,
        name="alpha-plugin",
        entrypoint="alpha_compaction.AlphaCompaction",
    )

    comp = resolve_plugin_compactor(plugins, "alpha-plugin")
    assert comp is not None
    assert getattr(type(comp), "PLUGIN_MARK", None) == "alpha"

    llm = _make_test_llm("main-chat")
    result = await comp.compact([Message(role="user", content=[TextPart(text="hi")])], llm)
    assert result.messages[0].extract_text("\n") == "plugin compacted via main-chat"


def test_resolve_plugin_compactor_requires_explicit_selected_plugin(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    alpha = plugins / "alpha-plugin"
    beta = plugins / "beta-plugin"
    _write_alpha_compactor(alpha)
    _write_beta_compactor(beta)
    _write_plugin(alpha, name="alpha-plugin", entrypoint="alpha_compaction.AlphaCompaction")
    _write_plugin(beta, name="beta-plugin", entrypoint="beta_compaction.BetaCompaction")

    comp = resolve_plugin_compactor(plugins, "beta-plugin")
    assert comp is not None
    assert getattr(type(comp), "PLUGIN_MARK", None) == "beta"


def test_resolve_plugin_compactor_raises_for_missing_plugin(tmp_path: Path) -> None:
    (tmp_path / "plugins").mkdir()
    with pytest.raises(PluginError, match="missing-plugin"):
        resolve_plugin_compactor(tmp_path / "plugins", "missing-plugin")


@pytest.mark.asyncio
async def test_compact_context_uses_runtime_plugin_compactor(
    runtime: Runtime, tmp_path: Path
) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "alpha-plugin"
    _write_alpha_compactor(pdir)
    _write_plugin(
        pdir,
        name="alpha-plugin",
        entrypoint="alpha_compaction.AlphaCompaction",
    )
    runtime.llm = _make_test_llm("main-chat")
    runtime.compaction_llm = _make_test_llm("compact-chat")
    runtime.compaction = resolve_plugin_compactor(plugins, "alpha-plugin")
    assert runtime.compaction is not None

    soul, context = _make_soul(runtime, tmp_path)
    await context.append_message(
        [
            Message(role="user", content=[TextPart(text="message 1")]),
            Message(role="assistant", content=[TextPart(text="message 2")]),
            Message(role="user", content=[TextPart(text="message 3")]),
            Message(role="assistant", content=[TextPart(text="message 4")]),
        ]
    )

    wire = Wire()
    wire_ui = wire.ui_side(merge=False)
    token = _current_wire.set(wire)
    try:
        await soul.compact_context()
    finally:
        _current_wire.reset(token)

    begin = await wire_ui.receive()
    end = await wire_ui.receive()
    assert isinstance(begin, CompactionBegin)
    assert isinstance(end, CompactionEnd)
    assert getattr(runtime.compaction, "calls", 0) == 1
    assert getattr(runtime.compaction, "last_model", None) == "compact-chat"
    assert [message.extract_text("\n") for message in context.history] == [
        "plugin compacted via compact-chat"
    ]
