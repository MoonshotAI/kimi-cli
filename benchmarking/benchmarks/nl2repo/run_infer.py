# type: ignore
import asyncio
import sys
import traceback
import os
import shutil
import tempfile
import uuid
import tarfile

from kimi_cli.utils.logging import logger

from benchmarking.utils.config import EvalResult
from benchmarking.utils.docker import Container, ContainerConfig
from benchmarking.kimi_solver import KimiContainerSolver
from benchmarking.utils.evaluator import BaseInstanceEvaluator


class NL2RepoInstanceEvaluator(BaseInstanceEvaluator):
    """Evaluator for NL2Repo instances - code generation/implementation task."""
    
    def __init__(self, instance, config, run_logger=None):
        super().__init__(instance, config, run_logger)
        self.working_dir = "/workspace"

    async def evaluate(self) -> EvalResult:
        start_time = asyncio.get_event_loop().time()
        instance_id = self.instance["instance_id"]
        result = EvalResult(
            instance_id=instance_id,
            status="error",
        )
        
        runtime = None
        try:
            # Initialize and start container
            # Use python:3.10 or custom NL2Repo image if provided
            image = os.environ.get('NL2REPO_BASE_IMAGE', 'python:3.10')
            
            container_config = ContainerConfig(
                image=image,
                name=f"nl2repo-{uuid.uuid4().hex[:32]}",
                working_dir=self.working_dir,
                use_gpu=self.config.use_gpu,
                environment={},
            )
            
            runtime = Container()
            await runtime.start(container_config)
            
            # Initialize container environment
            logger.info("Initializing container environment for NL2Repo")
            await runtime.execute(
                ["bash", "-c", f"cd {self.working_dir}"],
                timeout=120,
            )
            
            try:
                # NL2Repo specific: create start.md in container
                description = self.instance.get("description", "")
                with tempfile.TemporaryDirectory() as temp_dir:
                    temp_file_path = os.path.join(temp_dir, "start.md")
                    with open(temp_file_path, "w") as f:
                        f.write(description)
                    await runtime.copy_to(temp_file_path, self.working_dir)
                
                logger.info("✓ Task description copied to container")
                
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
                
                await runtime.execute_shell(git_init_script, timeout=120)
                logger.info("✓ Git repository initialized")
                
                problem_statement = self.instance.get("description", "")
                logger.info(f"Creating KimiContainerSolver for NL2Repo task: {instance_id}")
                solver = KimiContainerSolver(
                    container=runtime,
                    working_dir=self.working_dir,
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
                result.status = "success"

                # NL2Repo specific: copy generated workspace back to host
                instance_output_dir = os.path.join(self.config.output_dir, "instances", instance_id)
                os.makedirs(instance_output_dir, exist_ok=True)
                workspace_target = os.path.join(instance_output_dir, "workspace")
                
                try:
                    # Get tar archive from container
                    tar_data, _ = runtime.client.containers.get(
                        runtime.container_name
                    ).get_archive(self.working_dir)
                    
                    # Extract to temporary directory first
                    with tempfile.TemporaryDirectory() as extract_dir:
                        with tarfile.open(fileobj=tar_data, mode="r|") as tar:
                            tar.extractall(path=extract_dir)
                        
                        # Find the actual workspace content
                        extracted_items = os.listdir(extract_dir)
                        if len(extracted_items) == 1 and os.path.isdir(os.path.join(extract_dir, extracted_items[0])):
                            src = os.path.join(extract_dir, extracted_items[0])
                        else:
                            src = extract_dir
                        
                        if os.path.exists(workspace_target):
                            shutil.rmtree(workspace_target)
                        shutil.copytree(src, workspace_target)
                        logger.info(f"✓ Copied generated workspace to {workspace_target}")
                except Exception as e:
                    logger.warning(f"Failed to copy workspace from container: {e}")

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
            if runtime:
                await runtime.cleanup()
            end_time = asyncio.get_event_loop().time()
            result.duration_seconds = end_time - start_time

        return result
