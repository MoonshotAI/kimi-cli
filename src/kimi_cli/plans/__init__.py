"""Plans module for ACT/PLAN mode management."""

from kimi_cli.plans.mode import ModeManager, PlanMode, get_mode_manager
from kimi_cli.plans.models import Plan, PlanOption, PlanExecution
from kimi_cli.plans.generator import PlanGenerator, PlanGenerationError
from kimi_cli.plans.detector import ComplexityDetector, ComplexityScore
from kimi_cli.plans.ui import PlanMenuRenderer
from kimi_cli.plans.interactive import InteractivePlanMenu
from kimi_cli.plans.storage import PlanStorage
from kimi_cli.plans.detail import PlanDetailView
from kimi_cli.plans.executor import PlanExecutor
from kimi_cli.plans.errors import (
    PlansError,
    LLMTimeoutError,
    LLMRateLimitError,
    LLMError,
    DiskFullError,
    CheckpointCorruptedError,
    ExecutionAborted,
    NetworkError,
    StepExecutionError,
)
from kimi_cli.plans.strategies import (
    ExecutionStrategy,
    SmallPlanStrategy,
    MediumPlanStrategy,
    LargePlanStrategy,
    get_strategy,
    get_strategy_name,
)

__all__ = [
    # Mode management
    "ModeManager",
    "PlanMode",
    "get_mode_manager",
    # Plan models and generation
    "Plan",
    "PlanOption",
    "PlanExecution",
    "PlanGenerator",
    "PlanGenerationError",
    "ComplexityDetector",
    "ComplexityScore",
    "PlanMenuRenderer",
    # Phase 2: Interactive UI and persistence
    "InteractivePlanMenu",
    "PlanStorage",
    "PlanDetailView",
    # Phase 3: Execution engine
    "PlanExecutor",
    # Phase 4: Error handling and strategies
    "ExecutionAborted",
    "PlansError",
    "LLMTimeoutError",
    "LLMRateLimitError",
    "LLMError",
    "DiskFullError",
    "CheckpointCorruptedError",
    "NetworkError",
    "StepExecutionError",
    # Phase 4: Adaptive strategies
    "ExecutionStrategy",
    "SmallPlanStrategy",
    "MediumPlanStrategy",
    "LargePlanStrategy",
    "get_strategy",
    "get_strategy_name",
]
