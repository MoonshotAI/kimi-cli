import asyncio
import inspect
import re
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
    convert_httpx_error,
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
    # httpx errors may leak through the OpenAI SDK during streaming;
    # delegate to the shared converter.
    if isinstance(error, httpx.HTTPError):
        return convert_httpx_error(error)
    # OpenAI SDK errors — check subclasses before parents to avoid
    # misclassification (e.g. APITimeoutError inherits APIConnectionError).
    match error:
        case openai.APIStatusError():
            req_id = error.response.headers.get("x-request-id")
            return APIStatusError(error.status_code, error.message, request_id=req_id)
        case openai.APITimeoutError():
            return APITimeoutError(error.message)
        case openai.APIConnectionError():
            return APIConnectionError(error.message)
        case openai.APIError() if type(error) is openai.APIError and error.body is None:
            # Base APIError with no body indicates a transport-layer failure
            # (e.g. "Network connection lost." during streaming).  SSE error
            # events from the server carry a body dict and should fall through
            # to the default case instead.
            return _classify_base_api_error(error.message)
        case _:
            return ChatProviderError(f"Error: {error}")


_NETWORK_RE = re.compile(r"network|connection|connect|disconnect", re.IGNORECASE)
_TIMEOUT_RE = re.compile(r"timed?\s*out|timeout|deadline", re.IGNORECASE)


def _classify_base_api_error(message: str) -> ChatProviderError:
    """Heuristically map an ``openai.APIError`` message to a retryable error type.

    Timeout patterns are checked first because a message like
    "connection timed out" should be classified as a timeout, not a
    connection error.
    """
    if _TIMEOUT_RE.search(message):
        return APITimeoutError(message)
    if _NETWORK_RE.search(message):
        return APIConnectionError(message)
    return ChatProviderError(f"Error: {message}")


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
        case "xhigh":
            # OpenAI supports xhigh natively for models after gpt-5.1-codex-max.
            return "xhigh"
        case "max":
            # OpenAI's ceiling is xhigh; kosong's ``max`` (Anthropic-specific)
            # clamps to the highest level OpenAI accepts rather than dropping
            # down to high.
            return "xhigh"


def reasoning_effort_to_thinking_effort(effort: ReasoningEffort) -> ThinkingEffort:
    match effort:
        case "low" | "minimal":
            return "low"
        case "medium":
            return "medium"
        case "high":
            return "high"
        case "xhigh":
            return "xhigh"
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
