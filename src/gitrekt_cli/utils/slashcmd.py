import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import overload


@dataclass(frozen=True, slots=True, kw_only=True)
class SlashCommand[F: Callable[..., None | Awaitable[None]]]:
    name: str
    description: str
    func: F
    aliases: list[str]

    def slash_name(self):
        """/name (aliases)"""
        if self.aliases:
            return f"/{self.name} ({', '.join(self.aliases)})"
        return f"/{self.name}"


class SlashCommandRegistry[F: Callable[..., None | Awaitable[None]]]:
    """Registry for slash commands."""

    def __init__(self) -> None:
        self._commands: dict[str, SlashCommand[F]] = {}
        """Primary name -> SlashCommand"""
        self._command_aliases: dict[str, SlashCommand[F]] = {}
        """Primary name or alias -> SlashCommand"""

    @overload
    def command(self, func: F, /) -> F: ...

    @overload
    def command(
        self,
        *,
        name: str | None = None,
        aliases: Sequence[str] | None = None,
    ) -> Callable[[F], F]: ...

    def command(
        self,
        func: F | None = None,
        *,
        name: str | None = None,
        aliases: Sequence[str] | None = None,
    ) -> F | Callable[[F], F]:
        """
        Decorator to register a slash command with optional custom name and aliases.

        Usage examples:
          @registry.command
          def help(app: App, args: str): ...

          @registry.command(name="run")
          def start(app: App, args: str): ...

          @registry.command(aliases=["h", "?", "assist"])
          def help(app: App, args: str): ...
        """

        def _register(f: F) -> F:
            primary = name or f.__name__
            alias_list = list(aliases) if aliases else []

            # Create the primary command with aliases
            cmd = SlashCommand[F](
                name=primary,
                description=(f.__doc__ or "").strip(),
                func=f,
                aliases=alias_list,
            )

            # Register primary command
            self._commands[primary] = cmd
            self._command_aliases[primary] = cmd

            # Register aliases pointing to the same command
            for alias in alias_list:
                self._command_aliases[alias] = cmd

            return f

        if func is not None:
            return _register(func)
        return _register

    def find_command(self, name: str) -> SlashCommand[F] | None:
        return self._command_aliases.get(name)

    def list_commands(self) -> list[SlashCommand[F]]:
        """Get all unique primary slash commands (without duplicating aliases)."""
        return list(self._commands.values())


@dataclass(frozen=True, slots=True, kw_only=True)
class SlashCommandCall:
    name: str
    args: str
    raw_input: str


def parse_slash_command_call(user_input: str) -> SlashCommandCall | None:
    """
    Parse a slash command call from user input.

    Returns:
        SlashCommandCall if a slash command is found, else None. The `args` field contains
        the raw argument string after the command name.
    """
    user_input = user_input.strip()
    if not user_input or not user_input.startswith("/"):
        return None

    name_match = re.match(r"^\/([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)", user_input)

    if not name_match:
        return None

    command_name = name_match.group(1)
    if len(user_input) > name_match.end() and not user_input[name_match.end()].isspace():
        return None
    raw_args = user_input[name_match.end() :].lstrip()
    return SlashCommandCall(name=command_name, args=raw_args, raw_input=user_input)
