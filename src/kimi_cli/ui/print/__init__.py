from __future__ import annotations

import asyncio
import json
import sys
from functools import partial
from pathlib import Path

from kosong.chat_provider import (
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
)
from kosong.message import Message
from rich import print

from kimi_cli.cli import ExitCode, InputFormat, OutputFormat
from kimi_cli.soul import (
    LLMNotSet,
    LLMNotSupported,
    MaxStepsReached,
    RunCancelled,
    Soul,
    run_soul,
)
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.print.visualize import visualize
from kimi_cli.utils.logging import logger
from kimi_cli.utils.signals import install_sigint_handler


class Print:
    """
    An app implementation that prints the agent behavior to the console.

    Args:
        soul (Soul): The soul to run.
        input_format (InputFormat): The input format to use.
        output_format (OutputFormat): The output format to use.
        context_file (Path): The file to store the context.
        final_only (bool): Whether to only print the final assistant message.
    """

    def __init__(
        self,
        soul: Soul,
        input_format: InputFormat,
        output_format: OutputFormat,
        context_file: Path,
        *,
        final_only: bool = False,
    ):
        self.soul = soul
        self.input_format: InputFormat = input_format
        self.output_format: OutputFormat = output_format
        self.context_file = context_file
        self.final_only = final_only

    async def run(self, command: str | None = None) -> int:
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
                        return ExitCode.SUCCESS
                    else:
                        assert self.input_format == "stream-json"
                        command = self._read_next_command()
                        if command is None:
                            return ExitCode.SUCCESS

                if command:
                    logger.info("Running agent with command: {command}", command=command)
                    if self.output_format == "text" and not self.final_only:
                        print(command)
                    runtime = self.soul.runtime if isinstance(self.soul, KimiSoul) else None
                    await run_soul(
                        self.soul,
                        command,
                        partial(visualize, self.output_format, self.final_only),
                        cancel_event,
                        runtime.session.wire_file if runtime else None,
                        runtime,
                    )

                    # In one-shot text mode the process exits after this
                    # function returns, which would kill still-running
                    # background agents.  Poll until they finish, calling
                    # reconcile() each iteration (the notification pump
                    # inside run_soul is no longer running, so we must
                    # drive reconcile ourselves to recover lost workers
                    # and publish terminal notifications).  Only re-enter
                    # the soul when there are pending LLM notifications.
                    #
                    # stream-json mode is multi-turn: background tasks
                    # from one command must not block the next command.
                    if runtime and runtime.role == "root" and self.input_format == "text":
                        manager = runtime.background_tasks
                        notifications = runtime.notifications
                        while not cancel_event.is_set():
                            # Drive reconcile() ourselves: the notification
                            # pump inside run_soul is no longer running, so
                            # we must recover lost workers and publish
                            # terminal notifications here.
                            manager.reconcile()
                            if notifications.has_pending_for_sink("llm"):
                                # Re-enter soul so the LLM can process the
                                # completion notification.  Do this even if
                                # other tasks are still active — progress on
                                # completed tasks should not wait on siblings.
                                bg_prompt = (
                                    "<system-reminder>"
                                    "Background tasks have completed."
                                    " Process their results."
                                    "</system-reminder>"
                                )
                                await run_soul(
                                    self.soul,
                                    bg_prompt,
                                    partial(visualize, self.output_format, self.final_only),
                                    cancel_event,
                                    runtime.session.wire_file,
                                    runtime,
                                )
                                continue
                            if not manager.has_active_tasks():
                                # Re-check once after noticing no active
                                # tasks: a worker may have finished between
                                # the reconcile above and this snapshot,
                                # leaving a terminal state on disk that we
                                # haven't published yet.  Without this
                                # second reconcile+pending check, that
                                # final completion notification would be
                                # lost when the process exits.
                                manager.reconcile()
                                if notifications.has_pending_for_sink("llm"):
                                    continue
                                break
                            # Still waiting for tasks to finish.
                            await asyncio.sleep(1.0)
                        if cancel_event.is_set():
                            raise RunCancelled
                else:
                    logger.info("Empty command, skipping")

                command = None
        except LLMNotSet as e:
            logger.exception("LLM not set:")
            print(str(e))
            return ExitCode.FAILURE
        except LLMNotSupported as e:
            logger.exception("LLM not supported:")
            print(str(e))
            return ExitCode.FAILURE
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            print(str(e))
            return self._classify_provider_error(e)
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            print(str(e))
            return ExitCode.FAILURE
        except RunCancelled:
            logger.error("Interrupted by user")
            print("Interrupted by user")
            return ExitCode.FAILURE
        except BaseException as e:
            logger.exception("Unknown error:")
            print(f"Unknown error: {e}")
            raise
        finally:
            remove_sigint()
        return ExitCode.FAILURE

    _RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

    @staticmethod
    def _classify_provider_error(e: ChatProviderError) -> int:
        """Classify a ChatProviderError into an exit code."""
        if isinstance(e, (APIConnectionError, APITimeoutError, APIEmptyResponseError)):
            return ExitCode.RETRYABLE
        if isinstance(e, APIStatusError):
            if e.status_code in Print._RETRYABLE_STATUS_CODES:
                return ExitCode.RETRYABLE
            return ExitCode.FAILURE
        return ExitCode.FAILURE

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
                    return message.extract_text(sep="\n")
                logger.warning(
                    "Ignoring message with role `{role}`: {json_line}",
                    role=message.role,
                    json_line=json_line,
                )
            except Exception:
                logger.warning("Ignoring invalid user message: {json_line}", json_line=json_line)
