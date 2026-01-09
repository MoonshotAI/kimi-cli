# type: ignore
import asyncio
import sys
import traceback
import time
import uuid

from kimi_cli.utils.logging import logger

from benchmarking.utils.config import EvalResult
from benchmarking.utils.docker import Container, ContainerConfig
from benchmarking.kimi_solver import KimiContainerSolver
from benchmarking.utils.utils import filter_binary_diffs
from benchmarking.utils.evaluator import BaseInstanceEvaluator


class SWEBenchInstanceEvaluator(BaseInstanceEvaluator):
    def __init__(self, instance, config, run_logger=None):
        super().__init__(instance, config, run_logger)
        self.working_dir = "/testbed"
        image = self._get_container_image()
        self.container_config = ContainerConfig(
            image=image,
            name=f"kimicli-swebench-{uuid.uuid4().hex}",
            working_dir=self.working_dir,
            use_gpu=self.config.use_gpu,
            environment={},
        )
        self.container = Container(self.container_config)

    def _get_container_image(self) -> str:
        instance_id = self.instance["instance_id"]
        repo, name = instance_id.split('__')
        image_name = f'docker-local-registry.glm.ai/swedev/sweb.eval.x86_64.{repo}_1776_{name}:latest'.lower()
        image_name = image_name.replace(":latest", "-oh_0.34.0:latest").lower()
        return image_name

    async def evaluate(self) -> EvalResult:
        start_time = time.time()
        instance_id = self.instance["instance_id"]
        result = EvalResult(instance_id=instance_id, status="error")
        try:
            await self.container.start()

            # init git for workspace
            init_script = """
set -e

git config --global core.pager ""
git config --global diff.binary false
git config --global user.email "zai@glm.ai"
git config --global user.name "Zai"

git config --global --add safe.directory "*"
"""
            await self.container.execute_shell(init_script, timeout=120)

            base_commit = self.instance["base_commit"]
            script = f"""
git reset --hard
git branch | grep -v "^\\*" | xargs -r git branch -D
git tag -l | xargs -r git tag -d
git reflog expire --expire=now --all
git prune --expire=now
"""
            await self.container.execute_shell(script, timeout=300)

            # run KimiContainerSolver
            problem_statement = self.instance["problem_statement"]
            logger.info(f"Running KimiContainerSolver for SWE-Bench task: {instance_id}")
            sys.stderr.flush()
            solver = KimiContainerSolver(
                container=self.container,
                working_dir=self.working_dir,
                config=self.config,
                problem_statement=problem_statement,
                instance=self.instance,
            )
            try:
                solve_result = await asyncio.wait_for(
                    solver.solve(),
                    timeout=self.config.timeout_seconds
                )
            except asyncio.TimeoutError:
                logger.error("Solver timed out after {} seconds", self.config.timeout_seconds)
                raise

            # extract results
            result.messages = solve_result.get("messages", [])
            result.sub_messages = solve_result.get("sub_messages", [])

            git_result = await self.container.execute_shell(
                f"git diff --no-color --cached {base_commit}",
                timeout=300,
                check=False,
            )
            git_patch = git_result["stdout"]
            result.git_patch = filter_binary_diffs(git_patch)
            result.status = "success"

            if self.run_logger:
                self.run_logger.log_instance_summary(
                    instance_id,
                    "success",
                    {"duration_seconds": result.duration_seconds},
                )

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
            if self.container:
                await self.container.cleanup()
            result.duration_seconds = time.time() - start_time

        return result
