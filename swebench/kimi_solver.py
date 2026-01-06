# type: ignore
import shlex
import subprocess
import tarfile
import io
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
                "trace": result.get("trace", []),  # Include full trace JSON
                "git_diff": result.get("git_diff", ""),
            }
            
        except Exception as e:
            logger.error("Kimi solver failed: {}", str(e), exc_info=True)
            raise

    async def _copy_kimi_to_container(self) -> None:
        """Copy kimi-cli source code to container using tar stream."""
        # Find kimi-cli workspace root
        workspace_root = Path(__file__).parent.parent
        kimi_cli_src = workspace_root / "src" / "kimi_cli"
        pyproject = workspace_root / "pyproject.toml"
        
        logger.info(f"Workspace root: {workspace_root}")
        logger.info(f"kimi_cli_src: {kimi_cli_src}")
        logger.info(f"pyproject: {pyproject}")
        
        if not kimi_cli_src.exists():
            raise RuntimeError(f"Cannot find kimi-cli source at {kimi_cli_src}")
        
        if not pyproject.exists():
            raise RuntimeError(f"Cannot find pyproject.toml at {pyproject}")
        
        container_name = self.container.container_name
        if not container_name:
            raise RuntimeError("Container not started")
        
        try:
            # Create tar stream of kimi-cli source
            # We need to add files from their parent directories to preserve structure
            logger.info(f"Creating tar stream of kimi-cli source...")
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                # Add src/kimi_cli directory - this will create src/kimi_cli in the tar
                tar.add(kimi_cli_src, arcname="src/kimi_cli")
                # Add pyproject.toml at root level
                tar.add(pyproject, arcname="pyproject.toml")
            
            tar_buffer.seek(0)
            tar_data = tar_buffer.read()
            logger.info(f"Tar stream size: {len(tar_data)} bytes")
            
            # Use docker exec to extract tar in container at /openhands
            logger.info(f"Extracting tar to /openhands in container...")
            
            # First verify /openhands exists
            check_result = await self.container.execute(
                ["test", "-d", "/openhands"],
                timeout=10,
                check=False,
            )
            if check_result.get("exit_code") != 0:
                raise RuntimeError("/openhands directory does not exist in container")
            
            # Pipe tar data through docker exec
            tar_cmd = ["docker", "exec", "-i", container_name, "tar", "-xvf", "-", "-C", "/openhands"]
            result = subprocess.run(
                tar_cmd,
                input=tar_data,
                capture_output=True,
                timeout=120,
            )
            
            if result.returncode != 0:
                logger.error(f"tar stderr: {result.stderr.decode()}")
                logger.error(f"tar stdout: {result.stdout.decode()}")
                raise RuntimeError(f"tar extract failed: {result.stderr.decode()}")
            
            logger.info(f"tar stdout: {result.stdout.decode()}")
            logger.info("✓ kimi-cli source extracted to /openhands")
            
            # Verify - list what was extracted
            list_result = await self.container.execute(
                ["ls", "-la", "/openhands/"],
                timeout=30,
                check=False,
            )
            logger.info(f"Contents of /openhands: {list_result.get('stdout', '')}")
            
            verify_result = await self.container.execute(
                ["ls", "-la", "/openhands/src/kimi_cli/"],
                timeout=30,
                check=False,
            )
            if verify_result.get("exit_code") == 0:
                logger.info(f"✓ Files verified in /openhands: {verify_result.get('stdout', '')}")
            else:
                logger.error(f"Verification failed: {verify_result.get('stderr', '')}")
                raise RuntimeError("Verification failed - files not found in /openhands")
                
        except Exception as e:
            logger.error("Failed to copy sources: {}", str(e), exc_info=True)
            raise

    async def _install_kimi_in_container(self) -> None:
        """Install kimi-cli dependencies in container using poetry environment."""
        install_cmd = "cd /openhands && /openhands/poetry/openhands-ai-5O4_aCHf-py3.12/bin/pip install -e ."
        
        result = await self.container.execute(
            ["bash", "-c", install_cmd],
            timeout=300,  # Installation might take longer
            check=False,
        )
        
        if result.get("exit_code", 0) != 0:
            logger.warning(f"Installation warnings: {result.get('stderr', '')}")
        
        logger.info("✓ kimi-cli dependencies installed in poetry environment")

    async def _run_kimi_in_container(self) -> dict[str, Any]:
        """Run kimi-cli command in container and extract trace."""
        env_vars = f"KIMI_API_KEY={shlex.quote(self.config.kimi.api_key)}"
        env_vars += f" KIMI_BASE_URL={shlex.quote(self.config.kimi.base_url)}"
        env_vars += f" KIMI_MODEL_NAME={shlex.quote(self.config.kimi.model)}"
        
        kimi_cmd = (
            f"cd /openhands && "
            f"{env_vars} "
            f"/openhands/poetry/openhands-ai-5O4_aCHf-py3.12/bin/python -m kimi_cli.cli "
            f"--command 'say hi and exit'"
            f"--print"
        )
            # f"--command {shlex.quote(self.problem_statement)} "
        
        logger.info(f"Running kimi in container...")
        logger.debug(f"Command: {kimi_cmd}")

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
            if stderr:
                logger.warning(f"Stderr: {stderr}")
            # Even if exit code is non-zero, kimi may have produced useful output
            logger.info(f"Stdout: {stdout}")
        
        # Extract trace JSON from container
        trace_json = await self._extract_trace()
        
        # Parse git diff to see what changed
        git_diff = await self._get_container_diff()
        
        # Extract conversation history from output if wire.jsonl is not available
        # This is a fallback when wire.jsonl is empty or not generated
        conversation_history = []
        if not trace_json and stdout:
            logger.info("No wire.jsonl found, using stdout as fallback")
            # TODO: parse conversation from stdout if needed
        
        return {
            "output": stdout,
            "tool_calls": [],  # Kimi in print mode doesn't directly export tool calls
            "rounds": 1,
            "git_diff": git_diff,  # Include diff for evaluation
            "trace": trace_json,  # Include full trace JSON
            "conversation": conversation_history,
        }

    async def _extract_trace(self) -> list[dict[str, Any]]:
        """Extract kimi-cli trace (wire.jsonl) from container."""
        try:
            import json
            
            find_wire_cmd = "find ~/.kimi/sessions -name 'wire.jsonl' -type f 2>/dev/null | sort -r | head -1"
            find_result = await self.container.execute(
                ["bash", "-c", find_wire_cmd],
                timeout=10,
                check=False,
            )
            
            wire_file = find_result.get("stdout", "").strip()
            if not wire_file:
                logger.warning("No wire.jsonl found in ~/.kimi/sessions/")
                
                # List what exists
                list_cmd = "find ~/.kimi -type d -name sessions 2>/dev/null"
                list_result = await self.container.execute(
                    ["bash", "-c", list_cmd],
                    timeout=10,
                    check=False,
                )
                logger.debug(f"Sessions dirs found: {list_result.get('stdout', '')}")
                
                # Try to list full structure
                tree_cmd = "find ~/.kimi/sessions -type f 2>/dev/null | head -20"
                tree_result = await self.container.execute(
                    ["bash", "-c", tree_cmd],
                    timeout=10,
                    check=False,
                )
                logger.debug(f"Full structure: {tree_result.get('stdout', '')}")
                
                return []
            
            logger.info(f"Found wire file: {wire_file}")
            
            # Check file size and contents
            size_cmd = f"wc -l {wire_file}"
            size_result = await self.container.execute(
                ["bash", "-c", size_cmd],
                timeout=10,
                check=False,
            )
            logger.info(f"Wire file size: {size_result.get('stdout', '')}")
            
            # Read wire.jsonl file
            read_cmd = f"cat {wire_file}"
            wire_result = await self.container.execute(
                ["bash", "-c", read_cmd],
                timeout=30,
                check=False,
            )
            
            if wire_result.get("exit_code") != 0:
                logger.warning(f"Could not read wire.jsonl: {wire_result.get('stderr', '')}")
                return []
            
            wire_content = wire_result.get("stdout", "").strip()
            if not wire_content:
                logger.warning("wire.jsonl is empty")
                return []
            
            # Parse JSONL file
            trace_lines = wire_content.split("\n")
            trace_json = []
            
            for line in trace_lines:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                    trace_json.append(record)
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse trace line: {e}")
                    continue
            
            logger.info(f"✓ Extracted {len(trace_json)} trace records from {wire_file}")
            return trace_json
            
        except Exception as e:
            logger.warning(f"Failed to extract trace: {e}", exc_info=True)
            return []

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
