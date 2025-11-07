"""Built-in shell commands that need to affect the parent process state."""

import os
import shlex
from pathlib import Path

from kimi_cli.ui.shell.console import console
from kimi_cli.utils.logging import logger


class BuiltinCommandResult:
    """Result of executing a built-in command."""

    def __init__(self, handled: bool, success: bool = True):
        """
        Args:
            handled: Whether the command was handled by a built-in handler.
            success: Whether the command executed successfully (only relevant if handled=True).
        """
        self.handled = handled
        self.success = success


async def handle_builtin_command(command: str) -> BuiltinCommandResult:
    """
    Handle built-in shell commands that need to affect the parent process.

    Built-in commands include:
    - cd: Change directory
    - pwd: Print working directory

    Args:
        command: The shell command to potentially handle.

    Returns:
        BuiltinCommandResult indicating whether the command was handled and if it succeeded.
    """
    command = command.strip()
    if not command:
        return BuiltinCommandResult(handled=False)

    # Parse the command
    try:
        parts = shlex.split(command)
    except ValueError as e:
        # If we can't parse it, let the shell handle it
        logger.debug(f"Failed to parse command for builtin handling: {e}")
        return BuiltinCommandResult(handled=False)

    if not parts:
        return BuiltinCommandResult(handled=False)

    cmd_name = parts[0]
    args = parts[1:]

    # Handle cd command
    if cmd_name == "cd":
        return await _handle_cd(args)

    # Handle pwd command
    if cmd_name == "pwd":
        return await _handle_pwd(args)

    # Not a built-in command
    return BuiltinCommandResult(handled=False)


async def _handle_cd(args: list[str]) -> BuiltinCommandResult:
    """
    Handle the cd (change directory) command.

    Args:
        args: Arguments to the cd command.

    Returns:
        BuiltinCommandResult indicating success or failure.
    """
    # cd with no arguments goes to home directory
    if not args:
        target = Path.home()
    elif len(args) == 1:
        arg = args[0]
        # Handle special cases
        if arg == "-":
            # cd - (go to previous directory) - not implemented yet
            console.print("[yellow]cd -: Previous directory tracking not implemented yet[/yellow]")
            return BuiltinCommandResult(handled=True, success=False)
        elif arg == "~":
            target = Path.home()
        elif arg.startswith("~/"):
            target = Path.home() / arg[2:]
        else:
            target = Path(arg)
    else:
        console.print("[red]cd: too many arguments[/red]")
        return BuiltinCommandResult(handled=True, success=False)

    # Resolve the target path
    try:
        # If it's a relative path, resolve it relative to current directory
        if not target.is_absolute():
            target = Path.cwd() / target

        # Resolve to absolute path (handles .., ., symlinks, etc.)
        target = target.resolve()

        # Check if the directory exists
        if not target.exists():
            console.print(f"[red]cd: {target}: No such file or directory[/red]")
            return BuiltinCommandResult(handled=True, success=False)

        if not target.is_dir():
            console.print(f"[red]cd: {target}: Not a directory[/red]")
            return BuiltinCommandResult(handled=True, success=False)

        # Change the directory
        os.chdir(target)
        logger.info(f"Changed directory to: {target}")

        return BuiltinCommandResult(handled=True, success=True)

    except PermissionError:
        console.print(f"[red]cd: {target}: Permission denied[/red]")
        return BuiltinCommandResult(handled=True, success=False)
    except Exception as e:
        console.print(f"[red]cd: {e}[/red]")
        logger.exception("Failed to change directory:")
        return BuiltinCommandResult(handled=True, success=False)


async def _handle_pwd(args: list[str]) -> BuiltinCommandResult:
    """
    Handle the pwd (print working directory) command.

    Args:
        args: Arguments to the pwd command (usually none).

    Returns:
        BuiltinCommandResult indicating success.
    """
    if args and args[0] in ["-L", "-P"]:
        # -L: logical path (default)
        # -P: physical path (resolve symlinks)
        # For simplicity, we'll just print the current directory
        pass

    try:
        cwd = Path.cwd()
        console.print(str(cwd))
        return BuiltinCommandResult(handled=True, success=True)
    except Exception as e:
        console.print(f"[red]pwd: {e}[/red]")
        logger.exception("Failed to get current directory:")
        return BuiltinCommandResult(handled=True, success=False)
