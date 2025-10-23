import asyncio
import json
import signal
import sys
from functools import partial
from typing import Literal

import aiofiles
from kosong.base.message import Message
from kosong.chat_provider import ChatProviderError

from kimi_cli.soul import LLMNotSet, MaxStepsReached
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.wire import StepInterrupted, Wire
from kimi_cli.ui import RunCancelled, run_soul
from kimi_cli.utils.logging import logger
from kimi_cli.utils.message import message_extract_text

InputFormat = Literal["text", "stream-json"]
OutputFormat = Literal["text", "stream-json"]


class PrintApp:
    """
    An app implementation that prints the agent behavior to the console.

    Args:
        soul (KimiSoul): The soul to run. Only `KimiSoul` is supported.
        input_format (InputFormat): The input format to use.
        output_format (OutputFormat): The output format to use.
    """

    def __init__(self, soul: KimiSoul, input_format: InputFormat, output_format: OutputFormat):
        self.soul = soul
        self.input_format = input_format
        self.output_format = output_format
        self.soul._approval.set_yolo(True)
        # TODO(approval): proper approval request handling

    async def run(self, command: str | None = None) -> bool:
        cancel_event = asyncio.Event()

        def _handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGINT, _handler)

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
            loop.remove_signal_handler(signal.SIGINT)
        return False

    # TODO: unify with `_soul_run` in `ShellApp` and `ACPAgentImpl`
    async def _soul_run(self, user_input: str):
        wire = Wire()
        logger.debug("Starting visualization loop")

        if self.output_format == "text":
            vis_task = asyncio.create_task(self._visualize_text(wire))
        else:
            assert self.output_format == "stream-json"
            if not self.soul._context._file_backend.exists():
                self.soul._context._file_backend.touch()
            start_position = self.soul._context._file_backend.stat().st_size
            vis_task = asyncio.create_task(self._visualize_stream_json(wire, start_position))

        try:
            await self.soul.run(user_input, wire)
        finally:
            wire.shutdown()
            # shutting down the event queue should break the visualization loop
            try:
                await asyncio.wait_for(vis_task, timeout=0.5)
            except TimeoutError:
                logger.warning("Visualization loop timed out")

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

    async def _visualize_text(self, wire: Wire):
        try:
            while True:
                msg = await wire.receive()
                print(msg)
                if isinstance(msg, StepInterrupted):
                    break
        except asyncio.QueueShutDown:
            logger.debug("Visualization loop shutting down")

    async def _visualize_stream_json(self, wire: Wire, start_position: int):
        # TODO: be aware of context compaction
        try:
            async with aiofiles.open(self.soul._context._file_backend, encoding="utf-8") as f:
                await f.seek(start_position)
                while True:
                    should_end = False
                    while wire._queue.qsize() > 0:
                        msg = wire._queue.get_nowait()
                        if isinstance(msg, StepInterrupted):
                            should_end = True

                    line = await f.readline()
                    if not line:
                        if should_end:
                            break
                        await asyncio.sleep(0.1)
                        continue
                    print(line, end="")
        except asyncio.QueueShutDown:
            logger.debug("Visualization loop shutting down")
