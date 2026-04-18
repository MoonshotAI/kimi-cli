import asyncio
from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.subagents.models import AgentLaunchSpec, AgentTypeDefinition
from kimi_cli.subagents.runner import ForegroundRunRequest, ForegroundSubagentRunner
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.logging import logger

NAME = "Agent"

MAX_FOREGROUND_TIMEOUT = 60 * 60  # 1 hour
MAX_BACKGROUND_TIMEOUT = 60 * 60  # 1 hour


class Params(BaseModel):
    description: str = Field(description="A short (3-5 word) description of the task")
    prompt: str = Field(description="The task for the agent to perform")
    subagent_type: str = Field(
        default="coder",
        description="The built-in agent type to use. Defaults to `coder`.",
    )
    model: str | None = Field(
        default=None,
        description=(
            "Optional model override. Selection priority is: this parameter, then the built-in "
            "type default model, then the parent agent's current model."
        ),
    )
    resume: str | None = Field(
        default=None,
        description="Optional agent ID to resume instead of creating a new instance.",
    )
    run_in_background: bool = Field(
        default=False,
        description=(
            "Whether to run the agent in the background. Prefer false unless the task can "
            "continue independently and there is a clear benefit to returning control before "
            "the result is needed."
        ),
    )
    timeout: int | None = Field(
        default=None,
        description=(
            "Timeout in seconds for the agent task. "
            "Foreground: no default timeout (runs until completion), max 3600s (1hr). "
            "Background: default from config (15min), max 3600s (1hr). "
            "The agent is stopped if it exceeds this limit."
        ),
        ge=30,
        le=MAX_BACKGROUND_TIMEOUT,
    )
    work_dir: str | None = Field(
        default=None,
        description=(
            "Optional working directory for the subagent. When set, the subagent's file tools "
            "and system prompt will use this directory instead of the parent agent's working "
            "directory. Must be an absolute path."
        ),
    )

    @property
    def effective_timeout(self) -> int | None:
        """Return the user-specified timeout, or None to use the system default."""
        return self.timeout


class AgentTool(CallableTool2[Params]):
    name: str = NAME
    params: type[Params] = Params

    def __init__(self, runtime: Runtime):
        super().__init__(
            description=load_desc(
                Path(__file__).parent / "description.md",
                {
                    "BUILTIN_AGENT_TYPES_MD": self._builtin_type_lines(runtime),
                },
            )
        )
        self._runtime = runtime

    @staticmethod
    def _builtin_type_lines(runtime: Runtime) -> str:
        lines: list[str] = []
        for name, type_def in runtime.labor_market.builtin_types.items():
            tool_names = AgentTool._tool_summary(type_def)
            model = type_def.default_model or "inherit"
            suffix = (
                f" When to use: {AgentTool._normalize_summary(type_def.when_to_use)}"
                if type_def.when_to_use
                else ""
            )
            background = "yes" if type_def.supports_background else "no"
            lines.append(
                f"- `{name}`: {type_def.description} "
                f"(Tools: {tool_names}, Model: {model}, Background: {background}).{suffix}"
            )
        return "\n".join(lines)

    @staticmethod
    def _normalize_summary(text: str) -> str:
        return " ".join(text.split())

    @staticmethod
    def _tool_summary(type_def: AgentTypeDefinition) -> str:
        if type_def.tool_policy.mode != "allowlist":
            return "*"
        if not type_def.tool_policy.tools:
            return "(none)"
        return ", ".join(AgentTool._unique_tool_names(type_def.tool_policy.tools))

    @staticmethod
    def _unique_tool_names(tool_paths: tuple[str, ...]) -> list[str]:
        names: list[str] = []
        for path in tool_paths:
            name = path.split(":")[-1]
            if name not in names:
                names.append(name)
        return names

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        if self._runtime.role != "root":
            return ToolError(
                message="Subagents cannot launch other subagents.",
                brief="Agent unavailable",
            )
        if params.model is not None and params.model not in self._runtime.config.models:
            return ToolError(
                message=f"Unknown model alias: {params.model}",
                brief="Invalid model alias",
            )
        if params.run_in_background:
            return await self._run_in_background(params)
        timeout = params.effective_timeout
        try:
            runner = ForegroundSubagentRunner(self._runtime)
            req = ForegroundRunRequest(
                description=params.description,
                prompt=params.prompt,
                requested_type=params.subagent_type or "coder",
                model=params.model,
                resume=params.resume,
                work_dir=params.work_dir,
            )
            if timeout is not None:
                return await asyncio.wait_for(runner.run(req), timeout=timeout)
            return await runner.run(req)
        except TimeoutError as exc:
            # Note: TimeoutError from run_soul internals (e.g. aiohttp) is now caught
            # by run_soul_checked and converted to SoulRunFailure. This handler mainly
            # covers wait_for's task-level timeout and pre-run_soul TimeoutErrors.
            if isinstance(exc.__cause__, asyncio.CancelledError):
                logger.warning("Foreground agent timed out after {t}s", t=timeout)
                return ToolError(
                    message=f"Agent timed out after {timeout}s.",
                    brief=f"Agent timed out ({timeout}s)",
                )
            # Internal timeout (e.g. aiohttp request) — treat as generic failure
            logger.exception("Foreground agent run failed")
            return ToolError(message=f"Failed to run agent: {exc}", brief="Agent failed")
        except Exception as exc:
            logger.exception("Foreground agent run failed")
            return ToolError(message=f"Failed to run agent: {exc}", brief="Agent failed")

    async def _run_in_background(self, params: Params) -> ToolReturnValue:
        assert self._runtime.subagent_store is not None
        try:
            tool_call = get_current_tool_call_or_none()
            if tool_call is None:
                return ToolError(
                    message="Background agent requires a tool call context.",
                    brief="No tool call context",
                )

            requested_type = params.subagent_type or "coder"
            if params.resume:
                record = self._runtime.subagent_store.require_instance(params.resume)
                if record.status in {"running_foreground", "running_background"}:
                    return ToolError(
                        message=(
                            f"Agent instance {record.agent_id} is still {record.status} and cannot "
                            "be resumed concurrently."
                        ),
                        brief="Agent already running",
                    )
                actual_type = record.subagent_type
                agent_id = record.agent_id
                # Validate the effective model for resumed instances — the model
                # stored in the launch spec may have been removed from config since
                # the instance was created.  params.model is already validated in
                # __call__, so only check the stored effective_model fallback here.
                if params.model is None:
                    type_def = self._runtime.labor_market.require_builtin_type(actual_type)
                    effective = record.launch_spec.effective_model or type_def.default_model
                    if effective is not None and effective not in self._runtime.config.models:
                        return ToolError(
                            message=f"Unknown model alias: {effective}",
                            brief="Invalid model alias",
                        )
            else:
                actual_type = requested_type
                import uuid

                agent_id = f"a{uuid.uuid4().hex[:8]}"
                record = None

            created_instance = False
            if not params.resume:
                type_def = self._runtime.labor_market.require_builtin_type(actual_type)
                self._runtime.subagent_store.create_instance(
                    agent_id=agent_id,
                    description=params.description.strip(),
                    launch_spec=AgentLaunchSpec(
                        agent_id=agent_id,
                        subagent_type=actual_type,
                        model_override=params.model,
                        effective_model=params.model or type_def.default_model,
                        work_dir=params.work_dir,
                    ),
                )
                created_instance = True

            # Mark running_background synchronously before dispatching the
            # async task so that concurrent resume attempts see the guard
            # immediately (asyncio.create_task only queues the coroutine).
            self._runtime.subagent_store.update_instance(
                agent_id,
                status="running_background",
            )
            try:
                view = self._runtime.background_tasks.create_agent_task(
                    agent_id=agent_id,
                    subagent_type=actual_type,
                    prompt=params.prompt,
                    description=params.description.strip(),
                    tool_call_id=tool_call.id,
                    model_override=params.model,
                    timeout_s=params.effective_timeout,
                    resumed=params.resume is not None,
                )
            except Exception:
                self._runtime.subagent_store.update_instance(
                    agent_id,
                    status="idle",
                )
                if created_instance:
                    self._runtime.subagent_store.delete_instance(agent_id)
                raise
            lines = [
                f"task_id: {view.spec.id}",
                f"kind: {view.spec.kind}",
                f"status: {view.runtime.status}",
                f"description: {view.spec.description}",
                f"agent_id: {agent_id}",
                f"actual_subagent_type: {actual_type}",
                "automatic_notification: true",
                "next_step: You will be automatically notified when it completes.",
                (
                    "next_step: Use TaskOutput with this task_id for a non-blocking status/output "
                    "snapshot. Only set block=true when you intentionally want to wait."
                ),
                f'resume_hint: Use Agent(resume="{agent_id}", prompt="...") to continue this '
                "instance later.",
            ]
            return ToolReturnValue(
                is_error=False,
                output="\n".join(lines),
                message="Background task started.",
                display=[],
            )
        except FileNotFoundError as exc:
            return ToolError(message=str(exc), brief="Agent not found")
        except KeyError as exc:
            return ToolError(message=str(exc), brief="Invalid subagent type")
        except RuntimeError as exc:
            logger.exception("Background agent launch failed")
            return ToolError(message=str(exc), brief="Background start failed")


Agent = AgentTool
