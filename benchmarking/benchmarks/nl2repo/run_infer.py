# type: ignore
import asyncio
import sys
import traceback
import os
import shutil
import tempfile
import uuid
import tarfile
import time
import io

from kimi_cli.utils.logging import logger

from benchmarking.utils.config import EvalResult
from benchmarking.utils.docker import Container, ContainerConfig
from benchmarking.kimi_solver import KimiContainerSolver
from benchmarking.utils.evaluator import BaseInstanceEvaluator


class NL2RepoInstanceEvaluator(BaseInstanceEvaluator):
    def __init__(self, instance, config, run_logger=None):
        super().__init__(instance, config, run_logger)
        self.working_dir = "/workspace"
        image = self._get_container_image()
        self.container_config = ContainerConfig(
            image=image,
            name=f"kimicli-nl2repo-{uuid.uuid4().hex}",
            working_dir=self.working_dir,
            use_gpu=self.config.use_gpu,
            environment={},
        )
        self.container = Container(self.container_config)
        # self.instruction = "According to the start.md in the workspace, implement the entire project as per the requirements specified in the document, ensuring that the final product can be directly run in the current directory. The running requirements should comply with the <API Usage Guide> section of the document. Please complete this task step by step."
        
        base_instruction = """Read `start.md` to understand the project requirements, then implement the complete project.
Guidelines:
- Try to decompose the `start.md` as it is very long. Getting critical information at first and referring to it later when needed.
- Plan the architecture before writing code: identify core modules, data models, and interfaces.
- Implement incrementally: start with the foundation, then build features layer by layer."""
        
        if self.config.use_golden_test:
            base_instruction += """
- Golden tests are available in `/tests/` directory. You can examine these tests to understand expected functionality and use them to validate your implementation. Especially the APIs!"""
        else:
            base_instruction += """
- Verify your implementation works before finishing."""
        
        self.instruction = base_instruction
    
    def _get_container_image(self) -> str:
        NL2REPO_BASE_IMAGE = os.environ.get(
            "NL2REPO_BASE_IMAGE", 
            "docker-local-registry.glm.ai/swedev/all-hands-ai/openhands:0.56-nl2repo",
        )
        return NL2REPO_BASE_IMAGE
    
    async def _copy_golden_tests_to_container(self, instance_id: str) -> None:
        tests_base_dir = "/workspace/swe-data/dataset/nl2repo/tests"
        tests_source = os.path.join(tests_base_dir, instance_id)
        
        if not os.path.exists(tests_source):
            logger.warning(f"Golden tests not found for instance {instance_id} at {tests_source}")
            return
        
        if not os.path.isdir(tests_source):
            logger.warning(f"Golden tests path is not a directory: {tests_source}")
            return
        
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_tests_dir = os.path.join(temp_dir, "tests")
            shutil.copytree(tests_source, temp_tests_dir)
            await self.container.copy_to(temp_tests_dir, "/")
        
        logger.info(f"✓ Golden tests copied from {tests_source} to container:/tests")

    async def evaluate(self) -> EvalResult:
        start_time = time.time()
        instance_id = self.instance["instance_id"]
        result = EvalResult(instance_id=instance_id, status="error")
        
        try:
            await self.container.start()
            
            # init working directory
            description = self.instance.get("description", "")
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_file_path = os.path.join(temp_dir, "start.md")
                with open(temp_file_path, "w") as f:
                    f.write(description)
                await self.container.copy_to(temp_file_path, self.working_dir)
            
            logger.info("✓ Task description copied to container")
            
            if self.config.use_golden_test:
                await self._copy_golden_tests_to_container(instance_id)
            
            # Initialize git repo
            git_init_script = f"""
set -e
cd {self.working_dir}
git init
git config user.email "agent@kimi.ai"
git config user.name "Kimi Agent"
git add -A 2>/dev/null || true
git commit --allow-empty -m "Initial commit" 2>/dev/null || true
"""
            
            await self.container.execute_shell(git_init_script, timeout=120)
            logger.info("✓ Git repository initialized")
            
            problem_statement = self.instance.get("description", "")
            logger.info(f"Creating KimiContainerSolver for NL2Repo task: {instance_id}")
            solver = KimiContainerSolver(
                container=self.container,
                working_dir=self.working_dir,
                config=self.config,
                problem_statement=problem_statement,
                instance=self.instance,
                base_env_path="/app",
                base_python_bin_path="/app/.venv/bin",
                instruction=self.instruction
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

            instance_output_dir = os.path.join(self.run_logger.run_dir, "instances", instance_id)
            os.makedirs(instance_output_dir, exist_ok=True)
            
            try:
                tar_stream, _ = self.container.client.containers.get(
                    self.container.container_name
                ).get_archive(self.working_dir)
                tar_bytes = io.BytesIO(b"".join(tar_stream))
                with tempfile.TemporaryDirectory() as extract_dir:
                    with tarfile.open(fileobj=tar_bytes, mode="r") as tar:
                        tar.extractall(path=extract_dir, filter='data')
                    
                    extracted_items = os.listdir(extract_dir)
                    if len(extracted_items) == 1 and extracted_items[0] == "workspace":
                        workspace_src = os.path.join(extract_dir, "workspace")
                        for item in os.listdir(workspace_src):
                            src_item = os.path.join(workspace_src, item)
                            dst_item = os.path.join(instance_output_dir, item)
                            if os.path.exists(dst_item):
                                if os.path.isdir(dst_item):
                                    shutil.rmtree(dst_item)
                                else:
                                    os.remove(dst_item)
                            if os.path.isdir(src_item):
                                shutil.copytree(src_item, dst_item)
                            else:
                                shutil.copy2(src_item, dst_item)
                        logger.info(f"✓ Copied generated workspace content to {instance_output_dir}")
                    else:
                        logger.warning(f"Unexpected tar structure: {extracted_items}")
            except Exception as e:
                logger.warning(f"Failed to copy workspace from container: {e}")

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
