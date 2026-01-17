import asyncio
import os
from pathlib import Path
from typing import override

from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolOk, Toolset
from kosong.tooling.simple import SimpleToolset
from pydantic import BaseModel, Field, SecretStr

from gitrekt_cli.config import LLMModel, LLMProvider, get_default_config
from gitrekt_cli.llm import LLM, create_llm
from gitrekt_cli.session import Session
from gitrekt_cli.soul.agent import Agent, Runtime
from gitrekt_cli.soul.context import Context
from gitrekt_cli.soul.gitrechtsoul import GitrektSoul
from gitrekt_cli.ui.shell import Shell
from gitrekt_cli.wire.types import ContentPart, ToolReturnValue


class HaGitrektSoul(GitrektSoul):
    @staticmethod
    async def create(
        llm: LLM | None,
        system_prompt: str,
        toolset: Toolset,
        session: Session | None = None,
        work_dir: Path | None = None,
    ) -> "HaGitrektSoul":
        config = get_default_config()
        kaos_work_dir = KaosPath.unsafe_from_local_path(work_dir) if work_dir else KaosPath.cwd()
        session = session or await Session.create(kaos_work_dir)
        runtime = await Runtime.create(
            config=config,
            llm=llm,
            session=session,
            yolo=True,
        )
        agent = Agent(
            name="HaGitrektAgent",
            system_prompt=system_prompt,
            toolset=toolset,
            runtime=runtime,
        )
        context = Context(session.context_file)
        return HaGitrektSoul(agent, context=context)

    @property
    @override
    def name(self) -> str:
        return "HaGitrekt"

    @override
    async def run(self, user_input: str | list[ContentPart]) -> None:
        if not self._context.history:
            await self._context.restore()
        await super().run(user_input)


class MyBashParams(BaseModel):
    command: str = Field(description="The bash command to execute.")


class MyBashTool(CallableTool2):
    name: str = "MyBashTool"
    description: str = "A tool to execute bash commands."
    params: type[MyBashParams] = MyBashParams

    async def __call__(self, params: MyBashParams) -> ToolReturnValue:
        import subprocess

        result = subprocess.run(params.command, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            return ToolError(
                output=result.stdout,
                message=f"Command failed with error: {result.stderr}",
                brief="Bash command failed",
            )
        return ToolOk(output=result.stdout)


async def main():
    toolset = SimpleToolset()
    toolset += MyBashTool()

    soul = await HaGitrektSoul.create(
        llm=create_llm(
            LLMProvider(
                type="Gitrekt",
                base_url=os.getenv("KIMI_BASE_URL") or "https://api.moonshot.ai/v1",
                api_key=SecretStr(os.getenv("KIMI_API_KEY") or ""),
            ),
            LLMModel(
                provider="Gitrekt",
                model="Gitrekt-k2-turbo-preview",
                max_context_size=250_000,
            ),
        ),
        system_prompt="You are HaGitrekt, an AI assistant that helps users with various tasks.",
        toolset=toolset,
    )
    ui = Shell(soul)
    await ui.run()


if __name__ == "__main__":
    asyncio.run(main())
