import asyncio
import os
import textwrap
from argparse import ArgumentParser
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel

import kosong
from kosong.chat_provider import ChatProvider
from kosong.message import Message
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolResult, ToolReturnValue, Toolset
from kosong.tooling.simple import SimpleToolset


class BashToolParams(BaseModel):
    command: str
    """The bash command to execute."""


class BashTool(CallableTool2[BashToolParams]):
    name: str = "Bash"
    description: str = "Execute a bash command."
    params: type[BashToolParams] = BashToolParams

    async def __call__(self, params: BashToolParams) -> ToolReturnValue:
        proc = await asyncio.create_subprocess_shell(
            params.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        stdout_text = stdout.decode().strip()
        stderr_text = stderr.decode().strip()
        output_text = "\n".join(filter(None, [stdout_text, stderr_text]))
        if proc.returncode == 0:
            return ToolOk(output=output_text)
        else:
            return ToolError(
                output=output_text,
                message=f"Command failed with exit code {proc.returncode}",
                brief="Bash command failed.",
            )


async def agent_loop(chat_provider: ChatProvider, toolset: Toolset):
    system_prompt = "You are a helpful assistant."
    history: list[Message] = []

    while True:
        user_input = input("You: ").strip()
        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit"}:
            break

        history.append(Message(role="user", content=user_input))

        while True:
            result = await kosong.step(
                chat_provider=chat_provider,
                system_prompt=system_prompt,
                toolset=toolset,
                history=history,
            )

            tool_results = await result.tool_results()

            assistant_message = result.message
            tool_messages = [tool_result_to_message(tr) for tr in tool_results]

            history.append(assistant_message)
            history.extend(tool_messages)

            if s := assistant_message.extract_text():
                print("Assistant:\n", textwrap.indent(s, "  "))
            for tool_msg in tool_messages:
                if s := tool_msg.extract_text():
                    print("Tool:\n", textwrap.indent(s, "  "))

            if not result.tool_calls:
                break


def tool_result_to_message(result: ToolResult) -> Message:
    return Message(
        role="tool",
        tool_call_id=result.tool_call_id,
        content=result.return_value.output,
    )


async def main():
    load_dotenv()

    parser = ArgumentParser(description="A simple agent.")
    parser.add_argument(
        "provider",
        choices=["kimi", "openai", "anthropic", "google"],
        help="The chat provider to use.",
    )
    parser.add_argument(
        "--with-bash",
        action="store_true",
        help="Enable Bash tool.",
    )
    args = parser.parse_args()

    provider: Literal["kimi", "openai", "anthropic", "google"] = args.provider
    with_bash: bool = args.with_bash

    provider_upper = provider.upper()
    base_url = os.getenv(f"{provider_upper}_BASE_URL")
    api_key = os.getenv(f"{provider_upper}_API_KEY")
    model = os.getenv(f"{provider_upper}_MODEL_NAME")

    match provider:
        case "kimi":
            from kosong.chat_provider.kimi import Kimi

            base_url = base_url or "https://api.moonshot.ai/v1"
            assert api_key is not None, "Expect KIMI_API_KEY environment variable"
            model = model or "kimi-k2-turbo-preview"

            chat_provider = Kimi(base_url=base_url, api_key=api_key, model=model)
        case "openai":
            from kosong.contrib.chat_provider.openai_responses import OpenAIResponses

            base_url = base_url or "https://api.openai.com/v1"
            assert api_key is not None, "Expect OPENAI_API_KEY environment variable"
            model = model or "gpt-5"

            chat_provider = OpenAIResponses(base_url=base_url, api_key=api_key, model=model)
        case "anthropic":
            from kosong.contrib.chat_provider.anthropic import Anthropic

            base_url = base_url or "https://api.anthropic.com"
            assert api_key is not None, "Expect ANTHROPIC_API_KEY environment variable"
            model = model or "claude-sonnet-4-5"

            chat_provider = Anthropic(
                base_url=base_url, api_key=api_key, model=model, default_max_tokens=50_000
            )
        case "google":
            from kosong.contrib.chat_provider.google_genai import GoogleGenAI

            api_key = api_key or os.getenv("GEMINI_API_KEY")
            assert api_key is not None, (
                "Expect GOOGLE_API_KEY or GEMINI_API_KEY environment variable"
            )
            model = model or "gemini-3-pro-preview"
            chat_provider = GoogleGenAI(
                base_url=base_url, api_key=api_key, model=model
            ).with_thinking("high")

    toolset = SimpleToolset()
    if with_bash:
        toolset += BashTool()

    await agent_loop(chat_provider, toolset)


asyncio.run(main())
