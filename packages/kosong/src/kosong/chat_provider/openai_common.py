import asyncio
import inspect
from collections.abc import Awaitable, Mapping
from typing import Any, cast

import httpx
import openai
from openai import AsyncOpenAI, OpenAIError
from openai.types import ReasoningEffort
from openai.types.chat import ChatCompletionToolParam

from kosong.chat_provider import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
    ThinkingEffort,
)
from kosong.tooling import Tool


def create_openai_client(
    *,
    api_key: str | None,
    base_url: str | None,
    client_kwargs: Mapping[str, Any],
) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=api_key, base_url=base_url, **dict(client_kwargs))


async def _drain_awaitable(awaitable: Awaitable[object]) -> None:
    try:
        await awaitable
    except Exception:
        return


def close_openai_client(client: AsyncOpenAI) -> None:
    close = getattr(client, "close", None)
    if not callable(close):
        return
    try:
        result = close()
    except Exception:
        return
    if not inspect.isawaitable(result):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        if hasattr(result, "close"):
            result.close()  # type: ignore[attr-defined]
        return
    loop.create_task(_drain_awaitable(cast(Awaitable[object], result)))


def close_replaced_openai_client(client: AsyncOpenAI, *, client_kwargs: Mapping[str, Any]) -> None:
    """
    Close a replaced OpenAI client unless it would close a shared external http client.

    When callers pass `http_client=...` to `AsyncOpenAI`, multiple wrappers may share the same
    `httpx.AsyncClient`. Closing the replaced wrapper would also close that shared client and
    break the new wrapper immediately.
    """
    shared_http_client = client_kwargs.get("http_client")
    if isinstance(shared_http_client, httpx.AsyncClient) and getattr(client, "_client", None) is (
        shared_http_client
    ):
        return
    close_openai_client(client)


def convert_error(error: OpenAIError | httpx.HTTPError) -> ChatProviderError:
    match error:
        case openai.APIStatusError():
            return APIStatusError(error.status_code, error.message)
        case openai.APIConnectionError():
            return APIConnectionError(error.message)
        case openai.APITimeoutError():
            return APITimeoutError(error.message)
        case httpx.TimeoutException():
            return APITimeoutError(str(error))
        case httpx.NetworkError():
            return APIConnectionError(str(error))
        case httpx.HTTPStatusError():
            return APIStatusError(error.response.status_code, str(error))
        case _:
            return ChatProviderError(f"Error: {error}")


def thinking_effort_to_reasoning_effort(effort: ThinkingEffort) -> ReasoningEffort:
    match effort:
        case "off":
            return None
        case "low":
            return "low"
        case "medium":
            return "medium"
        case "high":
            return "high"


def reasoning_effort_to_thinking_effort(effort: ReasoningEffort) -> ThinkingEffort:
    match effort:
        case "low" | "minimal":
            return "low"
        case "medium":
            return "medium"
        case "high" | "xhigh":
            return "high"
        case "none" | None:
            return "off"


def tool_to_openai(tool: Tool) -> ChatCompletionToolParam:
    """Convert a single tool to OpenAI tool format."""
    # simply `model_dump` because the `Tool` type is OpenAI-compatible
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }
