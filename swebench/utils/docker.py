# type: ignore[import-untyped, no-untyped-def, assignment]
import asyncio
import io
import tarfile
from dataclasses import dataclass
from pathlib import Path
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
    network_mode: str = "bridge"
    memory: str | None = "16g"
    cpus: str | None = "8"

        
class DockerManager:
    def __init__(self):
        self.client = docker.from_env(timeout=3600)
        self.containers: dict[str, docker.models.containers.Container] = {}
        

    def create_container(
        self,
        config: ContainerConfig,
        command: list[str] | None = None,
    ) -> str:
        if command is None:
            command = ["bash", "-c", "sleep infinity"]

        device_requests = None
        if config.use_gpu:
            device_requests = [DeviceRequest(capabilities=[["gpu"]], count=-1)]

        try:
            container = self.client.containers.run(
                config.image,
                command=command,
                name=config.name,
                detach=True,
                environment=config.environment,
                volumes=config.volumes,
                working_dir=config.working_dir,
                network_mode=config.network_mode,
                mem_limit=config.memory,
                nano_cpus=int(config.cpus) * 1e9,
                device_requests=device_requests,
                remove=False,
            )
            self.containers[config.name] = container
            logger.info(f"Container created: {container.short_id}")
            return container.name
        except Exception as e:
            logger.error(f"Failed to create container: {e}")
            raise RuntimeError(f"Failed to create container: {e}")


    def exec_command(
        self,
        container_name: str,
        command: list[str] | str,
        timeout: int = 300,
    ) -> tuple[int, str, str]:
        if isinstance(command, str):
            command = ["bash", "-c", command]

        logger.debug(f"Executing in container {container_name}: {' '.join(command)}")

        try:
            container = self.client.containers.get(container_name)
            result = container.exec_run(
                cmd=command,
                stdout=True,
                stderr=True,
                timeout=timeout,
            )

            stdout = result.output.decode("utf-8", errors="replace") if result.output else ""
            return result.exit_code, stdout, ""
        except docker.errors.NotFound:
            logger.error(f"Container not found: {container_name}")
            raise RuntimeError(f"Container not found: {container_name}")
        except docker.errors.DockerException as e:
            logger.error(f"Failed to execute command: {e}")
            raise RuntimeError(f"Failed to execute command: {e}")


    def copy_to_container(
        self,
        container_name: str,
        src: Path | str,
        dst: str,
    ) -> None:
        src = Path(src)
        if not src.exists():
            raise FileNotFoundError(f"Source not found: {src}")

        logger.info(f"Copying {src} to {container_name}:{dst}")

        try:
            container = self.client.containers.get(container_name)
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                if src.is_file():
                    arcname = src.name
                    tar.add(src, arcname=arcname)
                else:
                    for item in src.rglob("*"):
                        if item.is_file():
                            arcname = item.relative_to(src.parent)
                            tar.add(item, arcname=arcname)

            tar_buffer.seek(0)
            container.put_archive(dst, tar_buffer)
            logger.info(f"Successfully copied {src} to {dst}")
        except docker.errors.NotFound:
            logger.error(f"Container not found: {container_name}")
            raise RuntimeError(f"Container not found: {container_name}")
        except Exception as e:
            logger.error(f"Failed to copy to container: {e}")
            raise RuntimeError(f"Failed to copy to container: {e}")


    def copy_from_container(
        self,
        container_name: str,
        src: str,
        dst: Path | str,
    ) -> None:
        dst = Path(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)

        logger.info(f"Copying {container_name}:{src} to {dst}")

        try:
            container = self.client.containers.get(container_name)
            tar_data, _ = container.get_archive(src)
            with tarfile.open(fileobj=tar_data, mode="r|") as tar:
                tar.extractall(path=dst)
            logger.info(f"Successfully copied {src} to {dst}")
        except docker.errors.NotFound:
            logger.error(f"Container not found: {container_name}")
            raise RuntimeError(f"Container not found: {container_name}")
        except Exception as e:
            logger.error(f"Failed to copy from container: {e}")
            raise RuntimeError(f"Failed to copy from container: {e}")


    def stop_container(self, container_name: str, timeout: int = 30) -> None:
        logger.info(f"Stopping container: {container_name}")

        try:
            container = self.client.containers.get(container_name)
            container.stop(timeout=timeout)
        except docker.errors.NotFound:
            logger.warning(f"Container not found: {container_name}")
        except docker.errors.DockerException as e:
            logger.error(f"Failed to stop container: {e}")
            raise RuntimeError(f"Failed to stop container: {e}")


    def remove_container(self, container_name: str, force: bool = True) -> None:
        logger.info(f"Removing container: {container_name}")

        try:
            container = self.client.containers.get(container_name)
            container.remove(force=force)
        except docker.errors.NotFound:
            logger.warning(f"Container not found: {container_name}")
        except docker.errors.DockerException as e:
            logger.error(f"Failed to remove container: {e}")
            raise RuntimeError(f"Failed to remove container: {e}")


    def get_container_logs(self, container_name: str) -> str:
        try:
            container = self.client.containers.get(container_name)
            logs = container.logs()
            return logs.decode("utf-8", errors="replace") if isinstance(logs, bytes) else str(logs)
        except docker.errors.NotFound:
            logger.error(f"Container not found: {container_name}")
            return ""
        except Exception as e:
            logger.error(f"Failed to get container logs: {e}")
            return ""


    def cleanup_all(self) -> None:
        logger.info(f"Cleaning up {len(self.containers)} containers")
        for name, container in self.containers.items():
            try:
                self.stop_container(container.id)
                self.remove_container(container.id)
            except Exception as e:
                logger.warning(f"Failed to cleanup {name}: {e}")
        self.containers.clear()


class ContainerRuntime:
    def __init__(self, manager: DockerManager | None = None):
        self.manager = manager or DockerManager()
        self.container_name: str | None = None
        self.config: ContainerConfig | None = None

    async def start(self, config: ContainerConfig) -> str:
        self.config = config
        self.container_name = self.manager.create_container(
            config,
            command=["bash", "-c", "sleep infinity"],
        )
        await asyncio.sleep(2)
        return self.container_name

    async def execute(
        self,
        command: list[str] | str,
        timeout: int = 300,
        check: bool = True,
    ) -> dict[str, Any]:
        if not self.container_name:
            raise RuntimeError("Container not started")

        exit_code, stdout, stderr = self.manager.exec_command(
            self.container_name,
            command,
            timeout=timeout,
        )

        if check and exit_code != 0:
            logger.error(f"Command failed with exit code {exit_code}")
            logger.error(f"stderr: {stderr}")
            raise RuntimeError(f"Command failed: {stderr}")

        return {
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
        }

    async def execute_shell(
        self,
        script: str,
        timeout: int = 300,
        check: bool = True,
    ) -> dict[str, Any]:
        return await self.execute(
            ["bash", "-c", script],
            timeout=timeout,
            check=check,
        )

    async def copy_to(self, src: Path | str, dst: str) -> None:
        if not self.container_name:
            raise RuntimeError("Container not started")
        self.manager.copy_to_container(self.container_name, src, dst)

    async def copy_from(self, src: str, dst: Path | str) -> None:
        if not self.container_name:
            raise RuntimeError("Container not started")
        self.manager.copy_from_container(self.container_name, src, dst)

    async def cleanup(self) -> None:
        if self.container_name:
            self.manager.stop_container(self.container_name)
            self.manager.remove_container(self.container_name)
            self.container_name = None