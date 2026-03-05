"""Plans API routes."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from kimi_cli.plans.storage import PlanStorage
from kimi_cli.plans.checkpoint import CheckpointManager
from kimi_cli.plans.history import get_history, HistoryEntry
from kimi_cli.plans.analytics import PlanAnalytics
from kimi_cli.plans.scheduler import PlanScheduler, ScheduledPlan
from kimi_cli.plans.models import Plan, PlanOption, PlanStep, PlanExecution, StepExecution
from kimi_cli.plans.generator import PlanGenerator
from kimi_cli.llm import get_default_llm

router = APIRouter(prefix="/api/plans", tags=["plans"])


# Pydantic models for requests and responses

class PlanOptionResponse(BaseModel):
    """Response model for plan options."""
    id: int
    title: str
    description: str
    approach: str  # quick, balanced, thorough (mapped from approach_type)
    estimated_time: Optional[str]
    pros: list[str]
    cons: list[str]


class PlanStepResponse(BaseModel):
    """Response model for plan steps."""
    step_number: int
    title: str
    description: str
    files_to_modify: list[str]
    dependencies: list[int]
    can_parallel: bool


class PlanResponse(BaseModel):
    """Response model for plan list items."""
    plan_id: str
    query: str
    created_at: str


class PlanDetailResponse(BaseModel):
    """Response model for detailed plan view."""
    plan_id: str
    query: str
    options: list[PlanOptionResponse]
    steps: list[PlanStepResponse]
    created_at: str


class GeneratePlanRequest(BaseModel):
    """Request to generate a new plan."""
    query: str
    context_files: Optional[list[str]] = None


class ExecutePlanRequest(BaseModel):
    """Request to execute a plan."""
    option_id: Optional[int] = None
    resume: bool = False


class ExecutionResponse(BaseModel):
    """Response for plan execution start."""
    plan_id: str
    execution_id: str
    status: str


class FileChangeResponse(BaseModel):
    """Response for file changes."""
    path: str
    change_type: str  # added, modified, deleted


class StepExecutionResponse(BaseModel):
    """Response for step execution status."""
    step_number: int
    title: str
    status: str  # pending, running, completed, failed, skipped
    started_at: Optional[str]
    completed_at: Optional[str]
    error_message: Optional[str]
    retry_count: int
    file_changes: list[FileChangeResponse]
    lines_added: int
    lines_removed: int


class ExecutionStatusResponse(BaseModel):
    """Response for execution status."""
    plan_id: str
    status: str  # pending, running, completed, failed, aborted
    steps: list[StepExecutionResponse]
    started_at: Optional[str]
    completed_at: Optional[str]
    current_step: int


class HistoryEntryResponse(BaseModel):
    """Response for history entry."""
    plan_id: str
    query: str
    started_at: str
    completed_at: Optional[str]
    outcome: str
    files_changed: int


class HistoryStatsResponse(BaseModel):
    """Response for history statistics."""
    total: int
    successful: int
    failed: int
    success_rate: float
    avg_duration_seconds: float
    total_files_changed: int


class HistoryResponse(BaseModel):
    """Response for session history."""
    entries: list[HistoryEntryResponse]
    stats: HistoryStatsResponse


class AnalyticsResponse(BaseModel):
    """Response for analytics data."""
    stats: dict[str, Any]


class ScheduledPlanResponse(BaseModel):
    """Response for scheduled plan."""
    schedule_id: str
    plan_id: str
    scheduled_at: str
    run_at: str
    query: str
    status: str


class SuccessResponse(BaseModel):
    """Generic success response."""
    success: bool


# SSE event types
class SSEEvent(BaseModel):
    """Base SSE event."""
    type: str
    data: dict[str, Any]

    def to_sse(self) -> str:
        """Convert to SSE format."""
        return f"data: {json.dumps({'type': self.type, **self.data})}\n\n"


# Helper functions

def _plan_to_response(plan: Plan) -> PlanDetailResponse:
    """Convert Plan to PlanDetailResponse."""
    return PlanDetailResponse(
        plan_id=plan.id,
        query=plan.query,
        options=[
            PlanOptionResponse(
                id=opt.id,
                title=opt.title,
                description=opt.description,
                approach=opt.approach_type,  # Map approach_type to approach
                estimated_time=opt.estimated_time,
                pros=opt.pros,
                cons=opt.cons,
            )
            for opt in plan.options
        ],
        steps=[
            PlanStepResponse(
                step_number=i + 1,
                title=step.name,
                description=step.description,
                files_to_modify=[],  # Not stored in model currently
                dependencies=[],  # Would need to parse depends_on
                can_parallel=step.can_parallel,
            )
            for i, step in enumerate(plan.steps)
        ],
        created_at=plan.created_at.isoformat(),
    )


def _execution_to_response(execution: PlanExecution) -> ExecutionStatusResponse:
    """Convert PlanExecution to ExecutionStatusResponse."""
    # Map step IDs to sequential numbers for UI
    step_map = {step.step_id: i + 1 for i, step in enumerate(execution.steps)}
    
    completed_steps = sum(1 for s in execution.steps if s.status == "completed")
    
    return ExecutionStatusResponse(
        plan_id=execution.plan_id,
        status=execution.overall_status,
        steps=[
            StepExecutionResponse(
                step_number=step_map.get(step.step_id, 0),
                title=step.step_id,  # Use step_id as title
                status=step.status,
                started_at=step.started_at.isoformat() if step.started_at else None,
                completed_at=step.completed_at.isoformat() if step.completed_at else None,
                error_message=step.error_message,
                retry_count=step.retry_count,
                file_changes=[
                    FileChangeResponse(path=f, change_type="modified")
                    for f in step.files_modified
                ],
                lines_added=step.lines_added,
                lines_removed=step.lines_removed,
            )
            for step in execution.steps
        ],
        started_at=execution.started_at.isoformat() if execution.started_at else None,
        completed_at=execution.completed_at.isoformat() if execution.completed_at else None,
        current_step=completed_steps,
    )


def _history_entry_to_response(entry: HistoryEntry) -> HistoryEntryResponse:
    """Convert HistoryEntry to HistoryEntryResponse."""
    return HistoryEntryResponse(
        plan_id=entry.plan_id,
        query=entry.query,
        started_at=entry.started_at.isoformat(),
        completed_at=entry.completed_at.isoformat() if entry.completed_at else None,
        outcome=entry.outcome,
        files_changed=entry.files_changed,
    )


def _history_stats_to_response(stats: dict) -> HistoryStatsResponse:
    """Convert history stats dict to HistoryStatsResponse."""
    return HistoryStatsResponse(
        total=stats.get("total", 0),
        successful=stats.get("successful", 0),
        failed=stats.get("failed", 0),
        success_rate=stats.get("success_rate", 0.0),
        avg_duration_seconds=stats.get("avg_duration_seconds", 0.0),
        total_files_changed=stats.get("total_files_changed", 0),
    )


def _scheduled_plan_to_response(plan: ScheduledPlan) -> ScheduledPlanResponse:
    """Convert ScheduledPlan to ScheduledPlanResponse."""
    return ScheduledPlanResponse(
        schedule_id=plan.schedule_id,
        plan_id=plan.plan_id,
        scheduled_at=plan.scheduled_at.isoformat(),
        run_at=plan.run_at.isoformat(),
        query=plan.query,
        status=plan.status,
    )


# API Endpoints

@router.get("/", response_model=list[PlanResponse])
async def list_plans() -> list[PlanResponse]:
    """List all saved plans."""
    storage = PlanStorage()
    plans = storage.list()
    return [
        PlanResponse(
            plan_id=plan_id,
            query=query,
            created_at=created_at.isoformat(),
        )
        for plan_id, query, created_at in plans
    ]


@router.get("/{plan_id}", response_model=PlanDetailResponse)
async def get_plan(plan_id: str) -> PlanDetailResponse:
    """Get plan details."""
    storage = PlanStorage()
    plan = storage.load(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _plan_to_response(plan)


@router.post("/generate", response_model=PlanDetailResponse)
async def generate_plan(request: GeneratePlanRequest) -> PlanDetailResponse:
    """Generate new plan from query."""
    try:
        llm = get_default_llm()
        generator = PlanGenerator(llm)
        plan = await generator.generate(
            user_request=request.query,
            files=request.context_files,
        )
        
        # Save the generated plan
        storage = PlanStorage()
        storage.save(plan)
        
        return _plan_to_response(plan)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate plan: {str(e)}"
        )


@router.post("/{plan_id}/execute", response_model=ExecutionResponse)
async def execute_plan(
    plan_id: str,
    request: ExecutePlanRequest,
    background_tasks: BackgroundTasks,
) -> ExecutionResponse:
    """Start plan execution."""
    storage = PlanStorage()
    plan = storage.load(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    
    # Create initial execution state
    execution = plan.to_execution()
    ckpt = CheckpointManager()
    ckpt.save(execution)
    
    # TODO: Start actual execution in background
    # For now, just return the execution info
    
    return ExecutionResponse(
        plan_id=plan_id,
        execution_id=plan_id,  # Use plan_id as execution_id
        status="started",
    )


@router.get("/{plan_id}/execution", response_model=ExecutionStatusResponse)
async def get_execution_status(plan_id: str) -> ExecutionStatusResponse:
    """Get current execution status."""
    ckpt = CheckpointManager()
    execution = ckpt.load(plan_id)
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    return _execution_to_response(execution)


async def _execution_stream(plan_id: str) -> AsyncGenerator[str, None]:
    """Generate SSE stream for execution updates."""
    ckpt = CheckpointManager()
    
    # Send initial state
    execution = ckpt.load(plan_id)
    if execution:
        yield SSEEvent(
            type="execution_update",
            data={"execution": _execution_to_response(execution).model_dump()}
        ).to_sse()
    
    # Simulate streaming updates (in real implementation, this would poll or use events)
    for _ in range(60):  # Stream for up to 60 iterations
        await asyncio.sleep(1)
        
        execution = ckpt.load(plan_id)
        if not execution:
            break
            
        yield SSEEvent(
            type="execution_update",
            data={"execution": _execution_to_response(execution).model_dump()}
        ).to_sse()
        
        # Stop if execution is complete
        if execution.overall_status in ("completed", "failed", "aborted"):
            yield SSEEvent(
                type="complete",
                data={"execution": _execution_to_response(execution).model_dump()}
            ).to_sse()
            break


@router.post("/{plan_id}/execute/stream")
async def stream_execution(plan_id: str) -> StreamingResponse:
    """Stream execution progress via SSE."""
    return StreamingResponse(
        _execution_stream(plan_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.delete("/{plan_id}", response_model=SuccessResponse)
async def delete_plan(plan_id: str) -> SuccessResponse:
    """Delete plan and associated checkpoint."""
    storage = PlanStorage()
    storage.delete(plan_id)
    
    ckpt = CheckpointManager()
    ckpt.delete(plan_id)
    
    return SuccessResponse(success=True)


@router.get("/history/session", response_model=HistoryResponse)
async def get_session_history() -> HistoryResponse:
    """Get current session plan history."""
    history = get_history()
    entries = history.get_entries()
    stats = history.get_stats()
    
    return HistoryResponse(
        entries=[_history_entry_to_response(e) for e in entries],
        stats=_history_stats_to_response(stats),
    )


@router.get("/analytics/overall", response_model=AnalyticsResponse)
async def get_analytics() -> AnalyticsResponse:
    """Get overall plan analytics."""
    storage = PlanStorage()
    ckpt = CheckpointManager()
    analytics = PlanAnalytics(storage, ckpt)
    return AnalyticsResponse(stats=analytics.get_overall_stats())


@router.get("/scheduled/list", response_model=list[ScheduledPlanResponse])
async def list_scheduled() -> list[ScheduledPlanResponse]:
    """List scheduled plans."""
    scheduler = PlanScheduler(PlanStorage())
    return [_scheduled_plan_to_response(e) for e in scheduler.list_scheduled()]
