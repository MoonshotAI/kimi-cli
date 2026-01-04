# type: ignore
import asyncio
import base64
import io
import json
import shlex
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Callable

from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.utils.docker import Container


class KimiContainerSolver:
    """Run Kimi CLI inside a container to solve SWE-Bench instances."""
    
    def __init__(
        self,
        container: Container,
        working_dir: str,
        config: EvalConfig,
        problem_statement: str,
        interaction_logger: Callable[[int, str, str], None] | None = None,
    ):
        self.container = container
        self.working_dir = working_dir  # Container's /testbed
        self.config = config
        self.problem_statement = problem_statement
        self.interaction_logger = interaction_logger
        self.round = 0

    async def solve(self) -> dict[str, Any]:
        """Run Kimi CLI in container to solve the problem."""
        logger.info("=" * 60)
        logger.info("Starting KimiContainerSolver in container mode")
        logger.info("=" * 60)
        
        try:
            # Step 1: Copy kimi-cli source to container
            logger.info("Copying kimi-cli source to container...")
            await self._copy_kimi_to_container()
            
            # Step 2: Install dependencies in container
            logger.info("Installing kimi-cli dependencies in container...")
            await self._install_kimi_in_container()
            
            # Step 3: Run kimi-cli in container with the problem statement
            logger.info("Running kimi-cli in container...")
            result = await self._run_kimi_in_container()
            
            logger.info("✓ Kimi solver completed in container")
            
            return {
                "output": result.get("output", ""),
                "tool_calls": result.get("tool_calls", []),
                "rounds": result.get("rounds", 0),
            }
            
        except Exception as e:
            logger.error("Kimi solver failed: {}", str(e), exc_info=True)
            raise

    async def _copy_kimi_to_container(self) -> None:
        """Copy kimi-cli source code to container using docker cp."""
        # Find kimi-cli workspace root
        workspace_root = Path(__file__).parent.parent
        kimi_cli_src = workspace_root / "src" / "kimi_cli"
        pyproject = workspace_root / "pyproject.toml"
        
        logger.info(f"Workspace root: {workspace_root}")
        
        if not kimi_cli_src.exists():
            raise RuntimeError(f"Cannot find kimi-cli source at {kimi_cli_src}")
        
        if not pyproject.exists():
            raise RuntimeError(f"Cannot find pyproject.toml at {pyproject}")
        
        # Create /app directory in container
        await self.container.execute(["mkdir", "-p", "/app"], timeout=30, check=False)
        
        container_name = self.container.container_name
        if not container_name:
            raise RuntimeError("Container not started")
        
        try:
            # Use docker cp to copy src/kimi_cli
            logger.info(f"Copying src/kimi_cli via docker cp...")
            cp_cmd = ["docker", "cp", str(kimi_cli_src), f"{container_name}:/app/src/kimi_cli"]
            result = subprocess.run(cp_cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                raise RuntimeError(f"docker cp failed: {result.stderr}")
            logger.info("✓ src/kimi_cli copied")
            
            # Copy pyproject.toml
            logger.info(f"Copying pyproject.toml via docker cp...")
            cp_cmd = ["docker", "cp", str(pyproject), f"{container_name}:/app/pyproject.toml"]
            result = subprocess.run(cp_cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise RuntimeError(f"docker cp failed: {result.stderr}")
            logger.info("✓ pyproject.toml copied")
            
            # Verify
            verify_result = await self.container.execute(
                ["ls", "-la", "/app/src/kimi_cli/"],
                timeout=30,
                check=False,
            )
            if verify_result.get("exit_code") == 0:
                logger.info("✓ Files verified in container")
            else:
                raise RuntimeError("Verification failed - files not found in container")
                
        except Exception as e:
            logger.error("Failed to copy sources: {}", str(e), exc_info=True)
            raise

    async def _install_kimi_in_container(self) -> None:
        """Install kimi-cli dependencies in container."""
        # Install the package in editable mode
        install_cmd = "cd /app && pip install -e kimi-cli"
        
        result = await self.container.execute(
            ["bash", "-c", install_cmd],
            timeout=300,  # Installation might take longer
            check=False,
        )
        
        if result.get("exit_code", 0) != 0:
            logger.warning(f"Installation warnings: {result.get('stderr', '')}")
        
        logger.info("✓ kimi-cli dependencies installed")

    async def _run_kimi_in_container(self) -> dict[str, Any]:
        """Run kimi-cli command in container."""
        # Build environment variables for kimi
        env_vars = f"KIMI_API_KEY={shlex.quote(self.config.kimi.api_key)}"
        if self.config.kimi.base_url:
            env_vars += f" KIMI_BASE_URL={shlex.quote(self.config.kimi.base_url)}"
        
        # Build the kimi command
        # Using --print mode for non-interactive execution
        kimi_cmd = (
            f"cd /app && "
            f"{env_vars} "
            f"python -m kimi_cli.cli "
            f"--model {shlex.quote(self.config.kimi.model)} "
            f"--command {shlex.quote(self.problem_statement)} "
            f"--print"
        )
        
        logger.info(f"Running kimi in container...")
        logger.debug(f"Command: {kimi_cmd[:150]}...")
        
        result = await self.container.execute(
            ["bash", "-c", kimi_cmd],
            timeout=self.config.timeout_seconds,
            check=False,
        )
        
        exit_code = result.get("exit_code", 0)
        stdout = result.get("stdout", "")
        stderr = result.get("stderr", "")
        
        logger.info(f"Kimi execution completed with exit code: {exit_code}")
        logger.info(f"Output length: {len(stdout)} bytes")
        
        if exit_code != 0:
            logger.warning(f"Kimi exit code: {exit_code}")
            logger.warning(f"Stderr (first 500 chars): {stderr[:500]}")
        
        # Parse git diff to see what changed
        git_diff = await self._get_container_diff()
        
        return {
            "output": stdout,
            "tool_calls": [],  # Kimi in print mode doesn't directly export tool calls
            "rounds": 1,
            "git_diff": git_diff,  # Include diff for evaluation
        }

    async def _get_container_diff(self) -> str:
        """Get git diff from container to see what was changed."""
        try:
            result = await self.container.execute(
                ["bash", "-c", f"cd {self.working_dir} && git diff"],
                timeout=60,
                check=False,
            )
            return result.get("stdout", "")
        except Exception as e:
            logger.warning("Failed to get git diff: {}", str(e))
            return ""
