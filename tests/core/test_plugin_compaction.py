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


def _make_test_llm(model_name: str, *, max_context_size: int = 100_000) -> LLM:
    return LLM(
        chat_provider=EchoChatProvider(),
        max_context_size=max_context_size,
        capabilities=set(),
        model_config=LLMModel(
            provider="_echo",
            model=model_name,
            max_context_size=max_context_size,
        ),
    )


def _make_soul(runtime: Runtime, tmp_path: Path) -> tuple[KimiSoul, Context]:
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


def test_resolve_plugin_compactor_rejects_empty_plugin_name(tmp_path: Path) -> None:
    (tmp_path / "plugins").mkdir()
    with pytest.raises(PluginError, match="Plugin name cannot be empty"):
        resolve_plugin_compactor(tmp_path / "plugins", "")


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
async def test_resolve_plugin_compactor_allows_stdlib_colliding_module_names(
    tmp_path: Path,
) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "collision-plugin"
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "json.py").write_text(
        "from kosong.message import Message\nfrom kimi_cli.soul.compaction import CompactionResult\nfrom kimi_cli.wire.types import TextPart\n\nclass MyCompactor:\n    async def compact(self, messages, llm, *, custom_instruction=''):\n        return CompactionResult(messages=[Message(role='user', content=[TextPart(text='json plugin ok')])], usage=None)\n",
        encoding="utf-8",
    )
    _write_plugin(pdir, name="collision-plugin", entrypoint="json.MyCompactor")

    comp = resolve_plugin_compactor(plugins, "collision-plugin")
    assert comp is not None
    result = await comp.compact(
        [Message(role="user", content=[TextPart(text="hi")])], _make_test_llm("main-chat")
    )
    assert result.messages[0].extract_text("\n") == "json plugin ok"

    assert json.dumps({"ok": True}) == '{"ok": true}'


@pytest.mark.asyncio
async def test_resolve_plugin_compactor_supports_lazy_sibling_imports(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "lazy-plugin"
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "helper_mod.py").write_text(
        "def build_message(model_name):\n    return f'lazy via {model_name}'\n",
        encoding="utf-8",
    )
    (pdir / "lazy_compaction.py").write_text(
        "from kosong.message import Message\nfrom kimi_cli.soul.compaction import CompactionResult\nfrom kimi_cli.wire.types import TextPart\n\nclass LazyCompaction:\n    async def compact(self, messages, llm, *, custom_instruction=''):\n        import helper_mod\n        model_name = llm.model_config.model if llm.model_config is not None else 'unknown'\n        return CompactionResult(messages=[Message(role='user', content=[TextPart(text=helper_mod.build_message(model_name))])], usage=None)\n",
        encoding="utf-8",
    )
    _write_plugin(pdir, name="lazy-plugin", entrypoint="lazy_compaction.LazyCompaction")

    comp = resolve_plugin_compactor(plugins, "lazy-plugin")
    assert comp is not None
    result = await comp.compact(
        [Message(role="user", content=[TextPart(text="hi")])], _make_test_llm("main-chat")
    )
    assert result.messages[0].extract_text("\n") == "lazy via main-chat"


@pytest.mark.asyncio
async def test_resolve_plugin_compactor_supports_eager_sibling_imports(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "eager-plugin"
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "helper_mod.py").write_text(
        "def build_message(model_name):\n    return f'eager via {model_name}'\n",
        encoding="utf-8",
    )
    (pdir / "eager_compaction.py").write_text(
        "import helper_mod\nfrom kosong.message import Message\nfrom kimi_cli.soul.compaction import CompactionResult\nfrom kimi_cli.wire.types import TextPart\n\nclass EagerCompaction:\n    async def compact(self, messages, llm, *, custom_instruction=''):\n        model_name = llm.model_config.model if llm.model_config is not None else 'unknown'\n        return CompactionResult(messages=[Message(role='user', content=[TextPart(text=helper_mod.build_message(model_name))])], usage=None)\n",
        encoding="utf-8",
    )
    _write_plugin(pdir, name="eager-plugin", entrypoint="eager_compaction.EagerCompaction")

    comp = resolve_plugin_compactor(plugins, "eager-plugin")
    assert comp is not None
    result = await comp.compact(
        [Message(role="user", content=[TextPart(text="hi")])], _make_test_llm("main-chat")
    )
    assert result.messages[0].extract_text("\n") == "eager via main-chat"


def test_resolve_plugin_compactor_wraps_import_failures(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "broken-plugin"
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "broken_compaction.py").write_text(
        "import missing_helper\n\nclass BrokenCompaction:\n    async def compact(self, messages, llm, *, custom_instruction=''):\n        return messages\n",
        encoding="utf-8",
    )
    _write_plugin(pdir, name="broken-plugin", entrypoint="broken_compaction.BrokenCompaction")

    with pytest.raises(PluginError, match="Failed to import compaction module 'broken_compaction'"):
        resolve_plugin_compactor(plugins, "broken-plugin")


def test_subagent_copies_get_fresh_compaction_instances(runtime: Runtime, tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "alpha-plugin"
    _write_alpha_compactor(pdir)
    _write_plugin(pdir, name="alpha-plugin", entrypoint="alpha_compaction.AlphaCompaction")

    runtime.compaction = resolve_plugin_compactor(plugins, "alpha-plugin")
    assert runtime.compaction is not None

    subagent_a = runtime.copy_for_subagent(agent_id="alpha-one", subagent_type="coder")
    subagent_b = runtime.copy_for_subagent(agent_id="alpha-two", subagent_type="plan")

    assert subagent_a.compaction is not runtime.compaction
    assert subagent_b.compaction is not runtime.compaction
    assert subagent_a.compaction is not subagent_b.compaction
    assert getattr(type(subagent_a.compaction), "PLUGIN_MARK", None) == "alpha"
    assert getattr(type(subagent_b.compaction), "PLUGIN_MARK", None) == "alpha"


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


@pytest.mark.asyncio
async def test_compact_context_falls_back_to_active_llm_when_compaction_llm_is_too_small(
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
    runtime.llm = _make_test_llm("main-chat", max_context_size=200_000)
    runtime.compaction_llm = _make_test_llm("compact-chat", max_context_size=50_000)
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

    token = _current_wire.set(Wire())
    try:
        await soul.compact_context()
    finally:
        _current_wire.reset(token)

    assert getattr(runtime.compaction, "last_model", None) == "main-chat"
