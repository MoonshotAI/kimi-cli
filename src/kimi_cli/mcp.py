import json
from pathlib import Path
from typing import Annotated, Any

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
    except json.JSONDecodeError:
        return {"mcpServers": {}}


def _save_mcp_config(config: dict[str, Any]) -> None:
    """Save MCP config to default file."""
    mcp_file = get_global_mcp_config_file()
    mcp_file.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


@cli.command("add")
def mcp_add(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to add."),
    ],
    command: Annotated[
        str,
        typer.Option(
            "--command",
            "-c",
            help="Command to run the MCP server.",
        ),
    ],
    args: Annotated[
        list[str] | None,
        typer.Option(
            "--arg",
            "-a",
            help="Arguments for the command. Can be specified multiple times.",
        ),
    ] = None,
    env: Annotated[
        list[str] | None,
        typer.Option(
            "--env",
            "-e",
            help="Environment variables in KEY=VALUE format. Can be specified multiple times.",
        ),
    ] = None,
):
    """Add an MCP server."""
    config = _load_mcp_config()
    server_config: dict[str, Any] = {"command": command, "args": args or []}

    if env:
        env_dict: dict[str, str] = {}
        for item in env:
            if "=" not in item:
                typer.echo(f"Invalid env format: {item} (expected KEY=VALUE)", err=True)
                raise typer.Exit(code=1)
            key, value = item.split("=", 1)
            if not key:
                typer.echo(f"Invalid env format: {item} (empty key)", err=True)
                raise typer.Exit(code=1)
            env_dict[key] = value
        server_config["env"] = env_dict

    if "mcpServers" not in config:
        config["mcpServers"] = {}
    config["mcpServers"][name] = server_config
    _save_mcp_config(config)
    typer.echo(f"Added MCP server '{name}' to {get_global_mcp_config_file()}")


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
    typer.echo(f"Removed MCP server '{name}' from {get_global_mcp_config_file()}")


@cli.command("list")
def mcp_list():
    """List all MCP servers."""
    config = _load_mcp_config()
    servers: dict[str, Any] = config.get("mcpServers", {})

    if not servers:
        typer.echo("No MCP servers configured.")
        return

    for name, server in servers.items():
        cmd = server.get("command", "")
        cmd_args = " ".join(server.get("args", []))
        line = f"{name}: {cmd} {cmd_args}".rstrip()
        typer.echo(f"  {line}")
