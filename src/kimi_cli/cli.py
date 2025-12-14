from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Annotated, Any, Literal

import typer

from kimi_cli.constant import VERSION
from kimi_cli.share import get_default_mcp_config_file


class Reload(Exception):
    """Reload configuration."""

    pass


cli = typer.Typer(
    add_completion=False,
    context_settings={"help_option_names": ["-h", "--help"]},
    help="Kimi, your next CLI agent.",
)

UIMode = Literal["shell", "print", "acp", "wire"]
InputFormat = Literal["text", "stream-json"]
OutputFormat = Literal["text", "stream-json"]


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"kimi, version {VERSION}")
        raise typer.Exit()


@cli.callback(invoke_without_command=True)
def kimi(
    ctx: typer.Context,
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-V",
            help="Show version and exit.",
            callback=_version_callback,
            is_eager=True,
        ),
    ] = False,
    verbose: Annotated[
        bool,
        typer.Option(
            "--verbose",
            help="Print verbose information. Default: no.",
        ),
    ] = False,
    debug: Annotated[
        bool,
        typer.Option(
            "--debug",
            help="Log debug information. Default: no.",
        ),
    ] = False,
    agent: Annotated[
        Literal["default", "okabe"] | None,
        typer.Option(
            "--agent",
            help="Builtin agent specification to use. Default: builtin default agent.",
        ),
    ] = None,
    agent_file: Annotated[
        Path | None,
        typer.Option(
            "--agent-file",
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help="Custom agent specification file. Default: builtin default agent.",
        ),
    ] = None,
    model_name: Annotated[
        str | None,
        typer.Option(
            "--model",
            "-m",
            help="LLM model to use. Default: default model set in config file.",
        ),
    ] = None,
    local_work_dir: Annotated[
        Path | None,
        typer.Option(
            "--work-dir",
            "-w",
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            writable=True,
            help="Working directory for the agent. Default: current directory.",
        ),
    ] = None,
    continue_: Annotated[
        bool,
        typer.Option(
            "--continue",
            "-C",
            help="Continue the previous session for the working directory. Default: no.",
        ),
    ] = False,
    command: Annotated[
        str | None,
        typer.Option(
            "--command",
            "-c",
            "--query",
            "-q",
            help="User query to the agent. Default: prompt interactively.",
        ),
    ] = None,
    print_mode: Annotated[
        bool,
        typer.Option(
            "--print",
            help=(
                "Run in print mode (non-interactive). Note: print mode implicitly adds `--yolo`."
            ),
        ),
    ] = False,
    acp_mode: Annotated[
        bool,
        typer.Option(
            "--acp",
            help="Run as ACP server.",
        ),
    ] = False,
    wire_mode: Annotated[
        bool,
        typer.Option(
            "--wire",
            help="Run as Wire server (experimental).",
        ),
    ] = False,
    input_format: Annotated[
        InputFormat | None,
        typer.Option(
            "--input-format",
            help=(
                "Input format to use. Must be used with `--print` "
                "and the input must be piped in via stdin. "
                "Default: text."
            ),
        ),
    ] = None,
    output_format: Annotated[
        OutputFormat | None,
        typer.Option(
            "--output-format",
            help="Output format to use. Must be used with `--print`. Default: text.",
        ),
    ] = None,
    mcp_config_file: Annotated[
        list[Path] | None,
        typer.Option(
            "--mcp-config-file",
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help=(
                "MCP config file to load. Add this option multiple times to specify multiple MCP "
                "configs. Default: none."
            ),
        ),
    ] = None,
    mcp_config: Annotated[
        list[str] | None,
        typer.Option(
            "--mcp-config",
            help=(
                "MCP config JSON to load. Add this option multiple times to specify multiple MCP "
                "configs. Default: none."
            ),
        ),
    ] = None,
    yolo: Annotated[
        bool,
        typer.Option(
            "--yolo",
            "--yes",
            "-y",
            "--auto-approve",
            help="Automatically approve all actions. Default: no.",
        ),
    ] = False,
    thinking: Annotated[
        bool | None,
        typer.Option(
            "--thinking",
            help="Enable thinking mode if supported. Default: same as last time.",
        ),
    ] = None,
):
    """Kimi, your next CLI agent."""
    if ctx.invoked_subcommand is not None:
        return  # skip rest if a subcommand is invoked

    del version  # handled in the callback

    from kaos.path import KaosPath

    from kimi_cli.agentspec import DEFAULT_AGENT_FILE, OKABE_AGENT_FILE
    from kimi_cli.app import KimiCLI, enable_logging
    from kimi_cli.metadata import load_metadata, save_metadata
    from kimi_cli.session import Session
    from kimi_cli.utils.logging import logger

    enable_logging(debug)

    conflict_option_sets = [
        {
            "--print": print_mode,
            "--acp": acp_mode,
            "--wire": wire_mode,
        },
        {
            "--agent": agent is not None,
            "--agent-file": agent_file is not None,
        },
    ]
    for option_set in conflict_option_sets:
        active_options = [flag for flag, active in option_set.items() if active]
        if len(active_options) > 1:
            raise typer.BadParameter(
                f"Cannot combine {', '.join(active_options)}.",
                param_hint=active_options[0],
            )

    if agent is not None:
        match agent:
            case "default":
                agent_file = DEFAULT_AGENT_FILE
            case "okabe":
                agent_file = OKABE_AGENT_FILE

    ui: UIMode = "shell"
    if print_mode:
        ui = "print"
    elif acp_mode:
        ui = "acp"
    elif wire_mode:
        ui = "wire"

    if command is not None:
        command = command.strip()
        if not command:
            raise typer.BadParameter("Command cannot be empty", param_hint="--command")

    if input_format is not None and ui != "print":
        raise typer.BadParameter(
            "Input format is only supported for print UI",
            param_hint="--input-format",
        )
    if output_format is not None and ui != "print":
        raise typer.BadParameter(
            "Output format is only supported for print UI",
            param_hint="--output-format",
        )

    file_configs = list(mcp_config_file or [])
    raw_mcp_config = list(mcp_config or [])

    # Use default MCP config file if no --mcp-config-file is provided
    if not file_configs:
        default_mcp_file = get_default_mcp_config_file()
        if default_mcp_file.exists():
            file_configs.append(default_mcp_file)

    try:
        mcp_configs = [json.loads(conf.read_text(encoding="utf-8")) for conf in file_configs]
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON: {e}", param_hint="--mcp-config-file") from e

    try:
        mcp_configs += [json.loads(conf) for conf in raw_mcp_config]
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON: {e}", param_hint="--mcp-config") from e

    async def _run() -> bool:
        work_dir = (
            KaosPath.unsafe_from_local_path(local_work_dir) if local_work_dir else KaosPath.cwd()
        )

        if continue_:
            session = await Session.continue_(work_dir)
            if session is None:
                raise typer.BadParameter(
                    "No previous session found for the working directory",
                    param_hint="--continue",
                )
            logger.info("Continuing previous session: {session_id}", session_id=session.id)
        else:
            session = await Session.create(work_dir)
            logger.info("Created new session: {session_id}", session_id=session.id)
        logger.debug("Context file: {context_file}", context_file=session.context_file)

        if thinking is None:
            metadata = load_metadata()
            thinking_mode = metadata.thinking
        else:
            thinking_mode = thinking

        instance = await KimiCLI.create(
            session,
            yolo=yolo or (ui == "print"),  # print mode implies yolo
            mcp_configs=mcp_configs,
            model_name=model_name,
            thinking=thinking_mode,
            agent_file=agent_file,
        )
        match ui:
            case "shell":
                succeeded = await instance.run_shell(command)
            case "print":
                succeeded = await instance.run_print(
                    input_format or "text",
                    output_format or "text",
                    command,
                )
            case "acp":
                if command is not None:
                    logger.warning("ACP server ignores command argument")
                await instance.run_acp()
                succeeded = True
            case "wire":
                if command is not None:
                    logger.warning("Wire server ignores command argument")
                await instance.run_wire_stdio()
                succeeded = True

        if succeeded:
            metadata = load_metadata()

            # Update work_dir metadata with last session
            work_dir_meta = metadata.get_work_dir_meta(session.work_dir)

            if work_dir_meta is None:
                logger.warning(
                    "Work dir metadata missing when marking last session, recreating: {work_dir}",
                    work_dir=session.work_dir,
                )
                work_dir_meta = metadata.new_work_dir_meta(session.work_dir)

            work_dir_meta.last_session_id = session.id

            # Update thinking mode
            metadata.thinking = instance.soul.thinking

            save_metadata(metadata)

        return succeeded

    while True:
        try:
            succeeded = asyncio.run(_run())
            if succeeded:
                break
            raise typer.Exit(code=1)
        except Reload:
            continue


@cli.command()
def acp():
    """Run Kimi CLI ACP server."""
    from kimi_cli.acp import acp_main

    acp_main()


# MCP subcommand group
mcp_cli = typer.Typer(
    help="Manage MCP server configurations in ~/.kimi/mcp.json",
)
cli.add_typer(mcp_cli, name="mcp")

MCPConfigType = dict[str, Any]


def _load_mcp_config() -> MCPConfigType:
    """Load MCP config from default file."""
    mcp_file = get_default_mcp_config_file()
    if not mcp_file.exists():
        return {"mcpServers": {}}
    try:
        return json.loads(mcp_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"mcpServers": {}}


def _save_mcp_config(config: MCPConfigType) -> None:
    """Save MCP config to default file."""
    mcp_file = get_default_mcp_config_file()
    mcp_file.parent.mkdir(parents=True, exist_ok=True)
    mcp_file.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def _get_mcp_server(name: str) -> tuple[MCPConfigType, dict[str, Any]]:
    """Get MCP server config by name.

    Returns:
        Tuple of (full config, server config).

    Raises:
        typer.Exit: If server not found.
    """
    config = _load_mcp_config()
    servers: dict[str, Any] = config.get("mcpServers", {})

    if name not in servers:
        typer.echo(f"MCP server '{name}' not found.", err=True)
        raise typer.Exit(code=1)

    return config, servers[name]


@mcp_cli.command("add")
def mcp_add(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to add."),
    ],
    command: Annotated[
        str | None,
        typer.Option(
            "--command",
            "-c",
            help="Command to run the MCP server (for stdio transport).",
        ),
    ] = None,
    url: Annotated[
        str | None,
        typer.Option(
            "--url",
            "-u",
            help="URL of the MCP server (for http/sse transport).",
        ),
    ] = None,
    transport: Annotated[
        str | None,
        typer.Option(
            "--transport",
            "-t",
            help="Transport type: sse, http, or stdio. Default: auto-detect.",
        ),
    ] = None,
    auth: Annotated[
        str | None,
        typer.Option(
            "--auth",
            help="Authentication type (e.g., 'oauth').",
        ),
    ] = None,
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
    """Add an MCP server to ~/.kimi/mcp.json."""
    if not command and not url:
        typer.echo("Either --command or --url must be provided.", err=True)
        raise typer.Exit(code=1)

    if command and url:
        typer.echo("Cannot specify both --command and --url.", err=True)
        raise typer.Exit(code=1)

    config = _load_mcp_config()
    server_config: dict[str, Any] = {}

    if command:
        # stdio transport
        server_config["command"] = command
        server_config["args"] = args or []
    else:
        # http/sse transport
        assert url is not None
        server_config["url"] = url
        if transport:
            server_config["transport"] = transport
        if auth:
            server_config["auth"] = auth
        if args:
            typer.echo("Warning: --arg is ignored for URL-based servers.", err=True)

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

    action = "Updated" if name in config["mcpServers"] else "Added"
    config["mcpServers"][name] = server_config
    _save_mcp_config(config)
    typer.echo(f"{action} MCP server '{name}' in {get_default_mcp_config_file()}")


@mcp_cli.command("remove")
def mcp_remove(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to remove."),
    ],
):
    """Remove an MCP server from ~/.kimi/mcp.json."""
    config, _ = _get_mcp_server(name)

    del config["mcpServers"][name]
    _save_mcp_config(config)
    typer.echo(f"Removed MCP server '{name}' from {get_default_mcp_config_file()}")


@mcp_cli.command("list")
def mcp_list():
    """List all MCP servers in ~/.kimi/mcp.json."""
    config = _load_mcp_config()
    servers: dict[str, Any] = config.get("mcpServers", {})

    if not servers:
        typer.echo("No MCP servers configured.")
        return

    for name, server in servers.items():
        if "command" in server:
            cmd = server.get("command", "")
            cmd_args = " ".join(server.get("args", []))
            line = f"{name}: {cmd} {cmd_args}".rstrip()
        elif "url" in server:
            url = server.get("url", "")
            auth = server.get("auth", "")
            line = f"{name}: {url}"
            if auth:
                line += f" (auth: {auth})"
        else:
            line = f"{name}: (unknown config)"
        typer.echo(f"  {line}")


@mcp_cli.command("auth")
def mcp_auth(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to authenticate."),
    ],
):
    """Authenticate with an OAuth-enabled MCP server."""
    _, server = _get_mcp_server(name)

    if "url" not in server:
        typer.echo(f"MCP server '{name}' is not a remote server (no URL).", err=True)
        raise typer.Exit(code=1)

    if server.get("auth") != "oauth":
        typer.echo(f"MCP server '{name}' does not use OAuth authentication.", err=True)
        raise typer.Exit(code=1)

    async def _auth() -> None:
        import fastmcp
        from mcp.shared.exceptions import McpError

        typer.echo(f"Authenticating with '{name}'...")
        typer.echo("A browser window will open for authorization.")

        mcp_config = {"mcpServers": {name: server}}
        client = fastmcp.Client(mcp_config)

        try:
            async with client:
                tools = await client.list_tools()
                typer.echo(f"Successfully authenticated with '{name}'.")
                typer.echo(f"Available tools: {len(tools)}")
        except McpError as e:
            typer.echo(f"MCP error: {e}", err=True)
            raise typer.Exit(code=1)
        except TimeoutError:
            typer.echo("Authentication timed out. Please try again.", err=True)
            raise typer.Exit(code=1)
        except Exception as e:
            typer.echo(f"Authentication failed: {type(e).__name__}: {e}", err=True)
            raise typer.Exit(code=1)

    asyncio.run(_auth())


@mcp_cli.command("reset-auth")
def mcp_reset_auth(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to reset authentication."),
    ],
):
    """Reset OAuth authentication for an MCP server (clear cached tokens)."""
    _, server = _get_mcp_server(name)

    if "url" not in server:
        typer.echo(f"MCP server '{name}' is not a remote server (no URL).", err=True)
        raise typer.Exit(code=1)

    if server.get("auth") != "oauth":
        typer.echo(f"MCP server '{name}' does not use OAuth authentication.", err=True)
        raise typer.Exit(code=1)

    url = server["url"]

    # Clear OAuth tokens from fastmcp cache
    try:
        from fastmcp.client.auth.oauth import FileTokenStorage

        storage = FileTokenStorage(server_url=url)
        storage.clear()
        typer.echo(f"OAuth tokens cleared for '{name}'.")
    except ImportError:
        typer.echo("OAuth support not available.", err=True)
        raise typer.Exit(code=1)
    except Exception as e:
        typer.echo(f"Failed to clear tokens: {type(e).__name__}: {e}", err=True)
        raise typer.Exit(code=1)


@mcp_cli.command("test")
def mcp_test(
    name: Annotated[
        str,
        typer.Argument(help="Name of the MCP server to test."),
    ],
):
    """Test connection to an MCP server and list available tools."""
    _, server = _get_mcp_server(name)

    async def _test() -> None:
        import fastmcp
        from mcp.shared.exceptions import McpError

        typer.echo(f"Testing connection to '{name}'...")

        mcp_config = {"mcpServers": {name: server}}
        client = fastmcp.Client(mcp_config)

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
        except McpError as e:
            typer.echo(f"✗ MCP error: {e}", err=True)
            raise typer.Exit(code=1)
        except TimeoutError:
            typer.echo("✗ Connection timed out.", err=True)
            raise typer.Exit(code=1)
        except ConnectionError as e:
            typer.echo(f"✗ Connection error: {e}", err=True)
            raise typer.Exit(code=1)
        except Exception as e:
            typer.echo(f"✗ Connection failed: {type(e).__name__}: {e}", err=True)
            raise typer.Exit(code=1)

    asyncio.run(_test())


if __name__ == "__main__":
    if "kimi_cli.cli" not in sys.modules:
        sys.modules["kimi_cli.cli"] = sys.modules[__name__]

    sys.exit(cli())
