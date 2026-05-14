from __future__ import annotations


def test_stdio_mcp_stderr_goes_to_kimi_log_file(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from fastmcp.client.transports import StdioTransport
    from fastmcp.mcp_config import MCPConfig

    from kimi_cli.soul.toolset import _build_mcp_client

    mcp_config = MCPConfig.model_validate(
        {
            "mcpServers": {
                "chrome/devtools": {
                    "command": "npx",
                    "args": ["-y", "chrome-devtools-mcp@latest"],
                }
            }
        }
    )
    server_config = mcp_config.mcpServers["chrome/devtools"]

    client = _build_mcp_client("chrome/devtools", server_config)

    assert isinstance(client.transport, StdioTransport)
    assert client.transport.log_file == tmp_path / "logs" / "mcp" / "chrome_devtools.log"
    assert (tmp_path / "logs" / "mcp").is_dir()


def test_transforming_stdio_mcp_config_keeps_fastmcp_transport(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from fastmcp.client.transports.config import MCPConfigTransport
    from fastmcp.mcp_config import MCPConfig

    from kimi_cli.soul.toolset import _build_mcp_client

    mcp_config = MCPConfig.model_validate(
        {
            "mcpServers": {
                "filtered": {
                    "command": "npx",
                    "args": ["-y", "some-mcp-server"],
                    "include_tags": ["safe"],
                }
            }
        }
    )
    server_config = mcp_config.mcpServers["filtered"]

    client = _build_mcp_client("filtered", server_config)

    assert isinstance(client.transport, MCPConfigTransport)
    assert client.transport.config.mcpServers["filtered"].include_tags == {"safe"}
