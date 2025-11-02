import asyncio
import json
import sys
from functools import partial
from pathlib import Path

import aiofiles
from kosong.base.message import Message
from kosong.chat_provider import ChatProviderError
from rich import print

from kimi_cli.cli import InputFormat, OutputFormat
from kimi_cli.soul import LLMNotSet, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.utils.logging import logger
from kimi_cli.utils.message import message_extract_text
from kimi_cli.utils.signals import install_sigint_handler
from kimi_cli.wire import WireUISide
from kimi_cli.wire.message import StepInterrupted


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
        self.input_format = input_format
        self.output_format = output_format
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
                        visualize_fn = self._visualize_text
                        print(command)
                    else:
                        assert self.output_format == "stream-json"
                        visualize_fn = partial(self._visualize_stream_json, start_position=0)
                    await run_soul(self.soul, command, visualize_fn, cancel_event)
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

    async def _visualize_text(self, wire: WireUISide):
        while True:
            msg = await wire.receive()
            print(msg)
            if isinstance(msg, StepInterrupted):
                break

    async def _visualize_stream_json(self, wire: WireUISide, start_position: int):
        # TODO: be aware of context compaction
        # FIXME: this is only a temporary impl, may miss the last lines of the context file
        if not self.context_file.exists():
            self.context_file.touch()
        async with aiofiles.open(self.context_file, encoding="utf-8") as f:
            await f.seek(start_position)
            while True:
                should_end = False
                while (msg := wire.receive_nowait()) is not None:
                    if isinstance(msg, StepInterrupted):
                        should_end = True

                line = await f.readline()
                if not line:
                    if should_end:
                        break
                    await asyncio.sleep(0.1)
                    continue
                print(line, end="")
