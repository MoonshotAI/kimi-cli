"""SWE-Bench evaluation using Kimi CLI."""

from swebench.config import EvalConfig
from swebench.evaluator import EvalResult, SWEBenchEvaluator

__version__ = "0.1.0"

__all__ = [
    "SWEBenchEvaluator",
    "EvalConfig",
    "EvalResult",
]

