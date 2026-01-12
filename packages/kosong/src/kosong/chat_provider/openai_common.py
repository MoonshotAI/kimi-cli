import httpx
import openai
from openai import OpenAIError
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
