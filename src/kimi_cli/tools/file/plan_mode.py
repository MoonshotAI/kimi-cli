from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from kaos.path import KaosPath
from kosong.tooling import ToolError


@dataclass(frozen=True)
class PlanEditTarget:
    active: bool
    plan_path: Path | None
    is_plan_target: bool


def inspect_plan_edit_target(
    path: KaosPath,
    *,
    plan_mode_checker: Callable[[], bool] | None,
    plan_file_path_getter: Callable[[], Path | None] | None,
) -> PlanEditTarget | ToolError:
    """Resolve whether a file edit is targeting the current plan artifact."""
    if plan_mode_checker is None or not plan_mode_checker():
        return PlanEditTarget(active=False, plan_path=None, is_plan_target=False)

    plan_path = plan_file_path_getter() if plan_file_path_getter is not None else None
    if plan_path is None:
        return ToolError(
            message="Plan mode is active, but the current plan file is unavailable.",
            brief="Plan file unavailable",
        )

    canonical_plan_path = KaosPath(str(plan_path)).canonical()
    if str(path) != str(canonical_plan_path):
        return ToolError(
            message=(
                "Plan mode is active. You may only edit the current plan file: "
                f"`{canonical_plan_path}`."
            ),
            brief="Plan mode restriction",
        )

    return PlanEditTarget(active=True, plan_path=plan_path, is_plan_target=True)
