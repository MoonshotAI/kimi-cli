# type: ignore
import asyncio
import sys
import traceback

from kimi_cli.utils.logging import logger

from benchmarking.utils.config import EvalResult
from benchmarking.kimi_solver import KimiContainerSolver
from benchmarking.runtime import ContainerRuntime
from benchmarking.utils.utils import filter_binary_diffs


class InstanceEvaluator:
    def __init__(self, instance, config, run_logger = None):
        self.instance = instance
        self.config = config
        self.run_logger = run_logger

    async def evaluate(self) -> EvalResult:
        start_time = asyncio.get_event_loop().time()
        instance_id = self.instance["instance_id"]
        result = EvalResult(instance_id=instance_id, status="error")
        try:
            runtime = ContainerRuntime(self.instance.to_dict(), self.config, "/testbed")
            await runtime.start()
            try:
                await runtime.checkout_base_commit()
                problem_statement = self.instance["problem_statement"]
                logger.info(f"Creating KimiContainerSolver with container: {runtime.runtime.container_name}")
                solver = KimiContainerSolver(
                    container=runtime.runtime,
                    working_dir=runtime.working_dir,
                    config=self.config,
                    problem_statement=problem_statement,
                    instance=self.instance,
                )
                sys.stderr.flush()
                
                try:
                    solve_result = await asyncio.wait_for(
                        solver.solve(),
                        timeout=self.config.timeout_seconds
                    )
                except asyncio.TimeoutError:
                    logger.error("Solver timed out after {} seconds", self.config.timeout_seconds)
                    raise

                result.messages = solve_result.get("messages", [])
                result.sub_messages = solve_result.get("sub_messages", [])
                git_patch = await runtime.get_git_diff()
                result.git_patch = filter_binary_diffs(git_patch)
                result.status = "success"

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