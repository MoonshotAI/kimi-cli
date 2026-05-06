from __future__ import annotations

import asyncio
import json
import sys
import time
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

from kimi_cli.background.models import is_terminal_status
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
from kimi_cli.utils.logging import logger, open_original_stderr
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
                    #
                    # keep_alive_on_exit opts into "fire and forget"
                    # semantics: background tasks are meant to outlive
                    # the CLI process, so Print must not block waiting
                    # for them.
                    if (
                        runtime
                        and runtime.role == "root"
                        and self.input_format == "text"
                        and not runtime.config.background.keep_alive_on_exit
                    ):
                        manager = runtime.background_tasks
                        notifications = runtime.notifications
                        bg_config = runtime.config.background

                        # Snapshot the active tasks at the moment we start
                        # waiting.  Used both to derive the wait cap and to
                        # name the specific tasks in the timeout follow-up
                        # prompt.  The cap is the longest remaining task
                        # budget, clipped to the global ceiling — buggy
                        # tasks that never self-terminate can't hang the
                        # CLI forever.
                        initial_views = [
                            v
                            for v in manager.list_tasks(status=None, limit=None)
                            if not is_terminal_status(v.runtime.status)
                        ]
                        if initial_views:
                            agent_default = bg_config.agent_task_timeout_s
                            # Use an explicit None check — the falsy idiom
                            # ``v.spec.timeout_s or agent_default`` would
                            # silently promote a legitimate ``timeout_s=0``
                            # to the agent default (900s), contradicting
                            # the caller's explicit intent.
                            task_timeouts = [
                                v.spec.timeout_s if v.spec.timeout_s is not None else agent_default
                                for v in initial_views
                            ]
                            wait_cap = min(max(task_timeouts), bg_config.print_wait_ceiling_s)
                        else:
                            # No active tasks at snapshot time — fall back to
                            # the ceiling so a pending re-entry that spawns
                            # new long-running work still has a deadline.
                            # Otherwise ``--print`` can hang forever on
                            # mid-wait task creation.
                            wait_cap = bg_config.print_wait_ceiling_s
                        deadline = time.monotonic() + wait_cap
                        timed_out = False

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
                                # Pending notifications are checked BEFORE
                                # the deadline: a late-completing task
                                # should not lose its result just because
                                # the cap has been breached.
                                bg_prompt = (
                                    "<system-reminder>"
                                    "Background tasks have completed."
                                    " Process their results."
                                    "</system-reminder>"
                                )
                                # Bypass ``UserPromptSubmit`` — this is an
                                # internal synthetic prompt, not user input.
                                # A user-configured prompt-blocking hook
                                # would drop the notification and hang the
                                # wait loop.
                                #
                                # Transient LLM failures here must not flip
                                # the original command's exit code: the
                                # user's real command (first ``run_soul``
                                # call) already succeeded — a provider
                                # outage while acknowledging a background
                                # notification is not a command failure.
                                # Let ``RunCancelled`` bubble (Ctrl+C
                                # semantics); for anything else, drain the
                                # pending notifications for this sink so
                                # the loop doesn't tight-loop on the same
                                # failing notification, and ``continue`` so
                                # OTHER active tasks can still be waited on
                                # (breaking would abandon them and let
                                # shutdown force-kill them).
                                try:
                                    await run_soul(
                                        self.soul,
                                        bg_prompt,
                                        partial(visualize, self.output_format, self.final_only),
                                        cancel_event,
                                        runtime.session.wire_file,
                                        runtime,
                                        skip_user_prompt_hook=True,
                                    )
                                except RunCancelled:
                                    raise
                                except Exception:
                                    logger.warning(
                                        "Pending notification re-entry failed;"
                                        " draining pending notifications and"
                                        " continuing to wait for remaining tasks",
                                        exc_info=True,
                                    )
                                    # Force-drain pending LLM notifications
                                    # so the loop does not tight-loop on the
                                    # same failing notification.  They are
                                    # effectively lost (the LLM never
                                    # acknowledged them), but siblings can
                                    # still be waited for and the original
                                    # success exit code is preserved.
                                    while True:
                                        claimed = notifications.claim_for_sink("llm", limit=8)
                                        if not claimed:
                                            break
                                        for view in claimed:
                                            notifications.ack("llm", view.event.id)
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
                            # Timeout check runs only when tasks are still
                            # active: a loop iteration that would otherwise
                            # break out cleanly must not be redirected into
                            # the kill path just because the clock has
                            # moved past the deadline (e.g. after a long
                            # part-complete re-entry).  Using
                            # ``has_active_tasks()`` rather than the
                            # ``initial_views`` snapshot ensures tasks
                            # spawned by a pending re-entry are also bound
                            # by the deadline.
                            if time.monotonic() >= deadline:
                                # Race: the last task may have transitioned
                                # to terminal state on disk in the tiny
                                # window between the ``has_active_tasks()``
                                # check above and this deadline test.  Do
                                # one final reconcile + pending/active
                                # re-check so a natural near-deadline
                                # completion exits via the success path
                                # instead of the (spurious) kill-and-
                                # FAILURE path.
                                manager.reconcile()
                                if notifications.has_pending_for_sink("llm"):
                                    continue
                                if not manager.has_active_tasks():
                                    break
                                timed_out = True
                                break
                            # Still waiting for tasks to finish.
                            await asyncio.sleep(1.0)

                        if cancel_event.is_set():
                            raise RunCancelled

                        if timed_out:
                            # Re-read the active list at timeout time so
                            # tasks spawned mid-wait (e.g. by a part-
                            # complete re-entry into the soul) are named
                            # in the follow-up prompt too.
                            timed_out_views = [
                                v
                                for v in manager.list_tasks(status=None, limit=None)
                                if not is_terminal_status(v.runtime.status)
                            ]
                            killed = manager.kill_all_active(reason="print_wait_timeout")
                            # ``sys.stderr`` has been redirected to the
                            # logger pipe at this point in the CLI
                            # lifecycle, so writing directly to it would
                            # silently land in ``kimi.log``.  Use the
                            # pre-redirect fd to surface the notice on the
                            # user's terminal.
                            timeout_notice = (
                                f"timed out waiting for background tasks "
                                f"({wait_cap}s), killed {len(killed)} tasks\n"
                            )
                            with open_original_stderr() as stream:
                                if stream is not None:
                                    stream.write(timeout_notice.encode("utf-8", errors="replace"))
                                    stream.flush()
                                else:
                                    sys.stderr.write(timeout_notice)
                            # Label each task by its real post-kill state
                            # instead of a blanket ``(killed)``.  Reasons
                            # the naive label is wrong:
                            #   1. ``kill_all_active`` appends the id even
                            #      when ``kill()`` early-returns because
                            #      the task was already terminal (natural
                            #      completion race between the snapshot
                            #      and the kill loop).
                            #   2. ``kill()`` can also raise after sending
                            #      SIGTERM (e.g. merged_view IO failure),
                            #      so absence from ``killed`` ≠ "no kill
                            #      was attempted".
                            # Re-read the current state after kill_all_active
                            # and classify each task separately:
                            #   - already-terminal → ``already finished``
                            #   - kill_requested_at set → ``kill requested``
                            #   - neither              → ``kill failed``
                            post_kill_views = {
                                v.spec.id: v for v in manager.list_tasks(status=None, limit=None)
                            }
                            label_lines: list[str] = []
                            for v in timed_out_views:
                                latest = post_kill_views.get(v.spec.id, v)
                                if is_terminal_status(latest.runtime.status):
                                    label = "already finished"
                                elif latest.control.kill_requested_at is not None:
                                    label = "kill requested"
                                else:
                                    label = "kill failed"
                                label_lines.append(
                                    f"  - {v.spec.id}: {v.spec.description} ({label})"
                                )
                            task_lines = "\n".join(label_lines)
                            timeout_prompt = (
                                "<system-reminder>\n"
                                f"Background tasks exceeded the {wait_cap}s wait"
                                " limit; stop was requested where possible:\n"
                                f"{task_lines}\n"
                                "Summarize progress and inform the user,"
                                " then conclude.\n"
                                "</system-reminder>"
                            )
                            # The follow-up turn can fail (provider outage,
                            # MaxStepsReached).  Swallow those so the exit
                            # code stays FAILURE (the user already saw
                            # "timed out ... killed N tasks" on stderr —
                            # reclassifying to e.g. RETRYABLE would
                            # contradict that), and ensure reconcile()
                            # still runs in the ``finally`` block to flush
                            # terminal notifications.  RunCancelled is
                            # explicitly re-raised so Ctrl+C keeps its
                            # cancel semantics (outer ``except RunCancelled``
                            # → "Interrupted by user") instead of being
                            # silently reclassified as a timeout.
                            try:
                                await run_soul(
                                    self.soul,
                                    timeout_prompt,
                                    partial(visualize, self.output_format, self.final_only),
                                    cancel_event,
                                    runtime.session.wire_file,
                                    runtime,
                                    skip_user_prompt_hook=True,
                                )
                            except RunCancelled:
                                raise
                            except Exception:
                                logger.warning(
                                    "Timeout follow-up soul turn failed; continuing shutdown",
                                    exc_info=True,
                                )
                            finally:
                                # The follow-up soul turn already took a
                                # few seconds — enough natural window for
                                # worker supervisors to notice the SIGTERM
                                # and write their terminal status to disk.
                                # One last reconcile picks up that on-disk
                                # state so the persisted task view is
                                # consistent with what the user was just
                                # told ("killed"), instead of being stuck
                                # on "running" until the next CLI start.
                                #
                                # Guard against reconcile raising inside
                                # ``finally`` during a ``RunCancelled``
                                # propagation: an unhandled exception here
                                # would replace the active ``RunCancelled``
                                # and bypass the outer ``except RunCancelled``
                                # branch, surfacing as an ``Unknown error``
                                # instead of ``Interrupted by user``.
                                try:
                                    manager.reconcile()
                                except Exception:
                                    logger.warning(
                                        "Post-timeout reconcile failed; continuing exit",
                                        exc_info=True,
                                    )
                            return ExitCode.FAILURE
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
