from collections.abc import Sequence
from string import Template
from typing import Protocol, runtime_checkable

from kosong.base import generate
from kosong.base.message import ContentPart, Message, TextPart

import kimi_cli.prompts as prompts
from kimi_cli.llm import LLM
from kimi_cli.soul.message import system
from kimi_cli.utils.logging import logger


@runtime_checkable
class Compaction(Protocol):
    async def compact(self, messages: Sequence[Message], llm: LLM) -> Sequence[Message]:
        """
        Compact a sequence of messages into a new sequence of messages.

        Args:
            messages (Sequence[Message]): The messages to compact.
            llm (LLM): The LLM to use for compaction.

        Returns:
            Sequence[Message]: The compacted messages.

        Raises:
            ChatProviderError: When the chat provider returns an error.
        """
        ...


class SimpleCompaction:
    async def compact(self, messages: Sequence[Message], llm: LLM) -> Sequence[Message]:
        # Convert history to string for the compact prompt
        history_text = "\n\n".join(
            f"## Message {i + 1}\nRole: {msg.role}\nContent: {msg.content}"
            for i, msg in enumerate(messages)
        )

        # Build the compact prompt using string template
        compact_template = Template(prompts.COMPACT)
        compact_prompt = compact_template.substitute(CONTEXT=history_text)

        # Create input message for compaction
        compact_message = Message(role="user", content=compact_prompt)

        # Call generate to get the compacted context
        # TODO: set max completion tokens
        logger.debug("Compacting context...")
        compacted_msg, usage = await generate(
            chat_provider=llm.chat_provider,
            system_prompt="You are a helpful assistant that compacts conversation context.",
            tools=[],
            history=[compact_message],
        )
        if usage:
            logger.debug(
                "Compaction used {input} input tokens and {output} output tokens",
                input=usage.input,
                output=usage.output,
            )

        content: list[ContentPart] = [
            system("Previous context has been compacted. Here is the compaction output:")
        ]
        content.extend(
            [TextPart(text=compacted_msg.content)]
            if isinstance(compacted_msg.content, str)
            else compacted_msg.content
        )
        return [Message(role="assistant", content=content)]


def __static_type_check(
    simple: SimpleCompaction,
):
    _: Compaction = simple
