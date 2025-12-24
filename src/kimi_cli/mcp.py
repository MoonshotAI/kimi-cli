import json
from pathlib import Path
from typing import Annotated, Any, Literal

import typer

cli = typer.Typer(help="Manage MCP server configurations.")


def get_global_mcp_config_file() -> Path:
    """Get the global MCP config file path."""
    from kimi_cli.share import get_share_dir

    return get_share_dir() / "mcp.json"


def _load_mcp_config() -> dict[str, Any]:
    """Load MCP config from global mcp config file."""
    from fastmcp.mcp_config import MCPConfig
    from pydantic import ValidationError

    mcp_file = get_global_mcp_config_file()
    if not mcp_file.exists():
        return {"mcpServers": {}}
    try:
        config = json.loads(mcp_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON in MCP config file '{mcp_file}': {e}") from e

    try:
        MCPConfig.model_validate(config)
    except ValidationError as e:
        raise typer.BadParameter(f"Invalid MCP config in '{mcp_file}': {e}") from e

    return config


def _save_mcp_config(config: dict[str, Any]) -> None:
    """Save MCP config to default file."""
    mcp_file = get_global_mcp_config_file()
    mcp_file.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def _get_mcp_server(name: str, *, require_remote: bool = False) -> dict[str, Any]:
    """Get MCP server config by name."""
    config = _load_mcp_config()
    servers = config.get("mcpServers", {})
    if name not in servers:
        typer.echo(f"MCP server '{name}' not found.", err=True)
        raise typer.Exit(code=1)
    server = servers[name]
    if require_remote and "url" not in server:
        typer.echo(f"MCP server '{name}' is not a remote server.", err=True)
        raise typer.Exit(code=1)
    return server


def _parse_key_value_pairs(
    items: list[str], option_name: str, *, separator: str = "=", strip_whitespace: bool = False
) -> dict[str, str]:
    """Parse key/value pairs from CLI options."""
    parsed: dict[str, str] = {}
    for item in items:
        if separator not in item:
            typer.echo(
                f"Invalid {option_name} format: {item} (expected KEY{separator}VALUE).",
                err=True,
            )
            raise typer.Exit(code=1)
        key, value = item.split(separator, 1)
        if strip_whitespace:
            key, value = key.strip(), value.strip()
        if not key:
            typer.echo(f"Invalid {option_name} format: {item} (empty key).", err=True)
            raise typer.Exit(code=1)
        parsed[key] = value
    return parsed


Transport = Literal["stdio", "http"]


@cli.command(
    "add",
    epilog="""
    Examples:\n
      \n
      # Add streamable HTTP server:\n
      kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header \"CONTEXT7_API_KEY: ctx7sk-your-key\"\n
      \n
      # Add streamable HTTP server with OAuth authorization:\n
      kimi mcp add --transport http --auth oauth linear https://mcp.linear.app/mcp\n
      \n
      # Add stdio server:\n
      kimi mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest
    """.strip(),  # noqa: E501
)
def mcp_add(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to add."),
    ],
    server_args: Annotated[
        list[str] | None,
        typer.Argument(
            metavar="TARGET_OR_COMMAND...",
            help="For http: server URL. For stdio: command to run (prefix with `--`).",
        ),
    ] = None,
    transport: Annotated[
        Transport,
        typer.Option(
            "--transport",
            "-t",
            help="Transport type for the MCP server. Default: stdio.",
        ),
    ] = "stdio",
    env: Annotated[
        list[str] | None,
        typer.Option(
            "--env",
            "-e",
            help="Environment variables in KEY=VALUE format. Can be specified multiple times.",
        ),
    ] = None,
    header: Annotated[
        list[str] | None,
        typer.Option(
            "--header",
            "-H",
            help="HTTP headers in KEY:VALUE format. Can be specified multiple times.",
        ),
    ] = None,
    auth: Annotated[
        str | None,
        typer.Option(
            "--auth",
            "-a",
            help="Authorization type (e.g., 'oauth').",
        ),
    ] = None,
):
    """Add an MCP server."""
    config = _load_mcp_config()
    server_args = server_args or []

    if transport not in {"stdio", "http"}:
        typer.echo(f"Unsupported transport: {transport}.", err=True)
        raise typer.Exit(code=1)

    if transport == "stdio":
        if not server_args:
            typer.echo(
                "For stdio transport, provide the command to start the MCP server after `--`.",
                err=True,
            )
            raise typer.Exit(code=1)
        if header:
            typer.echo("--header is only valid for http transport.", err=True)
            raise typer.Exit(code=1)
        if auth:
            typer.echo("--auth is only valid for http transport.", err=True)
            raise typer.Exit(code=1)
        command, *command_args = server_args
        server_config: dict[str, Any] = {"command": command, "args": command_args}
        if env:
            server_config["env"] = _parse_key_value_pairs(env, "env")
    else:
        if env:
            typer.echo("--env is only supported for stdio transport.", err=True)
            raise typer.Exit(code=1)
        if not server_args:
            typer.echo("URL is required for http transport.", err=True)
            raise typer.Exit(code=1)
        if len(server_args) > 1:
            typer.echo(
                "Multiple targets provided. Supply a single URL for http transport.",
                err=True,
            )
            raise typer.Exit(code=1)
        server_config = {"url": server_args[0], "transport": "http"}
        if header:
            server_config["headers"] = _parse_key_value_pairs(
                header, "header", separator=":", strip_whitespace=True
            )
        if auth:
            server_config["auth"] = auth

    if "mcpServers" not in config:
        config["mcpServers"] = {}
    config["mcpServers"][name] = server_config
    _save_mcp_config(config)
    typer.echo(f"Added MCP server '{name}' to {get_global_mcp_config_file()}.")


@cli.command("remove")
def mcp_remove(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to remove."),
    ],
):
    """Remove an MCP server."""
    _get_mcp_server(name)
    config = _load_mcp_config()
    del config["mcpServers"][name]
    _save_mcp_config(config)
    typer.echo(f"Removed MCP server '{name}' from {get_global_mcp_config_file()}.")


def _has_oauth_tokens(server_url: str) -> bool:
    """Check if OAuth tokens exist for the server."""
    import asyncio

    async def _check() -> bool:
        try:
            from fastmcp.client.auth.oauth import FileTokenStorage

            storage = FileTokenStorage(server_url=server_url)
            tokens = await storage.get_tokens()
            return tokens is not None
        except Exception:
            return False

    return asyncio.run(_check())


@cli.command("list")
def mcp_list():
    """List all MCP servers."""
    config_file = get_global_mcp_config_file()
    config = _load_mcp_config()
    servers: dict[str, Any] = config.get("mcpServers", {})

    typer.echo(f"MCP config file: {config_file}")
    if not servers:
        typer.echo("No MCP servers configured.")
        return

    for name, server in servers.items():
        if "command" in server:
            cmd = server["command"]
            cmd_args = " ".join(server.get("args", []))
            line = f"{name} (stdio): {cmd} {cmd_args}".rstrip()
        elif "url" in server:
            transport = server.get("transport") or "http"
            if transport == "streamable-http":
                transport = "http"
            line = f"{name} ({transport}): {server['url']}"
            if server.get("auth") == "oauth" and not _has_oauth_tokens(server["url"]):
                line += " [authorization required - run: kimi mcp auth " + name + "]"
        else:
            line = f"{name}: {server}"
        typer.echo(f"  {line}")


@cli.command("auth")
def mcp_auth(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to authorize."),
    ],
):
    """Authorize with an OAuth-enabled MCP server."""
    import asyncio

    server = _get_mcp_server(name, require_remote=True)
    if server.get("auth") != "oauth":
        typer.echo(f"MCP server '{name}' does not use OAuth. Add with --auth oauth.", err=True)
        raise typer.Exit(code=1)

    async def _auth() -> None:
        import fastmcp

        typer.echo(f"Authorizing with '{name}'...")
        typer.echo("A browser window will open for authorization.")

        client = fastmcp.Client({"mcpServers": {name: server}})
        try:
            async with client:
                tools = await client.list_tools()
                typer.echo(f"Successfully authorized with '{name}'.")
                typer.echo(f"Available tools: {len(tools)}")
        except Exception as e:
            typer.echo(f"Authorization failed: {type(e).__name__}: {e}", err=True)
            raise typer.Exit(code=1) from None

    asyncio.run(_auth())


@cli.command("reset-auth")
def mcp_reset_auth(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to reset authorization."),
    ],
):
    """Reset OAuth authorization for an MCP server (clear cached tokens)."""
    server = _get_mcp_server(name, require_remote=True)

    try:
        from fastmcp.client.auth.oauth import FileTokenStorage

        storage = FileTokenStorage(server_url=server["url"])
        storage.clear()
        typer.echo(f"OAuth tokens cleared for '{name}'.")
    except ImportError:
        typer.echo("OAuth support not available.", err=True)
        raise typer.Exit(code=1) from None
    except Exception as e:
        typer.echo(f"Failed to clear tokens: {type(e).__name__}: {e}", err=True)
        raise typer.Exit(code=1) from None


@cli.command("test")
def mcp_test(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to test."),
    ],
):
    """Test connection to an MCP server and list available tools."""
    import asyncio

    server = _get_mcp_server(name)

    async def _test() -> None:
        import fastmcp

        typer.echo(f"Testing connection to '{name}'...")
        client = fastmcp.Client({"mcpServers": {name: server}})

        try:
            async with client:
                tools = await client.list_tools()
                typer.echo(f"✓ Connected to '{name}'")
                typer.echo(f"  Available tools: {len(tools)}")
                if tools:
                    typer.echo("  Tools:")
                    for tool in tools:
                        desc = tool.description or ""
                        if len(desc) > 50:
                            desc = desc[:47] + "..."
                        typer.echo(f"    - {tool.name}: {desc}")
        except Exception as e:
            typer.echo(f"✗ Connection failed: {type(e).__name__}: {e}", err=True)
            raise typer.Exit(code=1) from None

    asyncio.run(_test())
