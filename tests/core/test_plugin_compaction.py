from __future__ import annotations

import json
from pathlib import Path

import pytest
from kosong.chat_provider.echo import EchoChatProvider
from kosong.message import Message

from kimi_cli.llm import LLM
from kimi_cli.plugin import PluginError, parse_plugin_json
from kimi_cli.plugin.compaction import resolve_plugin_compactor
from kimi_cli.wire.types import TextPart


def _write_alpha_compactor(plugin_root: Path) -> None:
    (plugin_root / "alpha_compaction.py").write_text(
        """
from collections.abc import Sequence

from kosong.message import Message

from kimi_cli.llm import LLM
from kimi_cli.soul.compaction import CompactionResult


class AlphaCompaction:
    PLUGIN_MARK = "alpha"

    async def compact(
        self, messages: Sequence[Message], llm: LLM, *, custom_instruction: str = ""
    ) -> CompactionResult:
        return CompactionResult(messages=messages, usage=None)
""".strip(),
        encoding="utf-8",
    )


def _write_beta_compactor(plugin_root: Path) -> None:
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


@pytest.mark.asyncio
async def test_resolve_plugin_compactor_loads_entrypoint(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    pdir = plugins / "alpha-plugin"
    pdir.mkdir(parents=True)
    _write_alpha_compactor(pdir)
    (pdir / "plugin.json").write_text(
        json.dumps(
            {
                "name": "alpha-plugin",
                "version": "1.0.0",
                "compaction": {"entrypoint": "alpha_compaction.AlphaCompaction"},
            }
        ),
        encoding="utf-8",
    )

    comp = resolve_plugin_compactor(plugins)
    assert comp is not None
    assert getattr(type(comp), "PLUGIN_MARK", None) == "alpha"

    llm = LLM(
        chat_provider=EchoChatProvider(),
        max_context_size=1000,
        capabilities=set(),
    )
    msgs = [Message(role="user", content=[TextPart(text="hi")])]
    result = await comp.compact(msgs, llm)
    assert result.messages == msgs


def test_resolve_plugin_compactor_first_wins_sorted_order(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    for name, writer in (
        ("alpha-plugin", _write_alpha_compactor),
        ("beta-plugin", _write_beta_compactor),
    ):
        pdir = plugins / name
        pdir.mkdir(parents=True)
        writer(pdir)
        entry = "alpha_compaction.AlphaCompaction" if name == "alpha-plugin" else "beta_compaction.BetaCompaction"
        (pdir / "plugin.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "version": "1.0.0",
                    "compaction": {"entrypoint": entry},
                }
            ),
            encoding="utf-8",
        )

    comp = resolve_plugin_compactor(plugins)
    assert comp is not None
    assert getattr(type(comp), "PLUGIN_MARK", None) == "alpha"


def test_resolve_plugin_compactor_returns_none_for_missing_dir(tmp_path: Path) -> None:
    assert resolve_plugin_compactor(tmp_path / "nope") is None


def test_resolve_plugin_compactor_skips_broken_plugin(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    bad = plugins / "bad-plugin"
    bad.mkdir(parents=True)
    (bad / "plugin.json").write_text(
        json.dumps(
            {
                "name": "bad-plugin",
                "version": "1.0.0",
                "compaction": {"entrypoint": "missing.Mod"},
            }
        ),
        encoding="utf-8",
    )
    good = plugins / "good-plugin"
    good.mkdir(parents=True)
    _write_alpha_compactor(good)
    (good / "plugin.json").write_text(
        json.dumps(
            {
                "name": "good-plugin",
                "version": "1.0.0",
                "compaction": {"entrypoint": "alpha_compaction.AlphaCompaction"},
            }
        ),
        encoding="utf-8",
    )

    comp = resolve_plugin_compactor(plugins)
    assert comp is not None
    assert getattr(type(comp), "PLUGIN_MARK", None) == "alpha"
