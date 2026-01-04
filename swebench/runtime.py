"""Container runtime initialization and management for SWE-Bench evaluation."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from kimi_cli.utils.logging import logger

from swebench_kimi_eval.config import EvalConfig, RuntimeConfig
from swebench_kimi_eval.utils.docker import ContainerConfig, ContainerRuntime


class SWEBenchContainerRuntime:
    """Manage container runtime for SWE-Bench evaluation."""

    def __init__(
        self,
        instance: dict[str, Any],
        config: EvalConfig,
        repo_path: Path,
    ):
        self.instance = instance
        self.config = config
        self.repo_path = repo_path
        self.runtime: ContainerRuntime | None = None
        self.work_dir = config.docker.base_image_template.get(
            "work_dir", "/testbed"
        )

    def _get_container_image(self) -> str:
        """Get Docker image name for this instance."""
        repo = self.instance.get("repo", "unknown")
        version = self.instance.get("version", "latest")
        instance_id = self.instance.get("instance_id", "unknown")

        # Parse instance_id to get name part
        parts = instance_id.split("__")
        name = parts[-1] if len(parts) > 1 else instance_id

        # Use template from config
        template = self.config.docker.base_image_template
        image = (
            template.replace("{repo}", repo)
            .replace("{version}", str(version))
            .replace("{name}", name)
        )

        return image.lower()

    async def start(self) -> ContainerRuntime:
        """Start and initialize the container.

        Returns:
            ContainerRuntime instance
        """
        logger.info(f"Starting container for {self.instance['instance_id']}")

        image = self._get_container_image()
        logger.info(f"Using image: {image}")

        # Create container config
        container_config = ContainerConfig(
            image=image,
            name=f"swebench-{self.instance['instance_id'][:32]}",
            work_dir=self.work_dir,
            use_gpu=self.config.docker.use_gpu,
            environment={
                "SWE_INSTANCE_ID": self.instance["instance_id"],
                "PIP_CACHE_DIR": "~/.cache/pip",
            },
        )

        # Start runtime
        self.runtime = ContainerRuntime()
        await self.runtime.start(container_config)

        # Initialize container
        await self._initialize_container()

        return self.runtime

    async def _initialize_container(self) -> None:
        """Initialize container environment."""
        if not self.runtime:
            raise RuntimeError("Container not started")

        logger.info("Initializing container environment")

        # Change to work directory
        await self.runtime.execute(
            ["bash", "-c", f"cd {self.work_dir}"],
            timeout=60,
        )

        # Configure git
        init_script = """
set -e

# Configure git
git config --global core.pager ""
git config --global diff.binary false
git config --global user.email "swebench@example.com"
git config --global user.name "SWEBench Evaluator"

# Add safe directory
git config --global --add safe.directory "*"

# Print environment info
echo "Python: $(python --version)"
echo "Git: $(git --version)"
echo "Working dir: $(pwd)"
"""

        await self.runtime.execute_shell(init_script, timeout=120)

        logger.info("Container initialization complete")

    async def checkout_base_commit(self) -> None:
        """Checkout the base commit for this instance."""
        if not self.runtime:
            raise RuntimeError("Container not started")

        base_commit = self.instance.get("base_commit")
        if not base_commit:
            logger.warning("No base_commit in instance, skipping checkout")
            return

        logger.info(f"Checking out base commit: {base_commit}")

        script = f"""
cd {self.work_dir}
git reset --hard
git checkout {base_commit}
git clean -fd
"""

        await self.runtime.execute_shell(script, timeout=300)

        logger.info(f"Successfully checked out {base_commit}")

    async def get_git_diff(self) -> str:
        """Get git diff from base commit.

        Returns:
            Git patch content
        """
        if not self.runtime:
            raise RuntimeError("Container not started")

        base_commit = self.instance.get("base_commit")
        if not base_commit:
            raise ValueError("No base_commit in instance")

        result = await self.runtime.execute(
            [
                "git",
                "-C",
                self.work_dir,
                "diff",
                "--no-color",
                "--cached",
                base_commit,
            ],
            timeout=300,
            check=False,
        )

        return result["stdout"]

    async def execute_command(
        self,
        command: list[str] | str,
        timeout: int = 300,
        check: bool = False,
    ) -> dict[str, Any]:
        """Execute a command in the container.

        Args:
            command: Command to run
            timeout: Timeout in seconds
            check: Raise error if command fails

        Returns:
            Dict with exit_code, stdout, stderr
        """
        if not self.runtime:
            raise RuntimeError("Container not started")

        return await self.runtime.execute(command, timeout=timeout, check=check)

    async def execute_shell_script(
        self,
        script: str,
        timeout: int = 300,
        check: bool = False,
    ) -> dict[str, Any]:
        """Execute a shell script in the container.

        Args:
            script: Shell script content
            timeout: Timeout in seconds
            check: Raise error if script fails

        Returns:
            Dict with exit_code, stdout, stderr
        """
        if not self.runtime:
            raise RuntimeError("Container not started")

        return await self.runtime.execute_shell(script, timeout=timeout, check=check)

    async def cleanup(self) -> None:
        """Cleanup the container."""
        if self.runtime:
            await self.runtime.cleanup()
            self.runtime = None

    async def __aenter__(self) -> SWEBenchContainerRuntime:
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Async context manager exit."""
        await self.cleanup()


class RuntimeManager:
    """Manage multiple container runtimes."""

    def __init__(self):
        self.runtimes: dict[str, SWEBenchContainerRuntime] = {}

    async def create_runtime(
        self,
        instance: dict[str, Any],
        config: EvalConfig,
    ) -> SWEBenchContainerRuntime:
        """Create a new runtime for an instance.

        Args:
            instance: Instance data
            config: Evaluation config

        Returns:
            SWEBenchContainerRuntime instance
        """
        instance_id = instance["instance_id"]

        # Use temporary directory for repo
        tmpdir = tempfile.mkdtemp(prefix=f"swebench-{instance_id[:16]}-")
        repo_path = Path(tmpdir)

        runtime = SWEBenchContainerRuntime(instance, config, repo_path)
        self.runtimes[instance_id] = runtime

        return runtime

    async def cleanup_all(self) -> None:
        """Cleanup all runtimes."""
        for instance_id, runtime in self.runtimes.items():
            try:
                await runtime.cleanup()
            except Exception as e:
                logger.warning(f"Failed to cleanup runtime for {instance_id}: {e}")
        self.runtimes.clear()

