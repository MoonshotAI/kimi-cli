from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING

from kosong.tooling import ToolError, ToolOk, ToolReturnValue

from kimi_cli.approval_runtime import (
    ApprovalSource,
    reset_current_approval_source,
    set_current_approval_source,
)
from kimi_cli.soul import MaxStepsReached, UILoopFn, get_wire_or_none, run_soul
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.subagents.builder import SubagentBuilder
from kimi_cli.subagents.models import AgentInstanceRecord, AgentLaunchSpec
from kimi_cli.subagents.output import SubagentOutputWriter
from kimi_cli.subagents.store import SubagentStore
from kimi_cli.wire import Wire
from kimi_cli.wire.file import WireFile
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    HookRequest,
    QuestionRequest,
    SubagentEvent,
    ToolCallRequest,
)

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime

SUMMARY_MIN_LENGTH = 200
SUMMARY_CONTINUATION_ATTEMPTS = 1
SUMMARY_CONTINUATION_PROMPT = """
Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Detailed findings and analysis
3. All important information that the parent agent should know
""".strip()


# ---------------------------------------------------------------------------
# Shared result types and execution helpers (used by both foreground and
# background runners).
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class SoulRunFailure:
    """Describes why a soul run did not produce a usable result."""

    message: str
    brief: str


async def run_soul_checked(
    soul: KimiSoul,
    prompt: str,
    ui_loop_fn: UILoopFn,
    wire_path: Path,
    phase: str,
) -> SoulRunFailure | None:
    """Run a single soul turn and validate the result.

    Returns a ``SoulRunFailure`` if the run failed or produced an invalid
    result, or ``None`` on success.  ``MaxStepsReached`` is converted to a
    failure; ``CancelledError`` and other exceptions are re-raised.
    """
    try:
        await run_soul(
            soul,
            prompt,
            ui_loop_fn,
            asyncio.Event(),
            wire_file=WireFile(wire_path),
            runtime=soul.runtime,
        )
    except MaxStepsReached as exc:
        return SoulRunFailure(
            message=(
                f"Max steps {exc.n_steps} reached when {phase}. "
                "Please try splitting the task into smaller subtasks."
            ),
            brief="Max steps reached",
        )

    context = soul.context
    if not context.history or context.history[-1].role != "assistant":
        return SoulRunFailure(
            message="The agent did not produce a valid assistant response.",
            brief="Invalid agent result",
        )
    return None


async def run_with_summary_continuation(
    soul: KimiSoul,
    prompt: str,
    ui_loop_fn: UILoopFn,
    wire_path: Path,
) -> tuple[str | None, SoulRunFailure | None]:
    """Run soul, then optionally extend the summary if it is too short.

    Returns ``(final_response, failure)``.  On success ``failure`` is
    ``None`` and ``final_response`` contains the agent's output text.
    On failure ``final_response`` is ``None``.
    """
    failure = await run_soul_checked(soul, prompt, ui_loop_fn, wire_path, "running agent")
    if failure is not None:
        return None, failure

    final_response = soul.context.history[-1].extract_text(sep="\n")
    remaining = SUMMARY_CONTINUATION_ATTEMPTS
    while remaining > 0 and len(final_response) < SUMMARY_MIN_LENGTH:
        remaining -= 1
        failure = await run_soul_checked(
            soul,
            SUMMARY_CONTINUATION_PROMPT,
            ui_loop_fn,
            wire_path,
            "continuing the agent summary",
        )
        if failure is not None:
            return None, failure
        final_response = soul.context.history[-1].extract_text(sep="\n")

    return final_response, None


# ---------------------------------------------------------------------------
# Foreground runner
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class ForegroundRunRequest:
    description: str
    prompt: str
    requested_type: str
    model: str | None
    resume: str | None


@dataclass(frozen=True, slots=True, kw_only=True)
class PreparedInstance:
    record: AgentInstanceRecord
    actual_type: str
    resumed: bool


class ForegroundSubagentRunner:
    def __init__(self, runtime: Runtime):
        self._runtime = runtime
        assert runtime.subagent_store is not None
        self._store: SubagentStore = runtime.subagent_store
        self._builder = SubagentBuilder(runtime)

    async def run(self, req: ForegroundRunRequest) -> ToolReturnValue:
        prepared = await self._prepare_instance(req)
        agent_id = prepared.record.agent_id
        actual_type = prepared.actual_type
        resumed = prepared.resumed

        type_def = self._runtime.labor_market.require_builtin_type(actual_type)
        launch_spec = prepared.record.launch_spec
        if req.model is not None:
            launch_spec = replace(
                launch_spec,
                model_override=req.model,
                effective_model=req.model,
            )

        output_writer = SubagentOutputWriter(self._store.output_path(agent_id))
        output_writer.stage("runner_started")

        agent = await self._builder.build_builtin_instance(
            agent_id=agent_id,
            type_def=type_def,
            launch_spec=launch_spec,
        )
        output_writer.stage("agent_built")

        context = Context(self._store.context_path(agent_id))
        await context.restore()
        output_writer.stage("context_restored")
        if context.system_prompt is not None:
            agent = replace(agent, system_prompt=context.system_prompt)
        else:
            await context.write_system_prompt(agent.system_prompt)
        output_writer.stage("context_ready")

        self._store.prompt_path(agent_id).write_text(req.prompt, encoding="utf-8")
        self._store.update_instance(
            agent_id,
            status="running_foreground",
            description=req.description.strip(),
        )

        soul = KimiSoul(agent, context=context)
        tool_call = get_current_tool_call_or_none()
        ui_loop_fn = self._make_ui_loop_fn(
            parent_tool_call_id=tool_call.id if tool_call is not None else None,
            agent_id=agent_id,
            subagent_type=actual_type,
            output_writer=output_writer,
        )

        # Use a single stable ApprovalSource for the entire run (including summary
        # continuation).  This ensures cancel_by_source can reliably cancel all
        # pending approval requests belonging to this foreground subagent execution.
        approval_source = ApprovalSource(
            kind="foreground_turn",
            id=uuid.uuid4().hex,
            agent_id=agent_id,
            subagent_type=actual_type,
        )
        approval_source_token = set_current_approval_source(approval_source)
        try:
            # --- SubagentStart hook ---
            hook_engine = soul.hook_engine
            if hook_engine and hook_engine.has_hooks_for("SubagentStart"):
                from kimi_cli.hooks import events as hook_events

                await hook_engine.trigger(
                    "SubagentStart",
                    matcher_value=actual_type,
                    input_data=hook_events.subagent_start(
                        session_id=self._runtime.session.id,
                        cwd=str(Path.cwd()),
                        agent_name=actual_type,
                        prompt=req.prompt[:500],
                    ),
                )

            output_writer.stage("run_soul_start")
            final_response, failure = await run_with_summary_continuation(
                soul,
                req.prompt,
                ui_loop_fn,
                self._store.wire_path(agent_id),
            )
            if failure is not None:
                self._store.update_instance(agent_id, status="failed")
                output_writer.stage(f"failed: {failure.brief}")
                return ToolError(message=failure.message, brief=failure.brief)
            output_writer.stage("run_soul_finished")

            # --- SubagentStop hook ---
            if hook_engine and hook_engine.has_hooks_for("SubagentStop"):
                from kimi_cli.hooks import events as hook_events

                _bg = asyncio.create_task(
                    hook_engine.trigger(
                        "SubagentStop",
                        matcher_value=actual_type,
                        input_data=hook_events.subagent_stop(
                            session_id=self._runtime.session.id,
                            cwd=str(Path.cwd()),
                            agent_name=actual_type,
                            response=(final_response or "")[:500],
                        ),
                    )
                )
                _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
        except asyncio.CancelledError:
            self._store.update_instance(agent_id, status="killed")
            output_writer.stage("cancelled")
            raise
        except Exception:
            self._store.update_instance(agent_id, status="failed")
            output_writer.stage("failed_exception")
            raise
        finally:
            reset_current_approval_source(approval_source_token)
            if self._runtime.approval_runtime is not None:
                self._runtime.approval_runtime.cancel_by_source(
                    approval_source.kind, approval_source.id
                )

        assert final_response is not None
        self._store.update_instance(agent_id, status="idle")
        output_writer.summary(final_response)
        lines = [
            f"agent_id: {agent_id}",
            "resumed: true" if resumed else "resumed: false",
        ]
        if resumed and req.requested_type and req.requested_type != actual_type:
            lines.append(f"requested_subagent_type: {req.requested_type}")
        lines.extend(
            [
                f"actual_subagent_type: {actual_type}",
                "status: completed",
                "",
                "[summary]",
                final_response,
            ]
        )
        return ToolOk(output="\n".join(lines))

    async def _prepare_instance(self, req: ForegroundRunRequest) -> PreparedInstance:
        if req.resume:
            record = self._store.require_instance(req.resume)
            if record.status in {"running_foreground", "running_background"}:
                raise RuntimeError(
                    f"Agent instance {record.agent_id} is still {record.status} and cannot be "
                    "resumed concurrently."
                )
            return PreparedInstance(
                record=record,
                actual_type=record.subagent_type,
                resumed=True,
            )

        actual_type = req.requested_type or "coder"
        type_def = self._runtime.labor_market.require_builtin_type(actual_type)
        agent_id = f"a{uuid.uuid4().hex[:8]}"
        record = self._store.create_instance(
            agent_id=agent_id,
            description=req.description.strip(),
            launch_spec=AgentLaunchSpec(
                agent_id=agent_id,
                subagent_type=actual_type,
                model_override=req.model,
                effective_model=req.model or type_def.default_model,
            ),
        )
        return PreparedInstance(
            record=record,
            actual_type=actual_type,
            resumed=False,
        )

    @staticmethod
    def _make_ui_loop_fn(
        *,
        parent_tool_call_id: str | None,
        agent_id: str,
        subagent_type: str,
        output_writer: SubagentOutputWriter,
    ):
        super_wire = get_wire_or_none()

        async def _ui_loop_fn(wire: Wire) -> None:
            wire_ui = wire.ui_side(merge=True)
            while True:
                msg = await wire_ui.receive()
                # Always write to output file regardless of wire availability.
                output_writer.write_wire_message(msg)
                if super_wire is None or parent_tool_call_id is None:
                    continue
                if isinstance(
                    msg,
                    ApprovalRequest | ApprovalResponse | ToolCallRequest | QuestionRequest,
                ):
                    super_wire.soul_side.send(msg)
                    continue
                if isinstance(msg, HookRequest):
                    continue
                super_wire.soul_side.send(
                    SubagentEvent(
                        parent_tool_call_id=parent_tool_call_id,
                        agent_id=agent_id,
                        subagent_type=subagent_type,
                        event=msg,
                    )
                )

        return _ui_loop_fn
