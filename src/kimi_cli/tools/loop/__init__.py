from __future__ import annotations

import uuid
from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolReturnValue
from pydantic import BaseModel, Field, field_validator

from kimi_cli.loop.models import LoopTask
from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.utils import ToolResultBuilder, load_desc
from kimi_cli.utils.logging import logger


class Params(BaseModel):
    cron: str = Field(description="A valid 5-field cron expression in local time.")
    prompt: str = Field(description="The prompt to run when the schedule fires.")
    recurring: bool = Field(
        default=False,
        description="If true, the task will reschedule after each fire. If false, it runs once.",
    )
    durable: bool = Field(
        default=False,
        description=(
            "If true, persist the task to disk so it survives process restarts. "
            "Session-only tasks (false) die when the CLI exits."
        ),
    )

    @field_validator("cron")
    @classmethod
    def _validate_cron(cls, v: str) -> str:
        # Basic sanity check: 5 fields
        parts = v.strip().split()
        if len(parts) != 5:
            raise ValueError(
                f"Cron expression must have exactly 5 space-separated fields, got {len(parts)}"
            )
        return v.strip()


class CreateCronTask(CallableTool2[Params]):
    name: str = "CreateCronTask"
    params: type[Params] = Params

    def __init__(self, runtime: Runtime) -> None:
        super().__init__(description=load_desc(Path(__file__).parent / "create_cron_task.md"))
        self._runtime = runtime

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        builder = ToolResultBuilder()
        scheduler = self._runtime.loop_scheduler

        if scheduler is None:
            return builder.error("Loop scheduler is not available.", brief="No scheduler")

        # Validate cron more thoroughly using croniter
        try:
            from croniter import croniter  # type: ignore[import-untyped]

            if not croniter.is_valid(params.cron):
                return builder.error(
                    f"Invalid cron expression: '{params.cron}'. Must be a valid 5-field cron.",
                    brief="Invalid cron",
                )

            # Ensure it matches at least one date in the next year
            itr = croniter(params.cron)
            nxt = itr.get_next(float)
            if nxt is None:
                return builder.error(
                    f"Cron expression '{params.cron}' does not match any future date.",
                    brief="Cron has no future matches",
                )
        except ImportError:
            return builder.error(
                "croniter is required for cron validation but is not installed.",
                brief="Missing croniter",
            )
        except Exception as e:
            return builder.error(f"Cron validation failed: {e}", brief="Cron validation error")

        # Enforce max jobs
        current_count = len(scheduler.list_tasks())
        if current_count >= self._runtime.config.loop.max_jobs:
            return builder.error(
                f"Maximum scheduled tasks ({self._runtime.config.loop.max_jobs}) reached. "
                "Cancel an existing task before creating a new one.",
                brief="Max tasks reached",
            )

        # Compute effective durability
        effective_durable = params.durable and self._runtime.config.loop.durable_enabled
        if params.durable and not self._runtime.config.loop.durable_enabled:
            logger.info("Durable tasks are disabled; creating session-only task")

        # Reject durable for subagent contexts
        if effective_durable and self._runtime.role != "root":
            return builder.error(
                "Durable tasks are not allowed in subagent contexts.",
                brief="Durable not allowed for subagent",
            )

        # Create task
        task_id = uuid.uuid4().hex[:8]
        now_ms = int(__import__("time").time() * 1000)
        task = LoopTask(
            id=task_id,
            cron=params.cron,
            prompt=params.prompt,
            created_at=now_ms,
            recurring=params.recurring,
            durable=effective_durable,
        )

        try:
            scheduler.add_task(task)
        except RuntimeError as e:
            return builder.error(str(e), brief="Failed to add task")

        # Human-readable schedule description
        human_schedule = self._humanize_cron(params.cron)

        builder.write(
            f"Scheduled task created:\n"
            f"- ID: {task_id}\n"
            f"- Schedule: {human_schedule} ({params.cron})\n"
            f"- Recurring: {params.recurring}\n"
            f"- Durable: {effective_durable}\n"
        )

        if params.recurring and not task.permanent:
            max_age_days = self._runtime.config.loop.jitter.recurring_max_age_ms / (
                24 * 60 * 60 * 1000
            )
            builder.write(f"- Auto-expires after {max_age_days:.0f} days\n")

        return builder.ok(message=f"Task {task_id} scheduled: {human_schedule}")

    @staticmethod
    def _humanize_cron(cron: str) -> str:
        """Return a rough human-readable description of a cron expression."""
        parts = cron.split()
        minute, hour, dom, month, dow = parts

        if cron == "*/1 * * * *":
            return "every minute"
        if cron.startswith("*/") and hour == "*" and dom == "*" and month == "*" and dow == "*":
            return f"every {minute[2:]} minutes"
        if minute == "0" and hour.startswith("*/") and dom == "*" and month == "*" and dow == "*":
            return f"every {hour[2:]} hours"
        if minute == "0" and hour == "0" and dom.startswith("*/") and month == "*" and dow == "*":
            return f"every {dom[2:]} days at midnight"
        if minute == "0" and hour == "0" and dom == "*" and month == "*" and dow == "*":
            return "daily at midnight"
        if minute == "0" and hour == "*" and dom == "*" and month == "*" and dow == "*":
            return "hourly"

        return f"cron: {cron}"
