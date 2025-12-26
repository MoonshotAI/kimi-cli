import copy
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any, Self, TypedDict, Unpack, cast, get_args

import httpx
from openai import AsyncOpenAI, AsyncStream, OpenAIError
from openai.types.responses import (
    Response,
    ResponseInputItemParam,
    ResponseInputParam,
    ResponseOutputMessageParam,
    ResponseOutputTextParam,
    ResponseReasoningItemParam,
    ResponseStreamEvent,
    ResponseUsage,
    ToolParam,
)
from openai.types.responses.response_function_call_output_item_list_param import (
    ResponseFunctionCallOutputItemListParam,
)
from openai.types.responses.response_input_file_content_param import (
    ResponseInputFileContentParam,
)
from openai.types.responses.response_input_file_param import ResponseInputFileParam
from openai.types.responses.response_input_message_content_list_param import (
    ResponseInputMessageContentListParam,
)
from openai.types.shared.reasoning import Reasoning
from openai.types.shared.reasoning_effort import ReasoningEffort
from openai.types.shared_params.responses_model import ResponsesModel

from kosong.chat_provider import ChatProvider, StreamedMessagePart, ThinkingEffort, TokenUsage
from kosong.chat_provider.openai_common import convert_error, thinking_effort_to_reasoning_effort
from kosong.contrib.chat_provider.common import ToolMessageConversion
from kosong.message import (
    AudioURLPart,
    ContentPart,
    ImageURLPart,
    Message,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
)
from kosong.tooling import Tool

if TYPE_CHECKING:

    def type_check(openai_responses: "OpenAIResponses"):
        _: ChatProvider = openai_responses


def get_openai_models_set() -> set[str]:
    """Return a set of all available OpenAI response models.

    This extracts all literal values from the ResponsesModel TypeAlias, which includes
    both ChatModel and additional response-specific models.
    """
    responses_model_args = get_args(ResponsesModel)
    # responses_model_args is (str, ChatModel, Literal[...])
    # Extract from ChatModel (index 1)
    chat_models = set(get_args(responses_model_args[1]))
    # Extract from the Literal part (index 2)
    response_models = set(get_args(responses_model_args[2]))

    return chat_models | response_models


_openai_models = get_openai_models_set()


def is_openai_model(model_name: str) -> bool:
    """Judge if the model name is an OpenAI model."""
    return model_name in _openai_models


class OpenAIResponses:
    """
    A chat provider that uses the OpenAI Responses API.

    Similar to `OpenAILegacy`, but uses `client.responses` under the hood.

    This provider always enables reasoning when generating responses.
    If you want to use a non-reasoning model, please use `OpenAILegacy` instead.

    >>> chat_provider = OpenAIResponses(model="gpt-5-codex", api_key="sk-1234567890")
    >>> chat_provider.name
    'openai-responses'
    >>> chat_provider.model_name
    'gpt-5-codex'
    """

    name = "openai-responses"

    class GenerationKwargs(TypedDict, total=False):
        max_output_tokens: int | None
        max_tool_calls: int | None
        reasoning_effort: ReasoningEffort | None
        temperature: float | None
        top_logprobs: float | None
        top_p: float | None
        user: str | None

    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        stream: bool = True,
        tool_message_conversion: ToolMessageConversion | None = None,
        **client_kwargs: Any,
    ):
        self._model = model
        self._stream = stream
        self._tool_message_conversion: ToolMessageConversion | None = tool_message_conversion
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            **client_kwargs,
        )
        self._generation_kwargs: OpenAIResponses.GenerationKwargs = {}

    @property
    def model_name(self) -> str:
        return self._model

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> "OpenAIResponsesStreamedMessage":
        inputs: ResponseInputParam = []
        if system_prompt:
            system_message: ResponseInputItemParam = {"role": "system", "content": system_prompt}
            if is_openai_model(self.model_name):
                system_message["role"] = "developer"
            inputs.append(system_message)
        # The `Message` type is OpenAI-compatible for Responses API `input` messages.

        for message in history:
            inputs.extend(self._convert_message(message))

        generation_kwargs: dict[str, Any] = {}
        generation_kwargs.update(self._generation_kwargs)
        generation_kwargs["reasoning"] = Reasoning(
            effort=generation_kwargs.pop("reasoning_effort", None),
            summary="auto",
        )
        generation_kwargs["include"] = ["reasoning.encrypted_content"]

        try:
            response = await self._client.responses.create(
                stream=self._stream,
                model=self._model,
                input=inputs,
                tools=[_convert_tool(tool) for tool in tools],
                store=False,
                **generation_kwargs,
            )
            return OpenAIResponsesStreamedMessage(response)
        except (OpenAIError, httpx.HTTPError) as e:
            raise convert_error(e) from e

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        reasoning_effort = thinking_effort_to_reasoning_effort(effort)
        return self.with_generation_kwargs(reasoning_effort=reasoning_effort)

    def with_generation_kwargs(self, **kwargs: Unpack[GenerationKwargs]) -> Self:
        """
        Copy the chat provider, updating the generation kwargs with the given values.

        Returns:
            Self: A new instance of the chat provider with updated generation kwargs.
        """
        new_self = copy.copy(self)
        new_self._generation_kwargs = copy.deepcopy(self._generation_kwargs)
        new_self._generation_kwargs.update(kwargs)
        return new_self

    @property
    def model_parameters(self) -> dict[str, Any]:
        """
        The parameters of the model to use.

        For tracing/logging purposes.
        """

        model_parameters: dict[str, Any] = {"base_url": str(self._client.base_url)}
        model_parameters.update(self._generation_kwargs)
        return model_parameters

    def _convert_message(self, message: Message) -> list[ResponseInputItemParam]:
        """Convert a single message to OpenAI Responses input format.

        Rules:
        - role in {user, assistant}: map to EasyInputMessageParam with role kept
        role == system: map to role=developer for OpenAI models, otherwise kept
        content: str kept; list[ContentPart] mapped to ResponseInputMessageContentListParam
        - role == tool: map to FunctionCallOutput with call_id and output
        """

        role = message.role
        if is_openai_model(self.model_name) and role == "system":
            role = "developer"

        # tool role → function_call_output (return value from a prior tool call)
        if role == "tool":
            call_id = message.tool_call_id or ""
            if self._tool_message_conversion == "extract_text":
                content = message.extract_text(sep="\n")
            else:
                content = message.content
            output = _message_content_to_function_output_items(content)

            return [
                {
                    "call_id": call_id,
                    "output": output,
                    "type": "function_call_output",
                }
            ]

        result: list[ResponseInputItemParam] = []

        # user/system/assistant → message input item
        if len(message.content) > 0:
            # Split into two kinds of blocks: contiguous non-ThinkPart message blocks, and
            # contiguous ThinkPart groups (grouped by the same `encrypted` value)
            pending_parts: list[ContentPart] = []

            def flush_pending_parts() -> None:
                if not pending_parts:
                    return
                if role == "assistant":
                    # the "id" key is missing by purpose
                    result.append(
                        cast(
                            ResponseOutputMessageParam,
                            {
                                "content": _content_parts_to_output_items(pending_parts),
                                "role": role,
                                "type": "message",
                            },
                        )
                    )
                else:
                    result.append(
                        {
                            "content": _content_parts_to_input_items(pending_parts),
                            "role": role,
                            "type": "message",
                        }
                    )
                pending_parts.clear()

            i = 0
            n = len(message.content)
            while i < n:
                part = message.content[i]
                if isinstance(part, ThinkPart):
                    # Flush accumulated non-reasoning parts first
                    flush_pending_parts()
                    # Aggregate consecutive ThinkPart items with the same `encrypted` value
                    encrypted_value = part.encrypted
                    summaries = [{"type": "summary_text", "text": part.think or ""}]
                    i += 1
                    while i < n:
                        next_part = message.content[i]
                        if not isinstance(next_part, ThinkPart):
                            break
                        if next_part.encrypted != encrypted_value:
                            break
                        summaries.append({"type": "summary_text", "text": next_part.think or ""})
                        i += 1
                    result.append(
                        cast(
                            ResponseReasoningItemParam,
                            {
                                "summary": summaries,
                                "type": "reasoning",
                                "encrypted_content": encrypted_value,
                            },
                        )
                    )
                else:
                    pending_parts.append(part)
                    i += 1

            # Handle remaining trailing non-reasoning parts
            flush_pending_parts()

        for tool_call in message.tool_calls or []:
            result.append(
                {
                    "arguments": tool_call.function.arguments or "{}",
                    "call_id": tool_call.id,
                    "name": tool_call.function.name,
                    "type": "function_call",
                }
            )

        return result


def _convert_tool(tool: Tool) -> ToolParam:
    """Convert a Kosong tool to an OpenAI Responses tool."""
    return {
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
        "strict": False,
    }


def _content_parts_to_input_items(parts: list[ContentPart]) -> ResponseInputMessageContentListParam:
    """Map internal ContentPart list → ResponseInputMessageContentListParam items."""
    items: ResponseInputMessageContentListParam = []
    for part in parts:
        if isinstance(part, TextPart):
            if part.text:
                items.append({"type": "input_text", "text": part.text})
        elif isinstance(part, ImageURLPart):
            # default detail
            url = part.image_url.url
            items.append(
                {
                    "type": "input_image",
                    "detail": "auto",
                    "image_url": url,
                }
            )
        elif isinstance(part, AudioURLPart):
            mapped = _map_audio_url_to_input_item(part.audio_url.url)
            if mapped is not None:
                items.append(mapped)
        else:
            # Unknown content – ignore
            continue
    return items


def _content_parts_to_output_items(parts: list[ContentPart]) -> list[ResponseOutputTextParam]:
    """Map internal ContentPart list → ResponseOutputTextParam list items."""
    items: list[ResponseOutputTextParam] = []
    for part in parts:
        if isinstance(part, TextPart):
            if part.text:
                items.append({"type": "output_text", "text": part.text, "annotations": []})
        else:
            # Unknown content – ignore
            continue
    return items


def _message_content_to_function_output_items(
    content: str | list[ContentPart],
) -> str | ResponseFunctionCallOutputItemListParam:
    """Map ContentPart list → ResponseFunctionCallOutputItemListParam items."""
    output: str | ResponseFunctionCallOutputItemListParam
    # If tool_result_process is `extract_text`, patch all text parts into one string
    if isinstance(content, str):
        output = content
    else:
        items: ResponseFunctionCallOutputItemListParam = []
        for part in content:
            if isinstance(part, TextPart):
                if part.text:
                    items.append({"type": "input_text", "text": part.text})
            elif isinstance(part, ImageURLPart):
                url = part.image_url.url
                items.append({"type": "input_image", "image_url": url})
            elif isinstance(part, AudioURLPart):
                mapped = _map_audio_url_to_file_content(part.audio_url.url)
                if mapped is not None:
                    items.append(mapped)
            else:
                continue
        output = items
    return output


def _map_audio_url_to_input_item(url: str) -> ResponseInputFileParam | None:
    """Map audio URL/data URI to an input content item (always an input_file).

    OpenAI Responses message content no longer accepts `input_audio`, so both inline
    data and remote URLs are converted to `input_file` items instead.
    """
    if url.startswith("data:audio/"):
        try:
            header, b64 = url.split(",", 1)
            subtype = header.split("/")[1].split(";")[0].lower()
            ext = "mp3" if subtype in {"mp3", "mpeg"} else ("wav" if subtype == "wav" else None)
            if ext is None:
                return None
            item: ResponseInputFileParam = {"type": "input_file", "file_data": b64}
            item["filename"] = f"inline.{ext}"
            return item
        except Exception:
            return None
    if url.startswith("http://") or url.startswith("https://"):
        return {"type": "input_file", "file_url": url}
    return None


def _map_audio_url_to_file_content(url: str) -> ResponseInputFileContentParam | None:
    """Map audio URL/data URI to a file content item for function_call_output."""
    if url.startswith("http://") or url.startswith("https://"):
        return {"type": "input_file", "file_url": url}
    if url.startswith("data:audio/"):
        try:
            _, b64 = url.split(",", 1)
            # We can attach filename optionally; Responses accepts file_data only
            return {"type": "input_file", "file_data": b64}
        except Exception:
            return None
    return None


class OpenAIResponsesStreamedMessage:
    def __init__(self, response: Response | AsyncStream[ResponseStreamEvent]):
        if isinstance(response, Response):
            self._iter = self._convert_non_stream_response(response)
        else:
            self._iter = self._convert_stream_response(response)
        self._id: str | None = None
        self._usage: ResponseUsage | None = None

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        return await self._iter.__anext__()

    @property
    def id(self) -> str | None:
        return self._id

    @property
    def usage(self) -> TokenUsage | None:
        if self._usage:
            cached = 0
            other_input = self._usage.input_tokens
            if self._usage.input_tokens_details and self._usage.input_tokens_details.cached_tokens:
                cached = self._usage.input_tokens_details.cached_tokens
                other_input -= cached
            return TokenUsage(
                input_other=other_input,
                output=self._usage.output_tokens,
                input_cache_read=cached,
            )
        return None

    async def _convert_non_stream_response(
        self, response: Response
    ) -> AsyncIterator[StreamedMessagePart]:
        """Convert a non-streaming Responses API result into message parts."""
        self._id = response.id
        self._usage = response.usage
        for item in response.output:
            if item.type == "message":
                for content in item.content:
                    if content.type == "output_text":
                        yield TextPart(text=content.text)
            elif item.type == "function_call":
                yield ToolCall(
                    id=item.call_id or str(uuid.uuid4()),
                    function=ToolCall.FunctionBody(
                        name=item.name,
                        arguments=item.arguments,
                    ),
                )
            elif item.type == "reasoning":
                for summary in item.summary:
                    yield ThinkPart(
                        think=summary.text,
                        encrypted=item.encrypted_content,
                    )

    async def _convert_stream_response(
        self, response: AsyncStream[ResponseStreamEvent]
    ) -> AsyncIterator[StreamedMessagePart]:
        """Convert streaming Responses events into message parts."""
        try:
            async for chunk in response:
                if chunk.type == "response.output_text.delta":
                    yield TextPart(text=chunk.delta)
                elif chunk.type == "response.output_item.added":
                    item = chunk.item
                    self._id = item.id
                    if item.type == "function_call":
                        yield ToolCall(
                            id=item.call_id or str(uuid.uuid4()),
                            function=ToolCall.FunctionBody(
                                name=item.name,
                                arguments=item.arguments,
                            ),
                        )
                elif chunk.type == "response.output_item.done":
                    item = chunk.item
                    self._id = item.id
                    if item.type == "reasoning":
                        yield ThinkPart(think="", encrypted=item.encrypted_content)
                elif chunk.type == "response.function_call_arguments.delta":
                    yield ToolCallPart(arguments_part=chunk.delta)
                elif chunk.type == "response.reasoning_summary_part.added":
                    yield ThinkPart(think="")
                elif chunk.type == "response.reasoning_summary_text.delta":
                    yield ThinkPart(think=chunk.delta)
                elif chunk.type == "response.completed":
                    self._usage = chunk.response.usage
        except (OpenAIError, httpx.HTTPError) as e:
            raise convert_error(e) from e


if __name__ == "__main__":

    async def _dev_main():
        # Non-streaming example
        chat = OpenAIResponses(model="gpt-5-codex", stream=True)
        system_prompt = "You are a helpful assistant."
        history = [Message(role="user", content="Hello, how are you?")]

        from kosong import generate

        result = await generate(chat, system_prompt, [], history)
        print(result.message)
        print(result.usage)
        history.append(result.message)

        # Streaming example with tools
        tools = [
            Tool(
                name="get_weather",
                description="Get the weather",
                parameters={
                    "type": "object",
                    "properties": {
                        "city": {
                            "type": "string",
                            "description": "The city to get the weather for.",
                        },
                    },
                },
            )
        ]
        history.append(Message(role="user", content="What's the weather in Beijing?"))
        result = await generate(chat, system_prompt, tools, history)
        print(result.message)
        print(result.usage)
        history.append(result.message)
        for tool_call in result.message.tool_calls or []:
            assert tool_call.function.name == "get_weather"
            history.append(Message(role="tool", tool_call_id=tool_call.id, content="Sunny"))
        result = await generate(chat, system_prompt, tools, history)
        print(result.message)
        print(result.usage)

    import asyncio

    from dotenv import load_dotenv

    load_dotenv(override=True)
    asyncio.run(_dev_main())
