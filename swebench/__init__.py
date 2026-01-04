"""SWE-Bench evaluation using Kimi CLI."""

from swebench_kimi_eval.config import EvalConfig
from swebench_kimi_eval.evaluator import EvalResult, SWEBenchEvaluator

__version__ = "0.1.0"

__all__ = [
    "SWEBenchEvaluator",
    "EvalConfig",
    "EvalResult",
]

