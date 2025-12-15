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
    mcp_file = get_global_mcp_config_file()
    if not mcp_file.exists():
        return {"mcpServers": {}}
    try:
        return json.loads(mcp_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON in MCP config file '{mcp_file}': {e}") from e


def _save_mcp_config(config: dict[str, Any]) -> None:
    """Save MCP config to default file."""
    mcp_file = get_global_mcp_config_file()
    mcp_file.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


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
            help=("For http transport: server URL. For stdio: command to run (prefix with `--`)."),
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
    config = _load_mcp_config()

    if "mcpServers" not in config or name not in config["mcpServers"]:
        typer.echo(f"MCP server '{name}' not found.", err=True)
        raise typer.Exit(code=1)

    del config["mcpServers"][name]
    _save_mcp_config(config)
    typer.echo(f"Removed MCP server '{name}' from {get_global_mcp_config_file()}.")


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
        else:
            line = f"{name}: {server}"
        typer.echo(f"  {line}")
