"""Adaptive execution strategies for different plan sizes.

This module provides strategy classes that adapt execution parameters
based on plan size and system resources, optimizing for performance
and reliability.
"""

from abc import ABC, abstractmethod
from typing import Literal


class ExecutionStrategy(ABC):
    """Abstract base class for execution strategies."""
    
    @abstractmethod
    def get_max_parallel(self, plan_size: int) -> int:
        """Get maximum parallel execution limit.
        
        Args:
            plan_size: Total number of steps in the plan
            
        Returns:
            Maximum number of steps to execute in parallel
        """
        pass
    
    @abstractmethod
    def get_checkpoint_frequency(self) -> int:
        """Get checkpoint save frequency.
        
        Returns:
            Number of waves between checkpoints
        """
        pass
    
    @abstractmethod
    def should_throttle_progress(self) -> bool:
        """Check if progress UI should be throttled.
        
        Returns:
            True if UI updates should be throttled for performance
        """
        pass
    
    @abstractmethod
    def get_retry_policy(self) -> dict:
        """Get retry policy parameters.
        
        Returns:
            Dict with retry configuration:
            - max_retries: int - Maximum retry attempts
            - base_delay: float - Base delay between retries (seconds)
            - max_delay: float - Maximum delay between retries (seconds)
        """
        pass


class SmallPlanStrategy(ExecutionStrategy):
    """Aggressive parallelization for small plans (< 5 steps).
    
    Optimized for speed with frequent checkpoints.
    """
    
    def get_max_parallel(self, plan_size: int) -> int:
        return min(plan_size, 8)  # Max 8 parallel
    
    def get_checkpoint_frequency(self) -> int:
        return 1  # After every wave
    
    def should_throttle_progress(self) -> bool:
        return False
    
    def get_retry_policy(self) -> dict:
        return {
            "max_retries": 3,
            "base_delay": 1.0,
            "max_delay": 8.0,
        }


class MediumPlanStrategy(ExecutionStrategy):
    """Balanced strategy for medium plans (5-19 steps).
    
    Balances speed with resource usage.
    """
    
    def get_max_parallel(self, plan_size: int) -> int:
        return min(plan_size, 4)
    
    def get_checkpoint_frequency(self) -> int:
        return 2  # Every 2 waves
    
    def should_throttle_progress(self) -> bool:
        return False
    
    def get_retry_policy(self) -> dict:
        return {
            "max_retries": 3,
            "base_delay": 2.0,
            "max_delay": 16.0,
        }


class LargePlanStrategy(ExecutionStrategy):
    """Memory-efficient strategy for large plans (>= 20 steps).
    
    Prioritizes stability and progress over speed.
    """
    
    def get_max_parallel(self, plan_size: int) -> int:
        return min(plan_size, 2)  # Conservative
    
    def get_checkpoint_frequency(self) -> int:
        return 1  # Frequent checkpoints
    
    def should_throttle_progress(self) -> bool:
        return True  # Reduce UI updates
    
    def get_retry_policy(self) -> dict:
        return {
            "max_retries": 5,  # More retries for long-running plans
            "base_delay": 2.0,
            "max_delay": 32.0,
        }


def get_strategy(plan_size: int) -> ExecutionStrategy:
    """Get appropriate strategy for plan size.
    
    Args:
        plan_size: Total number of steps in the plan
        
    Returns:
        ExecutionStrategy instance optimized for the plan size
    """
    if plan_size < 5:
        return SmallPlanStrategy()
    elif plan_size < 20:
        return MediumPlanStrategy()
    else:
        return LargePlanStrategy()


def get_strategy_name(strategy: ExecutionStrategy) -> str:
    """Get human-readable name for strategy.
    
    Args:
        strategy: Execution strategy instance
        
    Returns:
        Human-readable strategy name
    """
    if isinstance(strategy, SmallPlanStrategy):
        return "small"
    elif isinstance(strategy, MediumPlanStrategy):
        return "medium"
    elif isinstance(strategy, LargePlanStrategy):
        return "large"
    return "unknown"
