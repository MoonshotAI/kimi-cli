import copy
import os
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any, Literal, Self, Unpack, cast

import httpx
from openai import AsyncOpenAI, AsyncStream, OpenAIError, omit
from openai.types.chat import (
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionMessageParam,
    ChatCompletionToolParam,
)
from openai.types.completion_usage import CompletionUsage
from typing_extensions import TypedDict

from kosong.chat_provider import (
    ChatProvider,
    ChatProviderError,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.chat_provider.openai_common import convert_error, tool_to_openai
from kosong.message import ContentPart, Message, TextPart, ThinkPart, ToolCall, ToolCallPart
from kosong.tooling import Tool

if TYPE_CHECKING:

    def type_check(kimi: "Kimi"):
        _: ChatProvider = kimi


class ThinkingConfig(TypedDict, total=True):
    type: Literal["enabled", "disabled"]


class ExtraBody(TypedDict, total=False, extra_items=Any):
    thinking: ThinkingConfig


class Kimi:
    """
    A chat provider that uses the Kimi API.

    >>> chat_provider = Kimi(model="kimi-k2-turbo-preview", api_key="sk-1234567890")
    >>> chat_provider.name
    'kimi'
    >>> chat_provider.model_name
    'kimi-k2-turbo-preview'
    >>> chat_provider.with_generation_kwargs(temperature=0)._generation_kwargs
    {'temperature': 0}
    >>> chat_provider._generation_kwargs
    {}
    """

    name = "kimi"

    class GenerationKwargs(TypedDict, total=False):
        """
        See https://platform.moonshot.ai/docs/api/chat#request-body.
        """

        max_tokens: int | None
        temperature: float | None
        top_p: float | None
        n: int | None
        presence_penalty: float | None
        frequency_penalty: float | None
        stop: str | list[str] | None
        prompt_cache_key: str | None
        reasoning_effort: str | None
        """Legacy thinking parameter. Use `extra_body.thinking` instead."""
        extra_body: ExtraBody | None

    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        stream: bool = True,
        **client_kwargs: Any,
    ):
        if api_key is None:
            api_key = os.getenv("KIMI_API_KEY")
        if api_key is None:
            raise ChatProviderError(
                "The api_key client option or the KIMI_API_KEY environment variable is not set"
            )
        if base_url is None:
            base_url = os.getenv("KIMI_BASE_URL", "https://api.moonshot.ai/v1")

        self.model: str = model
        """The name of the model to use."""
        self.stream: bool = stream
        """Whether to generate responses as a stream."""
        self.client: AsyncOpenAI = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            **client_kwargs,
        )
        """The underlying `AsyncOpenAI` client."""
        self._generation_kwargs: Kimi.GenerationKwargs = {}

    @property
    def model_name(self) -> str:
        return self.model

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        reasoning_effort = self._generation_kwargs.get("reasoning_effort")
        if reasoning_effort is None:
            return None
        match reasoning_effort:
            case "low":
                return "low"
            case "medium":
                return "medium"
            case "high":
                return "high"
            case _:
                return "off"

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> "KimiStreamedMessage":
        messages: list[ChatCompletionMessageParam] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.extend(_convert_message(message) for message in history)

        generation_kwargs: dict[str, Any] = {
            # default kimi generation kwargs
            "max_tokens": 32000,
        }
        generation_kwargs.update(self._generation_kwargs)
        if "temperature" not in generation_kwargs:
            # set default temperature based on model name
            if "kimi-k2-thinking" in self.model or self._generation_kwargs.get("reasoning_effort"):
                generation_kwargs["temperature"] = 1.0
            elif "kimi-k2-" in self.model:
                generation_kwargs["temperature"] = 0.6

        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=(_convert_tool(tool) for tool in tools),
                stream=self.stream,
                stream_options={"include_usage": True} if self.stream else omit,
                **generation_kwargs,
            )
            return KimiStreamedMessage(response)
        except (OpenAIError, httpx.HTTPError) as e:
            raise convert_error(e) from e

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        match effort:
            case "off":
                reasoning_effort = None
            case "low":
                reasoning_effort = "low"
            case "medium":
                reasoning_effort = "medium"
            case "high":
                reasoning_effort = "high"
        return self.with_generation_kwargs(reasoning_effort=reasoning_effort).with_extra_body(
            {
                "thinking": {
                    "type": "enabled" if effort != "off" else "disabled",
                }
            }
        )

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

    def with_extra_body(self, extra_body: ExtraBody) -> Self:
        """
        Copy the chat provider, updating the extra_body in generation kwargs.

        Returns:
            Self: A new instance of the chat provider with updated extra_body.
        """
        new_self = copy.copy(self)
        new_self._generation_kwargs = copy.deepcopy(self._generation_kwargs)
        old_extra_body = new_self._generation_kwargs.get("extra_body") or {}
        new_extra_body: ExtraBody = {**old_extra_body, **extra_body}
        new_self._generation_kwargs["extra_body"] = new_extra_body
        return new_self

    @property
    def model_parameters(self) -> dict[str, Any]:
        """
        The parameters of the model to use.

        For tracing/logging purposes.
        """

        model_parameters: dict[str, Any] = {"base_url": str(self.client.base_url)}
        model_parameters.update(self._generation_kwargs)
        return model_parameters


def _convert_message(message: Message) -> ChatCompletionMessageParam:
    message = message.model_copy(deep=True)
    reasoning_content: str = ""
    content: list[ContentPart] = []
    for part in message.content:
        if isinstance(part, ThinkPart):
            reasoning_content += part.think
        else:
            content.append(part)
    message.content = content
    dumped_message = message.model_dump(exclude_none=True)
    if reasoning_content:
        dumped_message["reasoning_content"] = reasoning_content
    return cast(ChatCompletionMessageParam, dumped_message)


def _convert_tool(tool: Tool) -> ChatCompletionToolParam:
    if tool.name.startswith("$"):
        # Kimi builtin functions start with `$`
        return cast(
            ChatCompletionToolParam,
            {
                "type": "builtin_function",
                "function": {
                    "name": tool.name,
                    # no need to set description and parameters
                },
            },
        )
    else:
        return tool_to_openai(tool)


class KimiStreamedMessage:
    """The streamed message of the Kimi chat provider."""

    def __init__(self, response: ChatCompletion | AsyncStream[ChatCompletionChunk]):
        if isinstance(response, ChatCompletion):
            self._iter = self._convert_non_stream_response(response)
        else:
            self._iter = self._convert_stream_response(response)
        self._id: str | None = None
        self._usage: CompletionUsage | None = None

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
            other_input = self._usage.prompt_tokens
            if hasattr(self._usage, "cached_tokens"):
                # https://platform.moonshot.cn/docs/api/chat#%E8%BF%94%E5%9B%9E%E5%86%85%E5%AE%B9
                # TODO: delete this when Moonshot API becomes compatible with OpenAI API
                cached = getattr(self._usage, "cached_tokens") or 0  # noqa: B009
                other_input -= cached
            elif (
                self._usage.prompt_tokens_details
                and self._usage.prompt_tokens_details.cached_tokens
            ):
                cached = self._usage.prompt_tokens_details.cached_tokens
                other_input -= cached
            return TokenUsage(
                input_other=other_input,
                output=self._usage.completion_tokens,
                input_cache_read=cached,
            )
        return None

    async def _convert_non_stream_response(
        self,
        response: ChatCompletion,
    ) -> AsyncIterator[StreamedMessagePart]:
        self._id = response.id
        self._usage = response.usage
        message = response.choices[0].message
        if reasoning_content := getattr(message, "reasoning_content", None):
            assert isinstance(reasoning_content, str)
            yield ThinkPart(think=reasoning_content)
        if message.content:
            yield TextPart(text=message.content)
        if message.tool_calls:
            for tool_call in message.tool_calls:
                if isinstance(tool_call, ChatCompletionMessageFunctionToolCall):
                    yield ToolCall(
                        id=tool_call.id or str(uuid.uuid4()),
                        function=ToolCall.FunctionBody(
                            name=tool_call.function.name,
                            arguments=tool_call.function.arguments,
                        ),
                    )

    async def _convert_stream_response(
        self,
        response: AsyncIterator[ChatCompletionChunk],
    ) -> AsyncIterator[StreamedMessagePart]:
        try:
            async for chunk in response:
                if chunk.id:
                    self._id = chunk.id
                if chunk.usage:
                    self._usage = chunk.usage

                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta

                # convert thinking content
                if reasoning_content := getattr(delta, "reasoning_content", None):
                    assert isinstance(reasoning_content, str)
                    yield ThinkPart(think=reasoning_content)

                # convert text content
                if delta.content:
                    yield TextPart(text=delta.content)

                # convert tool calls
                for tool_call in delta.tool_calls or []:
                    if not tool_call.function:
                        continue

                    if tool_call.function.name:
                        yield ToolCall(
                            id=tool_call.id or str(uuid.uuid4()),
                            function=ToolCall.FunctionBody(
                                name=tool_call.function.name,
                                arguments=tool_call.function.arguments,
                            ),
                        )
                    elif tool_call.function.arguments:
                        yield ToolCallPart(
                            arguments_part=tool_call.function.arguments,
                        )
                    else:
                        # skip empty tool calls
                        pass
        except (OpenAIError, httpx.HTTPError) as e:
            raise convert_error(e) from e


if __name__ == "__main__":

    async def _dev_main():
        chat = Kimi(model="kimi-k2-turbo-preview", stream=False)
        system_prompt = ""
        history = [
            Message(role="user", content="Hello, who is Confucius?"),
        ]
        stream = await chat.with_generation_kwargs(
            temperature=0,
            max_tokens=1000,
        ).generate(system_prompt, [], history)
        async for part in stream:
            print(part.model_dump(exclude_none=True))
        print("id:", stream.id)
        print("usage:", stream.usage)

    import asyncio

    from dotenv import load_dotenv

    load_dotenv()
    asyncio.run(_dev_main())
