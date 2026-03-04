"""
Data models for the kimi-cli Plans System.

This module defines the core data structures for plan generation,
storage, and execution tracking.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional


@dataclass
class PlanOption:
    """
    Represents a single plan option with trade-offs and estimates.
    
    Attributes:
        id: Numeric identifier (1, 2, or 3)
        title: Short descriptive name for the option
        description: Detailed explanation of the approach
        pros: List of advantages for this option
        cons: List of disadvantages for this option
        estimated_time: Time estimate (e.g., "5 min", "30 min", "2 hours") or None
        approach_type: Classification of the approach type
    """
    id: int
    title: str
    description: str
    pros: list[str]
    cons: list[str]
    estimated_time: Optional[str]
    approach_type: Literal["quick", "proper", "hybrid"]


@dataclass
class Plan:
    """
    Represents a plan with multiple options for a user request.
    
    Attributes:
        id: Unique identifier (UUID or timestamp-based)
        query: Original user request/query
        options: List of 2-3 plan options to choose from
        created_at: Timestamp when the plan was created
        context_snapshot: Relevant context at the time of plan creation
    """
    id: str
    query: str
    options: list[PlanOption]
    created_at: datetime
    context_snapshot: dict


@dataclass
class PlanExecution:
    """
    Tracks the execution of a selected plan option.
    
    Attributes:
        plan_id: Reference to the executed plan
        selected_option: The option ID that was chosen (1, 2, or 3)
        executed_at: Timestamp when execution started
        status: Current execution status
    """
    plan_id: str
    selected_option: int
    executed_at: datetime
    status: Literal["pending", "completed", "failed"]
