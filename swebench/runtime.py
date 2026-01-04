# type: ignore
from pathlib import Path
from typing import Any
import uuid
import os

from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.utils.docker import ContainerConfig, Container

USE_VERIFIED = os.environ.get('USE_VERIFIED', 'false').lower() == 'true'
USE_LIVE = os.environ.get('USE_LIVE', 'false').lower() == 'true'
USE_MULTILINGUAL = os.environ.get('USE_MULTILINGUAL', 'false').lower() == 'true'

class SWEBenchContainerRuntime:
    def __init__(
        self,
        instance: dict[str, Any],
        config: EvalConfig,
        working_dir: Path,
    ):
        self.instance = instance
        self.config = config
        self.working_dir = working_dir
        self.runtime: Container | None = None


    def _get_container_image(self) -> str:
        instance_id = self.instance["instance_id"]
        repo, name = instance_id.split('__')
        if USE_VERIFIED:
            image_name = f'sweb.eval.x86_64.{repo}_1776_{name}:latest'.lower()
        elif USE_MULTILINGUAL:
            image_name = f'swebench/sweb.eval.x86_64.{repo}_1776_{name}:latest'.lower()
        elif USE_LIVE:
            image_name = f'docker-local-registry.glm.ai/swedev/sweb.eval.x86_64.{repo}_1776_{name}:latest'.lower()
        else:
            image_name = f'sweb.eval.x86_64.{repo}__{name}:latest'.lower()
        return image_name


    async def start(self) -> Container:
        logger.info(f"Starting container for {self.instance['instance_id']}")
        image = self._get_container_image()
        container_config = ContainerConfig(
            image=image,
            name=f"kimicli-{uuid.uuid4().hex[:32]}",
            working_dir=self.working_dir,
            use_gpu=self.config.use_gpu,
            environment={
                "SWE_INSTANCE_ID": self.instance["instance_id"],
                "PIP_CACHE_DIR": "~/.cache/pip",
            },
        )

        self.runtime = Container(None, "")
        await self.runtime.start(container_config)
        await self._initialize_container()
        return self.runtime


    async def _initialize_container(self) -> None:
        if not self.runtime:
            raise RuntimeError("Container not started")

        logger.info("Initializing container environment")
        await self.runtime.execute(
            ["bash", "-c", f"cd {self.working_dir}"],
            timeout=60,
        )

        init_script = """
set -e

git config --global core.pager ""
git config --global diff.binary false
git config --global user.email "zai@glm.ai"
git config --global user.name "Zai"

git config --global --add safe.directory "*"
"""

        await self.runtime.execute_shell(init_script, timeout=120)

        logger.info("Container initialization complete")


    async def checkout_base_commit(self) -> None:
        if not self.runtime:
            raise RuntimeError("Container not started")

        base_commit = self.instance.get("base_commit")
        if not base_commit:
            logger.warning("No base_commit in instance, skipping checkout")
            return

        logger.info(f"Checking out base commit: {base_commit}")

        script = f"""
cd {self.working_dir}
git reset --hard
git checkout {base_commit}
git clean -fd
"""

        await self.runtime.execute_shell(script, timeout=300)

        logger.info(f"Successfully checked out {base_commit}")


    async def get_git_diff(self) -> str:
        base_commit = self.instance["base_commit"]
        result = await self.runtime.execute(
            [
                "git",
                "-C",
                self.working_dir,
                "diff",
                "--no-color",
                "--cached",
                base_commit,
            ],
            timeout=300,
            check=False,
        )
        return result["stdout"]


    async def cleanup(self) -> None:
        if self.runtime:
            await self.runtime.cleanup()
            self.runtime = None