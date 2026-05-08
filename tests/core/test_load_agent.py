"""Tests for agent loading functionality."""

from __future__ import annotations

import tempfile
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from inline_snapshot import snapshot

from kimi_cli.config import Config
from kimi_cli.exception import InvalidToolError, SystemPromptTemplateError
from kimi_cli.session import Session
from kimi_cli.soul.agent import BuiltinSystemPromptArgs, Runtime, _load_system_prompt, load_agent
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.utils.environment import Environment


def test_load_system_prompt(system_prompt_file: Path, builtin_args: BuiltinSystemPromptArgs):
    """Test loading system prompt with template substitution."""
    prompt = _load_system_prompt(system_prompt_file, {"CUSTOM_ARG": "test_value"}, builtin_args)

    assert "Test system prompt with " in prompt
    assert "1970-01-01" in prompt  # Should contain the actual timestamp
    assert builtin_args.KIMI_NOW in prompt
    assert "test_value" in prompt


def test_system_prompt_contains_platform_info(builtin_args: BuiltinSystemPromptArgs):
    """System prompt should contain OS and shell information (issue #1649).

    On Windows, the model needs to know it's on Windows so it doesn't
    generate Linux commands. The platform info must be in the system prompt,
    not just in tool descriptions.
    """
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE

    prompt = _load_system_prompt(
        DEFAULT_AGENT_FILE.parent / "system.md",
        {"ROLE_ADDITIONAL": ""},
        builtin_args,
    )

    # System prompt must include OS kind and shell info
    assert builtin_args.KIMI_OS in prompt
    assert builtin_args.KIMI_SHELL in prompt


@pytest.mark.parametrize(
    "os_kind, shell, expect_windows_warning",
    [
        ("Windows", "Windows PowerShell (`powershell.exe`)", True),
        ("macOS", "bash (`/bin/bash`)", False),
        ("Linux", "bash (`/usr/bin/bash`)", False),
    ],
    ids=["windows", "macos", "linux"],
)
def test_system_prompt_platform_warning(temp_work_dir, os_kind, shell, expect_windows_warning):
    """System prompt should include Windows command warning only on Windows."""
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE

    args = BuiltinSystemPromptArgs(
        KIMI_NOW="1970-01-01T00:00:00+00:00",
        KIMI_WORK_DIR=temp_work_dir,
        KIMI_WORK_DIR_LS="Test ls content",
        KIMI_AGENTS_MD="Test agents content",
        KIMI_SKILLS="No skills found.",
        KIMI_ADDITIONAL_DIRS_INFO="",
        KIMI_OS=os_kind,
        KIMI_SHELL=shell,
    )
    prompt = _load_system_prompt(
        DEFAULT_AGENT_FILE.parent / "system.md",
        {"ROLE_ADDITIONAL": ""},
        args,
    )

    assert os_kind in prompt
    assert shell in prompt
    if expect_windows_warning:
        assert "Many common Unix commands are not available" in prompt
    else:
        assert "Many common Unix commands are not available" not in prompt


def test_load_system_prompt_allows_literal_dollar(builtin_args: BuiltinSystemPromptArgs):
    """System prompt should allow literal $ without template errors."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        system_md = tmpdir / "system.md"
        system_md.write_text("Price is $100, path $PATH, time ${KIMI_NOW}.")
        prompt = _load_system_prompt(system_md, {}, builtin_args)

    assert "$100" in prompt
    assert "$PATH" in prompt
    assert builtin_args.KIMI_NOW in prompt


def test_load_system_prompt_include(builtin_args: BuiltinSystemPromptArgs):
    """System prompt should support {% include "file.md" %} directives."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        included = tmpdir / "extra.md"
        included.write_text("Included content here")
        system_md = tmpdir / "system.md"
        system_md.write_text('Main prompt. {% include "extra.md" %} End.')
        prompt = _load_system_prompt(system_md, {}, builtin_args)

    assert "Main prompt." in prompt
    assert "Included content here" in prompt
    assert "End." in prompt


def test_load_system_prompt_missing_arg_raises(builtin_args: BuiltinSystemPromptArgs):
    """Missing template args should raise a dedicated error."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        system_md = tmpdir / "system.md"
        system_md.write_text("Missing ${UNKNOWN_ARG}.")
        with pytest.raises(SystemPromptTemplateError):
            _load_system_prompt(system_md, {}, builtin_args)


def test_load_tools_valid(runtime: Runtime):
    """Test loading valid tools."""
    tool_paths = ["kimi_cli.tools.think:Think", "kimi_cli.tools.shell:Shell"]
    toolset = KimiToolset()
    toolset.load_tools(
        tool_paths,
        {
            Runtime: runtime,
            Config: runtime.config,
            BuiltinSystemPromptArgs: runtime.builtin_args,
            Session: runtime.session,
            DenwaRenji: runtime.denwa_renji,
            Approval: runtime.approval,
            Environment: runtime.environment,
        },
    )
    assert len(toolset.tools) == snapshot(2)


def test_load_tools_invalid(runtime: Runtime):
    """Test loading with invalid tool paths."""
    tool_paths = ["kimi_cli.tools.nonexistent:Tool", "kimi_cli.tools.think:Think"]
    toolset = KimiToolset()
    try:
        toolset.load_tools(
            tool_paths,
            {
                Runtime: runtime,
                Config: runtime.config,
                BuiltinSystemPromptArgs: runtime.builtin_args,
                Session: runtime.session,
                DenwaRenji: runtime.denwa_renji,
                Approval: runtime.approval,
            },
        )
        raise AssertionError("should fail to load non-existing tool")
    except InvalidToolError as e:
        assert "kimi_cli.tools.nonexistent:Tool" in str(e)


async def test_load_agent_invalid_tools(agent_file_invalid_tools: Path, runtime: Runtime):
    """Test loading agent with invalid tools raises ValueError."""
    with pytest.raises(ValueError, match="Invalid tools"):
        await load_agent(agent_file_invalid_tools, runtime, mcp_configs=[])


async def test_load_agent_registers_builtin_subagent_types(runtime: Runtime):
    """Agent loading should register builtin subagent types without instantiating them."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create system prompts
        (tmpdir / "system.md").write_text("Main agent prompt")
        (tmpdir / "sub_system.md").write_text("Sub agent prompt")

        # Create builtin subagent type YAML (no nested subagents, minimal tools)
        builtin_type_yaml = tmpdir / "child.yaml"
        builtin_type_yaml.write_text(
            'version: 1\nagent:\n  name: "Sub"\n'
            "  system_prompt_path: ./sub_system.md\n"
            '  tools: ["kimi_cli.tools.think:Think"]\n'
        )

        # Create main agent YAML that registers one builtin subagent type
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text(
            'version: 1\nagent:\n  name: "Main"\n'
            "  system_prompt_path: ./system.md\n"
            '  tools: ["kimi_cli.tools.think:Think"]\n'
            "  subagents:\n"
            "    coder:\n"
            "      path: ./child.yaml\n"
            '      description: "A sub agent"\n'
        )

        agent = await load_agent(agent_yaml, runtime, mcp_configs=[])

        builtin_type = agent.runtime.labor_market.require_builtin_type("coder")
        assert builtin_type.name == "coder"
        assert builtin_type.description == "A sub agent"
        assert builtin_type.agent_file.samefile(builtin_type_yaml)


async def test_load_agent_starts_mcp_in_background(runtime: Runtime, monkeypatch):
    called: dict[str, bool] = {}

    async def fake_load_mcp_tools(self, mcp_configs, runtime, in_background: bool = True):
        called["in_background"] = in_background

    monkeypatch.setattr(KimiToolset, "load_mcp_tools", fake_load_mcp_tools)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        (tmpdir / "system.md").write_text("Main agent prompt")
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text(
            'version: 1\nagent:\n  name: "Main"\n'
            "  system_prompt_path: ./system.md\n"
            '  tools: ["kimi_cli.tools.think:Think"]\n'
        )

        await load_agent(agent_yaml, runtime, mcp_configs=[{"mcpServers": {}}])

    assert called == {"in_background": True}


async def test_load_agent_can_defer_mcp_loading(runtime: Runtime, monkeypatch):
    called: dict[str, bool] = {}

    async def fake_load_mcp_tools(self, mcp_configs, runtime, in_background: bool = True):
        called["load_called"] = True

    def fake_defer_mcp_tool_loading(self, mcp_configs, runtime):
        called["defer_called"] = True

    monkeypatch.setattr(KimiToolset, "load_mcp_tools", fake_load_mcp_tools)
    monkeypatch.setattr(KimiToolset, "defer_mcp_tool_loading", fake_defer_mcp_tool_loading)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        (tmpdir / "system.md").write_text("Main agent prompt")
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text(
            'version: 1\nagent:\n  name: "Main"\n'
            "  system_prompt_path: ./system.md\n"
            '  tools: ["kimi_cli.tools.think:Think"]\n'
        )

        await load_agent(
            agent_yaml,
            runtime,
            mcp_configs=[{"mcpServers": {}}],
            start_mcp_loading=False,
        )

    assert called == {"defer_called": True}


@pytest.fixture
def agent_file_invalid_tools() -> Generator[Path, Any, Any]:
    """Create an agent configuration file with invalid tools."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create system.md
        system_md = tmpdir / "system.md"
        system_md.write_text("You are a test agent")

        # Create agent.yaml with invalid tools
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.nonexistent:Tool"]
""")

        yield agent_yaml


@pytest.fixture
def system_prompt_file() -> Generator[Path, Any, Any]:
    """Create a system prompt file with template variables."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        system_md = tmpdir / "system.md"
        system_md.write_text("Test system prompt with ${KIMI_NOW} and ${CUSTOM_ARG}")

        yield system_md
