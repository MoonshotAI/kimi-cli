from __future__ import annotations

import asyncio
import json
import sys
from functools import partial
from pathlib import Path

from kosong.chat_provider import ChatProviderError
from kosong.message import Message
from rich import print

from kimi_cli.cli import InputFormat, OutputFormat
from kimi_cli.soul import LLMNotSet, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.print.visualize import visualize
from kimi_cli.utils.logging import logger
from kimi_cli.utils.message import message_extract_text
from kimi_cli.utils.signals import install_sigint_handler


class PrintApp:
    """
    An app implementation that prints the agent behavior to the console.

    Args:
        soul (Soul): The soul to run.
        input_format (InputFormat): The input format to use.
        output_format (OutputFormat): The output format to use.
        context_file (Path): The file to store the context.
    """

    def __init__(
        self,
        soul: Soul,
        input_format: InputFormat,
        output_format: OutputFormat,
        context_file: Path,
    ):
        self.soul = soul
        self.input_format: InputFormat = input_format
        self.output_format: OutputFormat = output_format
        self.context_file = context_file

    async def run(self, command: str | None = None) -> bool:
        cancel_event = asyncio.Event()

        def _handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, _handler)

        if command is None and not sys.stdin.isatty() and self.input_format == "text":
            command = sys.stdin.read().strip()
            logger.info("Read command from stdin: {command}", command=command)

        try:
            while True:
                if command is None:
                    if self.input_format == "text":
                        return True
                    else:
                        assert self.input_format == "stream-json"
                        command = self._read_next_command()
                        if command is None:
                            return True

                if command:
                    logger.info("Running agent with command: {command}", command=command)
                    if self.output_format == "text":
                        print(command)
                    await run_soul(
                        self.soul,
                        command,
                        partial(visualize, self.output_format),
                        cancel_event,
                        self.soul.wire_file_backend if isinstance(self.soul, KimiSoul) else None,
                    )
                else:
                    logger.info("Empty command, skipping")

                command = None
        except LLMNotSet:
            logger.error("LLM not set")
            print("LLM not set")
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            print(f"LLM provider error: {e}")
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            print(f"Max steps reached: {e.n_steps}")
        except RunCancelled:
            logger.error("Interrupted by user")
            print("Interrupted by user")
        except BaseException as e:
            logger.exception("Unknown error:")
            print(f"Unknown error: {e}")
            raise
        finally:
            remove_sigint()
        return False

    def _read_next_command(self) -> str | None:
        while True:
            json_line = sys.stdin.readline()
            if not json_line:
                # EOF
                return None

            json_line = json_line.strip()
            if not json_line:
                # for empty line, read next line
                continue

            try:
                data = json.loads(json_line)
                message = Message.model_validate(data)
                if message.role == "user":
                    return message_extract_text(message)
                logger.warning(
                    "Ignoring message with role `{role}`: {json_line}",
                    role=message.role,
                    json_line=json_line,
                )
            except Exception:
                logger.warning("Ignoring invalid user message: {json_line}", json_line=json_line)
