"""Tests for agent loading functionality."""

import tempfile
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from inline_snapshot import snapshot

from kimi_cli.agent import (
    DEFAULT_AGENT_FILE,
    AgentGlobals,
    AgentSpec,
    BuiltinSystemPromptArgs,
    _load_agent_spec,
    _load_system_prompt,
    _load_tools,
    load_agent,
    load_agents_md,
)
from kimi_cli.config import Config
from kimi_cli.metadata import Session
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.toolset import CustomToolset


def test_load_agent_basic(agent_file: Path, agent_globals: AgentGlobals):
    """Test loading a basic agent configuration."""
    agent = load_agent(agent_file, agent_globals)

    assert agent.name == "Test Agent"
    assert "You are a test agent" in agent.system_prompt
    assert agent.toolset is not None


def test_load_agent_missing_name(agent_file_no_name: Path, agent_globals: AgentGlobals):
    """Test loading agent with missing name raises ValueError."""
    with pytest.raises(ValueError, match="Agent name is required"):
        load_agent(agent_file_no_name, agent_globals)


def test_load_agent_missing_system_prompt(agent_file_no_prompt: Path, agent_globals: AgentGlobals):
    """Test loading agent with missing system prompt path raises ValueError."""
    with pytest.raises(ValueError, match="System prompt path is required"):
        load_agent(agent_file_no_prompt, agent_globals)


def test_load_agent_missing_tools(agent_file_no_tools: Path, agent_globals: AgentGlobals):
    """Test loading agent with missing tools raises ValueError."""
    with pytest.raises(ValueError, match="Tools are required"):
        load_agent(agent_file_no_tools, agent_globals)


def test_load_agent_with_exclude_tools(agent_file_with_tools: Path, agent_globals: AgentGlobals):
    """Test loading agent with excluded tools."""
    agent = load_agent(agent_file_with_tools, agent_globals)

    # Should have loaded some tools but excluded the specified ones
    assert agent.toolset is not None
    # Note: We can't easily test the exact tool exclusion without more complex setup


def test_load_agent_spec_extension(agent_file_extending: Path):
    """Test loading agent spec with extension."""
    spec = _load_agent_spec(agent_file_extending)

    assert isinstance(spec, AgentSpec)
    assert spec.name == "Extended Agent"
    assert spec.extend is None  # Should be resolved after extension
    assert spec.tools is not None


def test_load_agent_spec_default_extension():
    """Test loading agent spec with default extension."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create extending agent
        extending_agent = tmpdir / "extending.yaml"
        extending_agent.write_text("""
version: 1
agent:
  extend: default
  system_prompt_args:
    CUSTOM_ARG: "custom_value"
  exclude_tools:
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
""")

        spec = _load_agent_spec(extending_agent)

        assert spec.name == snapshot("")
        assert spec.system_prompt_path == DEFAULT_AGENT_FILE.parent / "system.md"
        assert spec.system_prompt_args == snapshot(
            {"ROLE_ADDITIONAL": "", "CUSTOM_ARG": "custom_value"}
        )
        assert spec.tools == snapshot(
            [
                "kimi_cli.tools.task:Task",
                "kimi_cli.tools.think:Think",
                "kimi_cli.tools.todo:SetTodoList",
                "kimi_cli.tools.bash:Bash",
                "kimi_cli.tools.file:ReadFile",
                "kimi_cli.tools.file:Glob",
                "kimi_cli.tools.file:Grep",
                "kimi_cli.tools.file:WriteFile",
                "kimi_cli.tools.file:StrReplaceFile",
                "kimi_cli.tools.web:SearchWeb",
                "kimi_cli.tools.web:FetchURL",
            ]
        )
        assert spec.exclude_tools == snapshot(
            ["kimi_cli.tools.web:SearchWeb", "kimi_cli.tools.web:FetchURL"]
        )
        assert spec.subagents is not None
        assert "koder" in spec.subagents


def test_load_system_prompt(system_prompt_file: Path, builtin_args: BuiltinSystemPromptArgs):
    """Test loading system prompt with template substitution."""
    prompt = _load_system_prompt(system_prompt_file, {"CUSTOM_ARG": "test_value"}, builtin_args)

    assert "Test system prompt with " in prompt
    assert "1970-01-01" in prompt  # Should contain the actual timestamp
    assert builtin_args.KIMI_NOW in prompt
    assert "test_value" in prompt


def test_load_tools_valid(agent_globals: AgentGlobals):
    """Test loading valid tools."""
    tool_paths = ["kimi_cli.tools.think:Think", "kimi_cli.tools.bash:Bash"]
    toolset = CustomToolset()
    bad_tools = _load_tools(
        toolset,
        tool_paths,
        {
            AgentGlobals: agent_globals,
            Config: agent_globals.config,
            BuiltinSystemPromptArgs: agent_globals.builtin_args,
            Session: agent_globals.session,
            DenwaRenji: agent_globals.denwa_renji,
            Approval: agent_globals.approval,
        },
    )

    assert len(bad_tools) == 0
    assert toolset is not None


def test_load_tools_invalid(agent_globals: AgentGlobals):
    """Test loading with invalid tool paths."""
    tool_paths = ["kimi_cli.tools.nonexistent:Tool", "kimi_cli.tools.think:Think"]
    toolset = CustomToolset()
    bad_tools = _load_tools(
        toolset,
        tool_paths,
        {
            AgentGlobals: agent_globals,
            Config: agent_globals.config,
            BuiltinSystemPromptArgs: agent_globals.builtin_args,
            Session: agent_globals.session,
            DenwaRenji: agent_globals.denwa_renji,
            Approval: agent_globals.approval,
        },
    )

    assert len(bad_tools) == 1
    assert "kimi_cli.tools.nonexistent:Tool" in bad_tools


def test_load_agents_md_found(temp_work_dir: Path):
    """Test loading AGENTS.md when it exists."""
    agents_md = temp_work_dir / "AGENTS.md"
    agents_md.write_text("Test agents content")

    content = load_agents_md(temp_work_dir)

    assert content == "Test agents content"


def test_load_agents_md_not_found(temp_work_dir: Path):
    """Test loading AGENTS.md when it doesn't exist."""
    content = load_agents_md(temp_work_dir)

    assert content is None


def test_load_agents_md_lowercase(temp_work_dir: Path):
    """Test loading agents.md (lowercase)."""
    agents_md = temp_work_dir / "agents.md"
    agents_md.write_text("Lowercase agents content")

    content = load_agents_md(temp_work_dir)

    assert content == "Lowercase agents content"


def test_load_agent_invalid_tools(agent_file_invalid_tools: Path, agent_globals: AgentGlobals):
    """Test loading agent with invalid tools raises ValueError."""
    with pytest.raises(ValueError, match="Invalid tools"):
        load_agent(agent_file_invalid_tools, agent_globals)


def test_load_agent_spec_unsupported_version():
    """Test loading agent spec with unsupported version raises ValueError."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 2
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
""")

        with pytest.raises(ValueError, match="Unsupported agent spec version: 2"):
            _load_agent_spec(agent_yaml)


def test_load_agent_spec_nonexistent_file():
    """Test loading nonexistent agent spec file raises AssertionError."""
    nonexistent = Path("/nonexistent/agent.yaml")
    with pytest.raises(AssertionError, match="expect agent file to exist"):
        _load_agent_spec(nonexistent)


# Fixtures for test files


@pytest.fixture
def agent_file() -> Generator[Path, Any, Any]:
    """Create a basic agent configuration file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create system.md
        system_md = tmpdir / "system.md"
        system_md.write_text("You are a test agent")

        # Create agent.yaml
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
""")

        yield agent_yaml


@pytest.fixture
def agent_file_no_name() -> Generator[Path, Any, Any]:
    """Create an agent configuration file without name."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create system.md
        system_md = tmpdir / "system.md"
        system_md.write_text("You are a test agent")

        # Create agent.yaml
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 1
agent:
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
""")

        yield agent_yaml


@pytest.fixture
def agent_file_no_prompt() -> Generator[Path, Any, Any]:
    """Create an agent configuration file without system prompt path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create agent.yaml
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 1
agent:
  name: "Test Agent"
  tools: ["kimi_cli.tools.think:Think"]
""")

        yield agent_yaml


@pytest.fixture
def agent_file_no_tools() -> Generator[Path, Any, Any]:
    """Create an agent configuration file without tools."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create system.md
        system_md = tmpdir / "system.md"
        system_md.write_text("You are a test agent")

        # Create agent.yaml
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
""")

        yield agent_yaml


@pytest.fixture
def agent_file_with_tools() -> Generator[Path, Any, Any]:
    """Create an agent configuration file with tools and exclude_tools."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create system.md
        system_md = tmpdir / "system.md"
        system_md.write_text("You are a test agent")

        # Create agent.yaml
        agent_yaml = tmpdir / "agent.yaml"
        agent_yaml.write_text("""
version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think", "kimi_cli.tools.bash:Bash"]
  exclude_tools: ["kimi_cli.tools.bash:Bash"]
""")

        yield agent_yaml


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
def agent_file_extending() -> Generator[Path, Any, Any]:
    """Create an agent configuration file that extends another."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create base agent
        base_agent = tmpdir / "base.yaml"
        base_agent.write_text("""
version: 1
agent:
  name: "Base Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
""")

        # Create system.md
        system_md = tmpdir / "system.md"
        system_md.write_text("Base system prompt")

        # Create extending agent
        extending_agent = tmpdir / "extending.yaml"
        extending_agent.write_text("""
version: 1
agent:
  extend: ./base.yaml
  name: "Extended Agent"
  system_prompt_args:
    CUSTOM_ARG: "custom_value"
""")

        yield extending_agent


@pytest.fixture
def system_prompt_file() -> Generator[Path, Any, Any]:
    """Create a system prompt file with template variables."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        system_md = tmpdir / "system.md"
        system_md.write_text("Test system prompt with ${KIMI_NOW} and ${CUSTOM_ARG}")

        yield system_md
