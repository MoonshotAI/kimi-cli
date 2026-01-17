import asyncio
from typing import Any

from gitrekt_cli.llm import ALL_MODEL_CAPABILITIES, ModelCapability
from gitrekt_cli.soul import StatusSnapshot, wire_send
from gitrekt_cli.ui.shell import Shell
from gitrekt_cli.utils.slashcmd import SlashCommand
from gitrekt_cli.wire.types import ContentPart, StepBegin, TextPart


class EchoSoul:
    def __init__(self) -> None:
        pass

    @property
    def name(self) -> str:
        return "EchoSoul"

    @property
    def model_name(self) -> str:
        return "mock"

    @property
    def model_capabilities(self) -> set[ModelCapability]:
        return ALL_MODEL_CAPABILITIES

    @property
    def status(self) -> StatusSnapshot:
        return StatusSnapshot(context_usage=0.0)

    @property
    def available_slash_commands(self) -> list[SlashCommand[Any]]:
        return []

    async def run(self, user_input: str | list[ContentPart]) -> None:
        wire_send(StepBegin(n=1))
        if isinstance(user_input, str):
            wire_send(TextPart(text=user_input))
        else:
            for part in user_input:
                wire_send(part)


if __name__ == "__main__":
    soul = EchoSoul()
    ui = Shell(soul)
    asyncio.run(ui.run())
