from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from kimi_cli.config import Config
from kimi_cli.plugin import PluginToolSpec
from kimi_cli.plugin.tool import PluginTool, load_plugin_tools


def _dummy_config() -> Config:
    """Create a minimal Config for testing."""
    return Config()


def _make_plugin_with_tool(tmp_path: Path, script_content: str) -> Path:
    """Create a plugin dir with a tool script."""
    plugin_dir = tmp_path / "test-plugin"
    plugin_dir.mkdir()
    scripts_dir = plugin_dir / "scripts"
    scripts_dir.mkdir()
    (scripts_dir / "tool.py").write_text(script_content, encoding="utf-8")
    (plugin_dir / "plugin.json").write_text(
        json.dumps(
            {
                "name": "test-plugin",
                "version": "1.0.0",
                "tools": [
                    {
                        "name": "test_tool",
                        "description": "A test tool",
                        "command": [sys.executable, "scripts/tool.py"],
                        "parameters": {
                            "type": "object",
                            "properties": {"msg": {"type": "string"}},
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return plugin_dir


@pytest.mark.asyncio
async def test_plugin_tool_executes_and_returns_stdout(tmp_path: Path):
    plugin_dir = _make_plugin_with_tool(
        tmp_path,
        """
import json, sys
params = json.loads(sys.stdin.read())
print(f"hello {params.get('msg', 'world')}")
""",
    )

    tool_spec = PluginToolSpec(
        name="test_tool",
        description="test",
        command=[sys.executable, "scripts/tool.py"],
    )
    tool = PluginTool(tool_spec, plugin_dir=plugin_dir, inject={}, config=_dummy_config())
    result = await tool(msg="agent")
    assert "hello agent" in str(result)


@pytest.mark.asyncio
async def test_plugin_tool_returns_error_on_nonzero_exit(tmp_path: Path):
    plugin_dir = _make_plugin_with_tool(
        tmp_path,
        """
import sys
print("something went wrong", file=sys.stderr)
sys.exit(1)
""",
    )

    tool_spec = PluginToolSpec(
        name="test_tool",
        description="test",
        command=[sys.executable, "scripts/tool.py"],
    )
    tool = PluginTool(tool_spec, plugin_dir=plugin_dir, inject={}, config=_dummy_config())
    result = await tool()
    assert "failed" in str(result).lower() or "error" in str(result).lower()


@pytest.mark.asyncio
async def test_plugin_tool_empty_stdin(tmp_path: Path):
    plugin_dir = _make_plugin_with_tool(
        tmp_path,
        """
import json, sys
params = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
print(f"mode={params.get('mode', 'default')}")
""",
    )

    tool_spec = PluginToolSpec(
        name="test_tool",
        description="test",
        command=[sys.executable, "scripts/tool.py"],
    )
    tool = PluginTool(tool_spec, plugin_dir=plugin_dir, inject={}, config=_dummy_config())
    result = await tool()
    assert "mode=default" in str(result)


@pytest.mark.asyncio
async def test_plugin_tool_injects_env_vars(tmp_path: Path):
    """Host credentials should be injected as env vars at runtime."""
    from pydantic import SecretStr

    from kimi_cli.config import Config, LLMModel, LLMProvider

    plugin_dir = _make_plugin_with_tool(
        tmp_path,
        """
import os, json
print(json.dumps({"key": os.environ.get("myApiKey", ""), "url": os.environ.get("myUrl", "")}))
""",
    )

    config = Config(
        default_model="test",
        models={"test": LLMModel(provider="p", model="m", max_context_size=1000)},
        providers={
            "p": LLMProvider(
                type="openai_responses",
                base_url="https://test.api/v1",
                api_key=SecretStr("sk-fresh-token"),
            )
        },
    )

    tool_spec = PluginToolSpec(
        name="test_tool",
        description="test",
        command=[sys.executable, "scripts/tool.py"],
    )
    tool = PluginTool(
        tool_spec,
        plugin_dir=plugin_dir,
        inject={"myApiKey": "api_key", "myUrl": "base_url"},
        config=config,
    )
    result = await tool()
    data = json.loads(str(result.output))
    assert data["key"] == "sk-fresh-token"
    assert data["url"] == "https://test.api/v1"


def test_load_plugin_tools_discovers_tools(tmp_path: Path):
    plugins_dir = tmp_path / "plugins"
    plugin_dir = plugins_dir / "my-plugin"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps(
            {
                "name": "my-plugin",
                "version": "1.0.0",
                "tools": [
                    {
                        "name": "my_tool",
                        "description": "does things",
                        "command": ["echo", "hi"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    tools = load_plugin_tools(plugins_dir, _dummy_config())
    assert len(tools) == 1
    assert tools[0].name == "my_tool"


def test_load_plugin_tools_empty_dir(tmp_path: Path):
    assert load_plugin_tools(tmp_path / "nonexistent", _dummy_config()) == []


def test_load_plugin_tools_skips_plugins_without_tools(tmp_path: Path):
    plugins_dir = tmp_path / "plugins"
    plugin_dir = plugins_dir / "no-tools"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"name": "no-tools", "version": "1.0.0"}),
        encoding="utf-8",
    )

    tools = load_plugin_tools(plugins_dir, _dummy_config())
    assert len(tools) == 0
