# pyright: reportPrivateUsage=false
from __future__ import annotations

import asyncio
import contextlib
from dataclasses import replace
from typing import TYPE_CHECKING

from kimi_cli.approval_runtime import (
    ApprovalSource,
    reset_current_approval_source,
    set_current_approval_source,
)
from kimi_cli.soul import RunCancelled
from kimi_cli.subagents.builder import SubagentBuilder
from kimi_cli.subagents.core import SubagentRunSpec, prepare_soul
from kimi_cli.subagents.output import SubagentOutputWriter
from kimi_cli.subagents.runner import run_with_summary_continuation
from kimi_cli.utils.logging import logger
from kimi_cli.wire import Wire

if TYPE_CHECKING:
    from kimi_cli.approval_runtime.models import ApprovalRuntimeEvent
    from kimi_cli.background.manager import BackgroundTaskManager
    from kimi_cli.soul.agent import Runtime


class BackgroundAgentRunner:
    def __init__(
        self,
        *,
        runtime: Runtime,
        manager: BackgroundTaskManager,
        task_id: str,
        agent_id: str,
        subagent_type: str,
        prompt: str,
        model_override: str | None,
        timeout_s: int | None = None,
        resumed: bool = False,
    ) -> None:
        self._runtime = runtime
        self._manager = manager
        self._task_id = task_id
        self._agent_id = agent_id
        self._subagent_type = subagent_type
        self._prompt = prompt
        self._model_override = model_override
        self._timeout_s = timeout_s
        self._resumed = resumed
        self._builder = SubagentBuilder(runtime)
        self._approval_update_tasks: set[asyncio.Task[None]] = set()

    async def run(self) -> None:
        assert self._runtime.approval_runtime is not None
        assert self._runtime.subagent_store is not None
        token = set_current_approval_source(
            ApprovalSource(
                kind="background_agent",
                id=self._task_id,
                agent_id=self._agent_id,
                subagent_type=self._subagent_type,
            )
        )
        approval_subscription = self._runtime.approval_runtime.subscribe(
            self._on_approval_runtime_event
        )
        task_output_path = self._manager.store.output_path(self._task_id)
        output = SubagentOutputWriter(
            self._runtime.subagent_store.output_path(self._agent_id),
            extra_paths=[task_output_path],
        )

        try:
            if self._timeout_s is not None:
                await asyncio.wait_for(self._run_core(output), timeout=self._timeout_s)
            else:
                await self._run_core(output)
        except TimeoutError as exc:
            if isinstance(exc.__cause__, asyncio.CancelledError):
                # Task-level timeout from wait_for (it raises TimeoutError from CancelledError)
                logger.warning(
                    "Background agent task {id} timed out after {t}s",
                    id=self._task_id,
                    t=self._timeout_s,
                )
                self._runtime.subagent_store.update_instance(self._agent_id, status="failed")
                self._manager._mark_task_timed_out(
                    self._task_id, f"Agent task timed out after {self._timeout_s}s"
                )
                output.error(f"Agent task timed out after {self._timeout_s}s")
            else:
                # Internal timeout (e.g. aiohttp request) — treat as generic failure
                logger.exception("Background agent runner failed")
                self._runtime.subagent_store.update_instance(self._agent_id, status="failed")
                self._manager._mark_task_failed(self._task_id, str(exc))
                output.error(str(exc))
        except asyncio.CancelledError:
            self._runtime.subagent_store.update_instance(self._agent_id, status="killed")
            self._manager._mark_task_killed(self._task_id, "Stopped by TaskStop")
            output.stage("cancelled")
            raise
        except RunCancelled:
            # RunCancelled is Exception (not BaseException), so re-raising it from
            # an asyncio.create_task would trigger "Task exception was never retrieved".
            # Just mark killed and return — cleanup is already done.
            self._runtime.subagent_store.update_instance(self._agent_id, status="killed")
            self._manager._mark_task_killed(self._task_id, "Run was cancelled")
            output.stage("cancelled")
        except Exception as exc:
            logger.exception("Background agent runner failed")
            self._runtime.subagent_store.update_instance(self._agent_id, status="failed")
            self._manager._mark_task_failed(self._task_id, str(exc))
            output.error(str(exc))
        finally:
            for task in list(self._approval_update_tasks):
                task.cancel()
            for task in list(self._approval_update_tasks):
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            self._runtime.approval_runtime.unsubscribe(approval_subscription)
            self._runtime.approval_runtime.cancel_by_source("background_agent", self._task_id)
            reset_current_approval_source(token)
            self._manager._live_agent_tasks.pop(self._task_id, None)

    async def _run_core(self, output: SubagentOutputWriter) -> None:
        assert self._runtime.subagent_store is not None
        self._manager._mark_task_running(self._task_id)
        output.stage("runner_started")

        type_def = self._runtime.labor_market.require_builtin_type(self._subagent_type)
        record = self._runtime.subagent_store.require_instance(self._agent_id)
        launch_spec = record.launch_spec
        if self._model_override is not None:
            launch_spec = replace(
                launch_spec,
                model_override=self._model_override,
                effective_model=self._model_override,
            )

        spec = SubagentRunSpec(
            agent_id=self._agent_id,
            type_def=type_def,
            launch_spec=launch_spec,
            prompt=self._prompt,
            resumed=self._resumed,
        )
        soul, prompt = await prepare_soul(
            spec,
            self._runtime,
            self._builder,
            self._runtime.subagent_store,
            on_stage=output.stage,
        )

        async def _ui_loop_fn(wire: Wire) -> None:
            wire_ui = wire.ui_side(merge=True)
            while True:
                msg = await wire_ui.receive()
                output.write_wire_message(msg)

        output.stage("run_soul_start")
        final_response, failure = await run_with_summary_continuation(
            soul,
            prompt,
            _ui_loop_fn,
            self._runtime.subagent_store.wire_path(self._agent_id),
        )
        if failure is not None:
            self._manager._mark_task_failed(self._task_id, failure.message)
            self._runtime.subagent_store.update_instance(self._agent_id, status="failed")
            output.stage(f"failed: {failure.brief}")
            return
        output.stage("run_soul_finished")

        if final_response is None:
            self._manager._mark_task_failed(
                self._task_id, "Agent completed but produced no output."
            )
            self._runtime.subagent_store.update_instance(self._agent_id, status="failed")
            output.stage("failed: empty output")
            return
        output.summary(final_response)
        self._runtime.subagent_store.update_instance(self._agent_id, status="idle")
        self._manager._mark_task_completed(self._task_id)

    def _on_approval_runtime_event(self, event: ApprovalRuntimeEvent) -> None:
        request = event.request
        if request.source.kind != "background_agent" or request.source.id != self._task_id:
            return
        task = asyncio.create_task(self._apply_approval_runtime_event(event))
        self._approval_update_tasks.add(task)
        task.add_done_callback(self._approval_update_tasks.discard)
        task.add_done_callback(self._log_approval_update_failure)

    async def _apply_approval_runtime_event(self, event: ApprovalRuntimeEvent) -> None:
        request = event.request
        if event.kind == "request_created":
            await asyncio.to_thread(
                self._manager._mark_task_awaiting_approval,
                self._task_id,
                request.description,
            )
        elif event.kind == "request_resolved":
            assert self._runtime.approval_runtime is not None
            pending_for_task = [
                pending
                for pending in self._runtime.approval_runtime.list_pending()
                if pending.source.kind == "background_agent" and pending.source.id == self._task_id
            ]
            if pending_for_task:
                return
            await asyncio.to_thread(
                self._manager._mark_task_running,
                self._task_id,
            )

    @staticmethod
    def _log_approval_update_failure(task: asyncio.Task[None]) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            exc = task.exception()
            if exc is not None:
                logger.opt(exception=exc).error("Failed to apply background approval state update")
