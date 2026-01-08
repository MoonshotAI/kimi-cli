"""
kimi-psql: AI-assisted PostgreSQL interactive terminal.

Usage:
    uv run main.py -h localhost -p 5432 -U postgres -d mydb
"""

import asyncio
import contextlib
import fcntl
import os
import pty
import select
import signal
import sys
import termios
import tty
from enum import Enum
from pathlib import Path
from typing import LiteralString, cast

import psycopg
import typer
from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from prompt_toolkit import PromptSession
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.patch_stdout import patch_stdout
from pydantic import BaseModel, Field, SecretStr
from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm import LLM, create_llm
from kimi_cli.session import Session
from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, run_soul
from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.visualize import visualize
from kimi_cli.wire.types import StatusUpdate


class ExecuteSqlParams(BaseModel):
    """Parameters for ExecuteSql tool."""

    sql: str = Field(description="The SQL query to execute in the connected PostgreSQL database")


class ExecuteSql(CallableTool2[ExecuteSqlParams]):
    """Execute read-only SQL query in the connected PostgreSQL database."""

    name: str = "ExecuteSql"
    description: str = (
        "Execute a READ-ONLY SQL query in the connected PostgreSQL database. "
        "Use this tool for SELECT queries and database introspection queries. "
        "This tool CANNOT execute write operations (INSERT, UPDATE, DELETE, DROP, etc.). "
        "For write operations, return the SQL in a markdown code block for the user to "
        "execute manually. "
        "Note: psql meta-commands (\\d, \\dt, etc.) are NOT supported - use SQL queries "
        "instead (e.g., SELECT * FROM pg_tables WHERE schemaname = 'public')."
    )
    params: type[ExecuteSqlParams] = ExecuteSqlParams

    def __init__(self, conninfo: str):
        """
        Initialize ExecuteSql tool with database connection info.

        Args:
            conninfo: PostgreSQL connection string
                (e.g., "host=localhost port=5432 dbname=mydb user=postgres")
        """
        super().__init__()
        self._conninfo = conninfo

    async def __call__(self, params: ExecuteSqlParams) -> ToolReturnValue:
        try:
            # Connect and execute in read-only transaction
            async with (
                await psycopg.AsyncConnection.connect(self._conninfo, autocommit=False) as conn,
                conn.cursor() as cur,
            ):
                # Set read-only mode
                await conn.set_read_only(True)
                # Cast to LiteralString for type checker - SQL is validated at runtime
                await cur.execute(cast(LiteralString, params.sql))

                # Check if query returns results
                if cur.description:
                    rows = await cur.fetchall()
                    if not rows:
                        return ToolOk(output="Query returned no rows.")

                    # Format as table
                    columns = [desc[0] for desc in cur.description]
                    col_widths = [len(col) for col in columns]

                    # Calculate column widths
                    for row in rows:
                        for i, val in enumerate(row):
                            col_widths[i] = max(col_widths[i], len(str(val)))

                    # Build table
                    lines = []
                    # Header
                    header = " | ".join(col.ljust(col_widths[i]) for i, col in enumerate(columns))
                    lines.append(header)
                    lines.append("-" * len(header))
                    # Rows
                    for row in rows:
                        line = " | ".join(
                            str(val).ljust(col_widths[i]) for i, val in enumerate(row)
                        )
                        lines.append(line)

                    lines.append(f"\n({len(rows)} row{'s' if len(rows) != 1 else ''})")
                    return ToolOk(output="\n".join(lines))
                else:
                    # Non-SELECT query (should not happen in read-only mode)
                    return ToolOk(output="Query executed successfully (no results).")

        except psycopg.errors.ReadOnlySqlTransaction as e:
            return ToolError(
                message=f"Cannot execute write operation in read-only mode: {e}",
                brief="Write operation not allowed",
            )
        except Exception as e:
            return ToolError(message=f"SQL execution error: {e}", brief="SQL error")


console = Console()

# ============================================================================
# PsqlProcess: PTY-based psql subprocess management
# ============================================================================


class PsqlProcess:
    """Manages a psql subprocess with PTY support for full interactive experience."""

    def __init__(self, psql_args: list[str]):
        self.psql_args = psql_args
        self._master_fd: int | None = None
        self._pid: int | None = None
        self._running = False
        self._original_termios: list | None = None

    def start(self) -> None:
        """Spawn psql in a pseudo-terminal."""
        # Save original terminal settings
        if sys.stdin.isatty():
            self._original_termios = termios.tcgetattr(sys.stdin)

        pid, master_fd = pty.fork()

        if pid == 0:
            # Child process: exec psql
            os.execvp("psql", self.psql_args)
        else:
            # Parent process
            self._pid = pid
            self._master_fd = master_fd
            self._running = True

            # Set master fd to non-blocking
            flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            # Sync terminal size
            self._sync_window_size()

            # Handle window resize
            signal.signal(signal.SIGWINCH, self._handle_sigwinch)

    def _sync_window_size(self) -> None:
        """Sync PTY window size with current terminal."""
        if self._master_fd is None:
            return
        if sys.stdin.isatty():
            winsize = fcntl.ioctl(sys.stdin, termios.TIOCGWINSZ, b"\x00" * 8)
            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)

    def _handle_sigwinch(self, signum: int, frame: object) -> None:
        """Handle terminal window resize."""
        self._sync_window_size()

    def read(self, timeout: float = 0.1) -> bytes:
        """Read output from psql (non-blocking with timeout)."""
        if self._master_fd is None:
            return b""
        ready, _, _ = select.select([self._master_fd], [], [], timeout)
        if ready:
            try:
                return os.read(self._master_fd, 4096)
            except OSError:
                return b""
        return b""

    def write(self, data: bytes) -> None:
        """Write input to psql."""
        if self._master_fd is None:
            return
        os.write(self._master_fd, data)

    def is_running(self) -> bool:
        """Check if psql process is still running."""
        if self._pid is None:
            return False
        try:
            pid, status = os.waitpid(self._pid, os.WNOHANG)
            if pid != 0:
                self._running = False
            return self._running
        except ChildProcessError:
            self._running = False
            return False

    def stop(self) -> None:
        """Terminate psql process and restore terminal."""
        if self._pid is not None:
            try:
                os.kill(self._pid, signal.SIGTERM)
                os.waitpid(self._pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass

        if self._master_fd is not None:
            with contextlib.suppress(OSError):
                os.close(self._master_fd)

        # Restore original terminal settings
        if self._original_termios and sys.stdin.isatty():
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, self._original_termios)

        self._running = False

    @property
    def master_fd(self) -> int | None:
        return self._master_fd


# ============================================================================
# PsqlMode: Operation mode enumeration
# ============================================================================


class PsqlMode(Enum):
    AI = "ai"  # AI assistance mode (default)
    PSQL = "psql"  # Direct psql interaction

    def toggle(self) -> "PsqlMode":
        return PsqlMode.PSQL if self == PsqlMode.AI else PsqlMode.AI


# ============================================================================
# PsqlSoul: SQL generation specialized Soul
# ============================================================================


async def create_psql_soul(llm: LLM, conninfo: str) -> KimiSoul:
    """Create a KimiSoul configured for PostgreSQL with ExecuteSql tool
    and standard kimi-cli tools."""
    from typing import cast

    from kimi_cli.config import load_config
    from kimi_cli.soul.agent import load_agent
    from kimi_cli.soul.toolset import KimiToolset

    config = load_config()
    kaos_work_dir = KaosPath.cwd()
    session = await Session.create(kaos_work_dir)
    runtime = await Runtime.create(
        config=config,
        llm=llm,
        session=session,
        yolo=True,  # Auto-approve read-only SQL queries
    )

    # Load agent from configuration
    agent_file = Path(__file__).parent / "agent.yaml"
    agent = await load_agent(agent_file, runtime, mcp_configs=[])

    # Add custom ExecuteSql tool to the loaded agent
    cast(KimiToolset, agent.toolset).add(ExecuteSql(conninfo))

    context = Context(session.context_file)
    return KimiSoul(agent, context=context)


# ============================================================================
# PsqlShell: Main TUI orchestrator
# ============================================================================


class PsqlShell:
    """Main TUI orchestrator for kimi-psql."""

    PROMPT_SYMBOL_AI = "✨"
    PROMPT_SYMBOL_PSQL = "$"

    def __init__(self, soul: KimiSoul, psql_process: PsqlProcess):
        self.soul = soul
        self._psql_process = psql_process
        self._mode = PsqlMode.AI
        self._switch_requested = False
        self._prompt_session: PromptSession[str] | None = None
        self._psql_entered_before = False  # Track if we've entered PSQL mode before

    def _create_prompt_session(self) -> PromptSession[str]:
        """Create a prompt_toolkit session with Ctrl-X binding."""
        kb = KeyBindings()

        @kb.add("c-x", eager=True)
        def _(event) -> None:
            """Switch to PSQL mode on Ctrl-X."""
            self._switch_requested = True
            event.app.exit(result="")

        def get_prompt() -> FormattedText:
            symbol = self.PROMPT_SYMBOL_AI if self._mode == PsqlMode.AI else self.PROMPT_SYMBOL_PSQL
            return FormattedText([("bold fg:blue", f"kimi-psql{symbol} ")])

        def get_bottom_toolbar() -> FormattedText:
            mode_str = self._mode.value.upper()
            return FormattedText(
                [
                    ("bg:#333333 fg:#ffffff", f" [{mode_str}] "),
                    ("bg:#333333 fg:#888888", " | ctrl-x: switch mode | ctrl-d: exit "),
                ]
            )

        return PromptSession(
            message=get_prompt,
            key_bindings=kb,
            bottom_toolbar=get_bottom_toolbar,
        )

    async def run(self) -> None:
        """Main event loop."""
        # Create prompt session
        self._prompt_session = self._create_prompt_session()

        # Print welcome message
        self._print_welcome()

        try:
            while self._psql_process.is_running():
                if self._mode == PsqlMode.AI:
                    await self._run_ai_mode()
                else:
                    await self._run_psql_mode()
        except KeyboardInterrupt:
            console.print("\n[grey50]Bye![/grey50]")
        finally:
            self._psql_process.stop()

    def _print_welcome(self) -> None:
        """Print welcome message."""
        console.print(
            Panel(
                Text.from_markup(
                    "[bold]Welcome to kimi-psql![/bold]\n"
                    "[grey50]AI-assisted PostgreSQL interactive terminal[/grey50]\n\n"
                    "[cyan]Ctrl-X[/cyan]: Switch between AI and PSQL mode\n"
                    "[cyan]Ctrl-D[/cyan]: Exit"
                ),
                border_style="blue",
                expand=False,
            )
        )
        console.print(f"[grey50]Current mode: [bold]{self._mode.value.upper()}[/bold][/grey50]\n")

    async def _run_ai_mode(self) -> None:
        """Handle AI assistance mode using prompt_toolkit with run_soul + visualize."""
        if not self._prompt_session:
            return

        self._switch_requested = False

        try:
            with patch_stdout(raw=True):
                user_input = await self._prompt_session.prompt_async()
        except EOFError:
            raise KeyboardInterrupt from None
        except KeyboardInterrupt:
            console.print()
            return

        # Check if mode switch was requested
        if self._switch_requested:
            self._switch_mode()
            return

        user_input = user_input.strip()
        if not user_input:
            return

        # Check for exit commands
        if user_input.lower() in ["exit", "quit", "\\q"]:
            raise KeyboardInterrupt

        # Run soul with visualize (same as kimi-cli shell)
        cancel_event = asyncio.Event()

        try:
            await run_soul(
                self.soul,
                user_input,
                lambda wire: visualize(
                    wire.ui_side(merge=False),
                    initial_status=StatusUpdate(context_usage=self.soul.status.context_usage),
                    cancel_event=cancel_event,
                ),
                cancel_event,
            )
        except LLMNotSet:
            console.print("[red]LLM not set, run `kimi /setup` to configure[/red]")
        except LLMNotSupported as e:
            console.print(f"[red]{e}[/red]")
        except MaxStepsReached as e:
            console.print(f"[yellow]{e}[/yellow]")
        except RunCancelled:
            console.print("[red]Interrupted by user[/red]")
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")

    async def _run_psql_mode(self) -> None:
        """Handle direct psql interaction with full PTY pass-through."""
        if not self._psql_process or self._psql_process.master_fd is None:
            return

        console.print(
            "[grey50]Entering PSQL mode. Press Ctrl-X to switch back to AI mode.[/grey50]"
        )

        # Flush any pending output from psql before entering raw mode
        while True:
            chunk = self._psql_process.read(timeout=0.05)
            if chunk:
                sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                sys.stdout.flush()
            else:
                break

        # Save terminal settings and set raw mode
        old_settings = None
        if sys.stdin.isatty():
            old_settings = termios.tcgetattr(sys.stdin)
            tty.setraw(sys.stdin)

        master_fd = self._psql_process.master_fd

        # Only send newline to refresh prompt if we've entered PSQL mode before
        # First time, psql already shows its prompt after startup
        if self._psql_entered_before:
            self._psql_process.write(b"\n")
        self._psql_entered_before = True

        try:
            while self._psql_process.is_running():
                # Wait for input from either stdin or psql
                readable, _, _ = select.select([sys.stdin, master_fd], [], [], 0.1)

                for fd in readable:
                    if fd == sys.stdin:
                        # Read from user
                        data = os.read(sys.stdin.fileno(), 1024)
                        if not data:
                            return

                        # Check for Ctrl-X (0x18)
                        if b"\x18" in data:
                            # Restore terminal and switch mode
                            if old_settings:
                                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)
                            self._switch_mode()
                            return

                        # Forward to psql
                        self._psql_process.write(data)

                    elif fd == master_fd:
                        # Read from psql and display
                        try:
                            data = os.read(master_fd, 4096)
                            if data:
                                os.write(sys.stdout.fileno(), data)
                        except OSError:
                            break

        finally:
            # Restore terminal settings
            if old_settings and sys.stdin.isatty():
                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)

    def _switch_mode(self) -> None:
        """Switch between AI and PSQL mode."""
        self._mode = self._mode.toggle()
        console.print(f"\n[yellow]Switched to {self._mode.value.upper()} mode[/yellow]\n")


# ============================================================================
# CLI Entry Point
# ============================================================================

app = typer.Typer(
    name="kimi-psql",
    help="AI-assisted PostgreSQL interactive terminal",
    add_completion=False,
)


@app.command()
def main(
    dbname: str = typer.Argument(None, help="Database name (same as psql)"),
    username_arg: str = typer.Argument(None, help="Database user (same as psql)"),
    host: str = typer.Option(None, "-h", "--host", help="Database server host"),
    port: int = typer.Option(None, "-p", "--port", help="Database server port"),
    username: str = typer.Option(None, "-U", "--username", help="Database user"),
    dbname_opt: str = typer.Option(None, "-d", "--dbname", help="Database name"),
    conninfo: str = typer.Option(
        None, "--conninfo", help="PostgreSQL connection URL (e.g., postgresql://user:pass@host/db)"
    ),
) -> None:
    """
    Start kimi-psql: AI-assisted PostgreSQL interactive terminal.

    Usage is compatible with psql:
      kimi-psql mydb
      kimi-psql mydb postgres
      kimi-psql -h localhost -U postgres -d mydb
      kimi-psql --conninfo postgresql://user:pass@host/db
    """
    # Resolve dbname and username (positional takes precedence over options)
    final_dbname = dbname or dbname_opt
    final_username = username_arg or username

    asyncio.run(_run_async(host, port, final_username, final_dbname, conninfo=conninfo))


async def _run_async(
    host: str | None,
    port: int | None,
    username: str | None,
    dbname: str | None,
    conninfo: str | None = None,
    config_file: Path | None = None,
) -> None:
    """Async entry point."""
    from kimi_cli.config import load_config
    from kimi_cli.llm import augment_provider_with_env_vars

    # If conninfo URL is provided, use it directly
    if conninfo:
        # For psql, just pass the connection URL
        psql_args = ["psql", conninfo]
        # For psycopg, use the URL as-is
        conninfo_str = conninfo
    else:
        # Build psql command args
        psql_args = ["psql"]
        if host:
            psql_args.extend(["-h", host])
        if port:
            psql_args.extend(["-p", str(port)])
        if username:
            psql_args.extend(["-U", username])
        if dbname:
            psql_args.extend(["-d", dbname])

        # Build connection info for psycopg
        conninfo_parts = []
        if host:
            conninfo_parts.append(f"host={host}")
        if port:
            conninfo_parts.append(f"port={port}")
        if username:
            conninfo_parts.append(f"user={username}")
        if dbname:
            conninfo_parts.append(f"dbname={dbname}")
        conninfo_str = " ".join(conninfo_parts)

    # Load config (same as kimi-cli)
    config = load_config(config_file)

    model: LLMModel | None = None
    provider: LLMProvider | None = None

    # Try to use config file
    if config.default_model:
        model = config.models.get(config.default_model)
        if model:
            provider = config.providers.get(model.provider)

    # Fallback to defaults
    if not model:
        model = LLMModel(provider="kimi", model="", max_context_size=250_000)
    if not provider:
        provider = LLMProvider(type="kimi", base_url="", api_key=SecretStr(""))

    # Override with environment variables
    env_overrides = augment_provider_with_env_vars(provider, model)

    if not provider.base_url or not model.model:
        console.print("[red]LLM not configured. Run `kimi /setup` to configure.[/red]")
        return

    if env_overrides:
        console.print(f"[grey50]Using env overrides: {', '.join(env_overrides.keys())}[/grey50]")

    # Create LLM
    llm = create_llm(provider, model)

    # Create Soul with ExecuteSql tool (uses psycopg for read-only queries)
    soul = await create_psql_soul(llm, conninfo_str)

    # Start psql process (only for user's PSQL mode)
    psql_process = PsqlProcess(psql_args)
    psql_process.start()

    # Create and run shell
    shell = PsqlShell(soul, psql_process)
    await shell.run()


if __name__ == "__main__":
    app()
