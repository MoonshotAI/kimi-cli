from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.kimi_cli import KimiCli
from harbor.environments.base import BaseEnvironment


class LocalKimiCli(KimiCli):
    """Harbor Kimi agent that installs kimi-cli from a git ref."""

    @staticmethod
    def name() -> str:
        return "kimi-cli-local"

    async def install(self, environment: BaseEnvironment) -> None:
        wheel_path = os.environ.get("KIMI_CLI_WHEEL_PATH")
        if wheel_path:
            wheel_file = Path(wheel_path)
            if not wheel_file.is_file():
                raise ValueError(f"KIMI_CLI_WHEEL_PATH does not exist: {wheel_path}")
            await self.exec_as_root(
                environment,
                command="apt-get update && apt-get install -y curl",
                env={"DEBIAN_FRONTEND": "noninteractive"},
            )
            wheel_target = f"/tmp/{wheel_file.name}"
            await environment.upload_file(wheel_file, wheel_target)
            install_cmd = (
                "set -euo pipefail; "
                "curl -LsSf https://astral.sh/uv/install.sh | bash && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                f"uv tool install --python 3.13 {shlex.quote(wheel_target)} && "
                "kimi --version"
            )
            await self.exec_as_agent(environment, command=install_cmd)
            return

        repo_url = os.environ.get("KIMI_CLI_GIT_URL")
        git_ref = os.environ.get("KIMI_CLI_GIT_REF")
        if not repo_url or not git_ref:
            raise ValueError(
                "Provide KIMI_CLI_WHEEL_PATH, or KIMI_CLI_GIT_URL and KIMI_CLI_GIT_REF."
            )

        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y git curl",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        repo_quoted = shlex.quote(repo_url)
        ref_quoted = shlex.quote(git_ref)
        install_cmd = (
            "set -euo pipefail; "
            "curl -LsSf https://astral.sh/uv/install.sh | bash && "
            'export PATH="$HOME/.local/bin:$PATH" && '
            "rm -rf /tmp/kimi-cli-src && "
            f"git clone --depth 1 {repo_quoted} /tmp/kimi-cli-src && "
            f"git -C /tmp/kimi-cli-src fetch --depth 1 origin {ref_quoted} && "
            "git -C /tmp/kimi-cli-src checkout FETCH_HEAD && "
            "uv tool install --python 3.13 /tmp/kimi-cli-src && "
            "kimi --version"
        )
        await self.exec_as_agent(environment, command=install_cmd)
