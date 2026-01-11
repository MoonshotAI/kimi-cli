# type: ignore
import asyncio
import io
import os
import tarfile
from dataclasses import dataclass
from typing import Any

import docker
from docker.types import DeviceRequest

from kimi_cli.utils.logging import logger


@dataclass
class ContainerConfig:
    image: str
    name: str | None = None
    working_dir: str = "/testbed"
    environment: dict[str, str] | None = None
    volumes: dict[str, dict[str, str]] | None = None
    use_gpu: bool = False
    network_mode: str = "host"
    memory: str | None = "16g"
    cpus: int = 8


class Container:
    def __init__(self, config: ContainerConfig):
        self.client = docker.from_env(timeout=3600)
        self.container_name: str | None = None
        self.config: ContainerConfig = config

    async def start(self) -> str:
        """Start a new container with the given configuration."""
        device_requests = None
        if self.config.use_gpu:
            device_requests = [DeviceRequest(capabilities=[["gpu"]], count=-1)]

        try:
            container = self.client.containers.run(
                self.config.image,
                command=["bash", "-c", "tail -f /dev/null"],
                name=self.config.name,
                detach=True,
                environment=self.config.environment,
                volumes=self.config.volumes,
                working_dir=self.config.working_dir,
                network_mode=self.config.network_mode,
                mem_limit=self.config.memory,
                nano_cpus=int(self.config.cpus * 1e9) if self.config.cpus else None,
                device_requests=device_requests,
                remove=False,
            )
            self.container_name = container.name
            logger.info(f"Container started: {container.short_id}")
            await asyncio.sleep(2)
            return self.container_name
        except Exception as e:
            raise RuntimeError(f"Failed to start container: {e}")

    async def execute(
        self, command: list[str] | str, timeout: int = 300, check: bool = True
    ) -> dict[str, Any]:
        """Execute a command in the container."""
        if not self.container_name:
            raise RuntimeError("Container not started")

        if isinstance(command, str):
            command = ["bash", "-c", command]

        try:
            cmd_str = " ".join(str(c) for c in command)
        except Exception:
            cmd_str = str(command)
        logger.debug(f"Executing in container {self.container_name}: {cmd_str}")

        try:
            exit_code, stdout, stderr = await asyncio.wait_for(
                asyncio.to_thread(
                    self._exec_command_sync,
                    command,
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            raise RuntimeError(f"Command execution timeout after {timeout}s")

        return {"exit_code": exit_code, "stdout": stdout, "stderr": stderr}

    def _exec_command_sync(self, command: list[str]) -> tuple[int, str, str]:
        """Synchronous helper for command execution."""
        try:
            container = self.client.containers.get(self.container_name)
            result = container.exec_run(cmd=command, stdout=True, stderr=True)

            stdout = (
                result.output.decode("utf-8", errors="replace")
                if result.output
                else ""
            )
            return result.exit_code, stdout, ""
        except Exception as e:
            logger.error(f"Failed to execute command: {e}")
            raise RuntimeError(f"Failed to execute command: {e}")

    async def execute_shell(
        self, script: str, timeout: int = 300, check: bool = True
    ) -> dict[str, Any]:
        """Execute a shell script in the container."""
        return await self.execute(["bash", "-c", script], timeout=timeout, check=check)

    async def copy_to(self, src: str, dst: str) -> None:
        """Copy a file or directory from host to container."""
        if not self.container_name:
            raise RuntimeError("Container not started")

        logger.info(f"Copying {src} to {self.container_name}:{dst}")

        await asyncio.to_thread(self._copy_to_sync, src, dst)

    def _copy_to_sync(self, src: str, dst: str) -> None:
        """Synchronous helper for copying to container."""
        try:
            container = self.client.containers.get(self.container_name)
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                if os.path.isfile(src):
                    logger.debug(f"Adding file {src}")
                    tar.add(src, arcname=os.path.basename(src))
                elif os.path.isdir(src):
                    logger.debug(f"Adding directory {src} recursively")
                    tar.add(src, arcname=os.path.basename(src.rstrip("/")))
                else:
                    raise RuntimeError(f"Source path does not exist: {src}")

            tar_data = tar_buffer.getvalue()
            logger.info(f"Archive created: {len(tar_data)} bytes")
            tar_buffer.seek(0)

            logger.debug(f"Uploading archive to container...")
            container.put_archive(dst, tar_buffer)
            logger.info(f"✓ Successfully copied {src} to {dst}")
        except Exception as e:
            logger.error(f"Failed to copy to container: {str(e)}", exc_info=True)
            raise RuntimeError(f"Failed to copy to container: {e}")

    async def copy_from(self, src: str, dst: str) -> None:
        """Copy a file or directory from container to host."""
        if not self.container_name:
            raise RuntimeError("Container not started")

        logger.info(f"Copying {self.container_name}:{src} to {dst}")

        await asyncio.to_thread(self._copy_from_sync, src, dst)

    def _copy_from_sync(self, src: str, dst: str) -> None:
        """Synchronous helper for copying from container."""
        try:
            container = self.client.containers.get(self.container_name)
            tar_data, _ = container.get_archive(src)
            with tarfile.open(fileobj=tar_data, mode="r|") as tar:
                tar.extractall(path=dst)
            logger.info(f"Successfully copied {src} to {dst}")
        except Exception as e:
            logger.error(f"Failed to copy from container: {e}")
            raise RuntimeError(f"Failed to copy from container: {e}")

    async def cleanup(self) -> None:
        """Stop and remove the container."""
        if self.container_name:
            await asyncio.to_thread(self._cleanup_sync)
            self.container_name = None

    def _cleanup_sync(self) -> None:
        """Synchronous helper for cleanup."""
        # TODO: stuck in dp
        # try:
        #     container = self.client.containers.get(self.container_name)
        #     container.stop(timeout=1800)
        # except Exception as e:
        #     logger.error(f"Failed to stop container: {e}")

        try:
            container = self.client.containers.get(self.container_name)
            container.remove(force=True)
        except Exception as e:
            logger.error(f"Failed to remove container: {e}")
