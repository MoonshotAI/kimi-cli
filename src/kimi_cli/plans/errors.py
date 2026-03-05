"""Custom exception classes for plan execution.

This module defines all custom exceptions used by the plans module,
providing fine-grained error handling for different failure scenarios.
"""


class PlansError(Exception):
    """Base exception for all plan-related errors."""
    pass


class LLMTimeoutError(PlansError):
    """Raised when LLM request times out."""
    pass


class LLMRateLimitError(PlansError):
    """Raised when LLM rate limit (429) is hit."""
    
    def __init__(self, message: str = "Rate limit exceeded", retry_after: int = 60):
        super().__init__(message)
        self.retry_after = retry_after


class LLMError(PlansError):
    """Raised for general LLM errors (500, etc.)."""
    
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class DiskFullError(PlansError):
    """Raised when checkpoint cannot be saved due to disk full."""
    pass


class CheckpointCorruptedError(PlansError):
    """Raised when checkpoint file is corrupted or unreadable."""
    pass


class ExecutionAborted(PlansError):
    """Raised when user aborts execution or shutdown is requested."""
    pass


class NetworkError(PlansError):
    """Raised when network connection fails during execution."""
    pass


class StepExecutionError(PlansError):
    """Raised when step execution fails with unrecoverable error."""
    
    def __init__(self, message: str, step_id: str | None = None):
        super().__init__(message)
        self.step_id = step_id
