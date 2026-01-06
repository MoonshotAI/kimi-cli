# type: ignore
import shlex
import subprocess
import tarfile
import io
from pathlib import Path
import json

from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.utils.docker import Container

class KimiContainerSolver:
    def __init__(
        self,
        container: Container,
        working_dir: str,
        config: EvalConfig,
        problem_statement: str,
    ):
        self.container = container
        self.working_dir = working_dir
        self.config = config
        self.problem_statement = problem_statement
        self.round = 0

    async def solve(self):
        """Run Kimi CLI in container to solve the problem."""
        try:
            logger.info("Copying kimi-cli source to container...")
            await self._copy_kimi_to_container()
            logger.info("Installing kimi-cli dependencies in container...")
            await self._install_kimi_in_container()
            logger.info("Running kimi-cli in container...")
            result = await self._run_kimi_in_container()
            return {
                "output": result.get("output", ""),
                "trace": result.get("trace", []),
                "git_diff": result.get("git_diff", ""),
            }
        except Exception as e:
            logger.error("Kimi solver failed: {}", str(e), exc_info=True)
            raise

    async def _copy_kimi_to_container(self) -> None:
        workspace_root = Path(__file__).parent.parent
        kimi_cli_src = workspace_root / "src" / "kimi_cli"
        pyproject = workspace_root / "pyproject.toml"
        container_name = self.container.container_name
        try:
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                tar.add(kimi_cli_src, arcname="src/kimi_cli")
                tar.add(pyproject, arcname="pyproject.toml")
            tar_buffer.seek(0)
            tar_data = tar_buffer.read()
            tar_cmd = ["docker", "exec", "-i", container_name, "tar", "-xvf", "-", "-C", "/openhands"]
            result = subprocess.run(
                tar_cmd,
                input=tar_data,
                capture_output=True,
                timeout=600,
            )

            if result.returncode != 0:
                logger.error(f"tar stderr: {result.stderr.decode()}")
                logger.error(f"tar stdout: {result.stdout.decode()}")
                raise RuntimeError(f"tar extract failed: {result.stderr.decode()}")
        except Exception as e:
            logger.error("Failed to copy sources: {}", str(e), exc_info=True)
            raise

    async def _install_kimi_in_container(self) -> None:
        install_cmd = "cd /openhands && /openhands/poetry/openhands-ai-5O4_aCHf-py3.12/bin/pip install -e ."
        result = await self.container.execute(
            ["bash", "-c", install_cmd],
            timeout=600,
            check=False,
        )
        if result.get("exit_code", 0) != 0:
            logger.warning(f"Installation warnings: {result.get('stderr', '')}")
        logger.info("✓ kimi-cli dependencies installed in poetry environment")

    async def _run_kimi_in_container(self):
        env_vars = f"KIMI_API_KEY={shlex.quote(self.config.kimi.api_key)}"
        env_vars += f" KIMI_BASE_URL={shlex.quote(self.config.kimi.base_url)}"
        env_vars += f" KIMI_MODEL_NAME={shlex.quote(self.config.kimi.model)}"
        kimi_cmd = (
            f"cd /openhands && "
            f"{env_vars} "
            f"/openhands/poetry/openhands-ai-5O4_aCHf-py3.12/bin/python -m kimi_cli.cli "
            f"--command {shlex.quote(self.problem_statement)} "
            f"--print"
        )

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
        
        if exit_code != 0:
            logger.warning(f"Kimi exit code: {exit_code}")
            if stderr:
                logger.warning(f"Stderr: {stderr}")
            logger.info(f"Stdout: {stdout}")
        
        trace_json = await self._extract_trace()
        git_diff = await self._get_container_diff()
        return {
            "output": stdout,
            "git_diff": git_diff,
            "trace": trace_json,
        }

    async def _extract_trace(self):
        try:
            find_wire_cmd = "find ~/.kimi/sessions -name 'wire.jsonl' -type f 2>/dev/null | sort -r | head -1"
            find_result = await self.container.execute(
                ["bash", "-c", find_wire_cmd],
                timeout=120,
                check=False,
            )
            wire_file = find_result.get("stdout", "").strip()
            logger.info(f"Found wire file: {wire_file}")
            read_cmd = f"cat {wire_file}"
            wire_result = await self.container.execute(
                ["bash", "-c", read_cmd],
                timeout=120,
                check=False,
            )
            wire_content = wire_result.get("stdout", "").strip()
            trace_lines = wire_content.split("\n")
            trace_json = []
            for line in trace_lines:
                if not line.strip():
                    continue
                record = json.loads(line)
                trace_json.append(record)            
            logger.info(f"✓ Extracted {len(trace_json)} trace records from {wire_file}")
            return trace_json
        except Exception as e:
            logger.warning(f"Failed to extract trace: {e}", exc_info=True)
            return []

    async def _get_container_diff(self) -> str:
        try:
            result = await self.container.execute(
                ["bash", "-c", f"cd {self.working_dir} && git diff"],
                timeout=120,
                check=False,
            )
            return result.get("stdout", "")
        except Exception as e:
            logger.warning("Failed to get git diff: {}", str(e))
            return ""
