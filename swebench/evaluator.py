# type: ignore
import asyncio
import json
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
import traceback

import pandas as pd
from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.kimi_solver import KimiContainerSolver
from swebench.runtime import SWEBenchContainerRuntime
from swebench.utils.utils import filter_binary_diffs

if TYPE_CHECKING:
    from swebench.utils.log import EvalRunLogger


@dataclass
class EvalResult:
    instance_id: str
    status: str
    git_patch: str = ""
    error: str | None = None
    history: list[dict[str, Any]] | None = None
    metrics: dict[str, Any] | None = None
    duration_seconds: float = 0.0
    trace: list[dict[str, Any]] | None = None


    def __post_init__(self) -> None:
        self.history = self.history or []
        self.metrics = self.metrics or {}
        self.trace = self.trace or []


    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "status": self.status,
            "git_patch": self.git_patch,
            "error": self.error,
            "history": self.history,
            "metrics": self.metrics,
            "duration_seconds": self.duration_seconds,
            "trace": self.trace,
        }


    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class SWEBenchInstanceEvaluator:
    def __init__(self, instance: pd.Series, config: EvalConfig, run_logger: "EvalRunLogger | None" = None):
        self.instance = instance
        self.config = config
        self.run_logger = run_logger


    async def evaluate(self) -> EvalResult:
        start_time = asyncio.get_event_loop().time()
        instance_id = self.instance["instance_id"]
        result = EvalResult(instance_id=instance_id, status="error")

        try:
            runtime = SWEBenchContainerRuntime(self.instance.to_dict(), self.config, "/testbed")
            await runtime.start()

            try:
                await runtime.checkout_base_commit()
                logger.info("Base commit checked out, starting Kimi solver...")

                problem_statement = self.instance.get("problem_statement") or self.instance.get("description", "Fix this issue")
                logger.info(f"Problem statement: {problem_statement[:100]}...")

                def log_interaction(round_num: int, role: str, content: str) -> None:
                    if self.run_logger:
                        self.run_logger.log_instance_interaction(instance_id, round_num, role, content)
                
                logger.info(f"Creating KimiContainerSolver with container: {runtime.runtime.container_name}")
                solver = KimiContainerSolver(
                    container=runtime.runtime,
                    working_dir=runtime.working_dir,
                    config=self.config,
                    problem_statement=problem_statement,
                    interaction_logger=log_interaction,
                )
                logger.info("KimiContainerSolver created, calling solve()...")
                sys.stderr.flush()
                
                try:
                    solve_result = await asyncio.wait_for(
                        solver.solve(),
                        timeout=self.config.timeout_seconds
                    )
                except asyncio.TimeoutError:
                    logger.error("Solver timed out after {} seconds", self.config.timeout_seconds)
                    raise

                trace = solve_result.get("trace", [])
                logger.info(f"Extracted {len(trace)} trace records")
                result.trace = trace
                
                if self.run_logger:
                    self.run_logger.log_instance_interaction(
                        instance_id, 1, "user", problem_statement
                    )
                    self.run_logger.log_instance_interaction(
                        instance_id, 1, "assistant", solve_result["output"]
                    )

                git_patch = await runtime.get_git_diff()
                result.git_patch = filter_binary_diffs(git_patch)
                result.status = "success"

                logger.info(f"✓ {instance_id}: completed")

                if self.run_logger:
                    self.run_logger.log_instance_summary(
                        instance_id,
                        "success",
                        {"duration_seconds": result.duration_seconds},
                    )
                    
            except Exception as e:
                error_msg = f"✗ {instance_id}: {type(e).__name__}: {str(e)}"
                traceback.print_exc()
                logger.error("Error during evaluation: {}", error_msg, exc_info=True)
                print(f"ERROR: {error_msg}", file=sys.stderr, flush=True)
                result.status = "error"
                result.error = str(e)
                
                if self.run_logger:
                    self.run_logger.log_instance_summary(
                        instance_id,
                        "error",
                        {"error": str(e), "duration_seconds": result.duration_seconds},
                    )
            finally:
                await runtime.cleanup()

        except Exception as e:
            logger.error("Failed to evaluate {}: {}", instance_id, str(e), exc_info=True)
            result.status = "error"
            result.error = str(e)
            
            if self.run_logger:
                self.run_logger.log_instance_summary(
                    instance_id,
                    "error",
                    {"error": str(e), "duration_seconds": result.duration_seconds},
                )
        finally:
            end_time = asyncio.get_event_loop().time()
            result.duration_seconds = end_time - start_time

        return result