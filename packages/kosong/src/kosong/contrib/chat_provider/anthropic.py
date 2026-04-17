try:
    import anthropic as _  # noqa: F401
except ModuleNotFoundError as exc:
    raise ModuleNotFoundError(
        "Anthropic support requires the optional dependency 'anthropic'. "
        'Install with `pip install "kosong[contrib]"`.'
    ) from exc

import copy
import json
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal, Self, TypedDict, Unpack, cast

import httpx
from anthropic import (
    AnthropicError,
    AsyncAnthropic,
    AsyncStream,
    omit,
)
from anthropic import (
    APIConnectionError as AnthropicAPIConnectionError,
)
from anthropic import (
    APIStatusError as AnthropicAPIStatusError,
)
from anthropic import (
    APITimeoutError as AnthropicAPITimeoutError,
)
from anthropic import (
    AuthenticationError as AnthropicAuthenticationError,
)
from anthropic import (
    PermissionDeniedError as AnthropicPermissionDeniedError,
)
from anthropic import (
    RateLimitError as AnthropicRateLimitError,
)
from anthropic.lib.streaming import MessageStopEvent
from anthropic.types import (
    Base64ImageSourceParam,
    CacheControlEphemeralParam,
    ContentBlockParam,
    ImageBlockParam,
    MessageDeltaEvent,
    MessageDeltaUsage,
    MessageParam,
    MessageStartEvent,
    MetadataParam,
    OutputConfigParam,
    RawContentBlockDeltaEvent,
    RawContentBlockStartEvent,
    RawMessageStreamEvent,
    TextBlockParam,
    ThinkingBlockParam,
    ThinkingConfigParam,
    ToolChoiceParam,
    ToolParam,
    ToolResultBlockParam,
    ToolUseBlockParam,
    URLImageSourceParam,
    Usage,
)
from anthropic.types import (
    Message as AnthropicMessage,
)
from anthropic.types.tool_result_block_param import Content as ToolResultContent

from kosong.chat_provider import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    ChatProvider,
    ChatProviderError,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
    convert_httpx_error,
)
from kosong.contrib.chat_provider.common import ToolMessageConversion
from kosong.message import (
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

    def type_check(anthropic: "Anthropic"):
        _: ChatProvider = anthropic


type MessagePayload = tuple[str | None, list[MessageParam]]

type BetaFeatures = Literal["interleaved-thinking-2025-05-14"]


# Models that accept adaptive thinking but don't expose a major.minor version
# in their identifier (e.g. Claude Mythos Preview).
_ADAPTIVE_MARKERS_NO_VERSION: tuple[str, ...] = ("mythos",)

# Matches the Claude family's major.minor version inside a model identifier.
# `\d{1,2}(?!\d)` prevents date suffixes like `sonnet-4-20250514` from being
# misread as minor=20: `20` would be followed by another digit, so the
# negative lookahead fails and the regex does not match at all.
_FAMILY_VERSION_RE = re.compile(r"(?:opus|sonnet|haiku)[.-](\d+)[.-](\d{1,2})(?!\d)")

# Adaptive thinking was introduced with Opus 4.6 / Sonnet 4.6.
_ADAPTIVE_MIN_VERSION: tuple[int, int] = (4, 6)


def _supports_adaptive_thinking(model: str) -> bool:
    """Whether the given model id accepts `thinking: {type: "adaptive"}`.

    Strategy: explicit marker for non-versioned models (e.g. Mythos), plus a
    strict regex over the Claude family that extrapolates to unknown future
    versions (>= 4.6) without code changes.
    """
    m = model.lower()
    if any(marker in m for marker in _ADAPTIVE_MARKERS_NO_VERSION):
        return True
    if match := _FAMILY_VERSION_RE.search(m):
        major, minor = int(match.group(1)), int(match.group(2))
        return (major, minor) >= _ADAPTIVE_MIN_VERSION
    return False


def _is_opus_4_7(model: str) -> bool:
    """Opus 4.7 specifically supports the ``xhigh`` effort level.

    The docs explicitly enumerate ``xhigh`` support as "Available on Claude
    Opus 4.7" — not "4.7 and later". We keep the check exact so that a
    future Opus 4.8 that silently drops xhigh doesn't start returning 400.
    Future versions fall back to the 4.6-family effort set (which still
    covers ``max``) until this table is updated.
    """
    m = model.lower()
    if match := re.search(r"opus[.-](\d+)[.-](\d{1,2})(?!\d)", m):
        major, minor = int(match.group(1)), int(match.group(2))
        return (major, minor) == (4, 7)
    return False


def _supported_efforts(model: str) -> frozenset["ThinkingEffort"]:
    """Effort levels accepted by ``output_config.effort`` for the given model.

    Per Anthropic docs:
      - xhigh: Opus 4.7 only
      - max:   Mythos, Opus 4.7, Opus 4.6, Sonnet 4.6 (and future adaptive models)
      - low/medium/high: all models with effort support (including Opus 4.5+)
    """
    if _is_opus_4_7(model):
        return frozenset({"low", "medium", "high", "xhigh", "max"})
    if _supports_adaptive_thinking(model):
        # 4.6 family / Mythos / future adaptive models: support max but not xhigh
        return frozenset({"low", "medium", "high", "max"})
    # Pre-4.6 models: capped at high
    return frozenset({"low", "medium", "high"})


def _clamp_effort(effort: "ThinkingEffort", model: str) -> "ThinkingEffort":
    """Clamp an effort level to the highest one supported by the model.

    Anything the model doesn't support falls back to ``high`` — the
    universally available ceiling. ``off`` is passed through unchanged as
    it represents "disable thinking" rather than an effort rank.
    """
    if effort == "off":
        return effort
    if effort in _supported_efforts(model):
        return effort
    return "high"


def _supports_effort_param(model: str) -> bool:
    """Whether the model accepts ``output_config.effort`` at all.

    Per Anthropic's effort docs, the parameter is explicitly supported on
    Claude Mythos Preview, Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet
    4.6, and Claude Opus 4.5. Adaptive-capable models all support it via the
    adaptive pathway. For the legacy (manual thinking) pathway, only Opus
    4.5 is explicitly listed.

    We gate ``output_config`` emission on this predicate to avoid sending
    effort to models that would reject it with a 400 (Claude 3.x, and
    conservatively Sonnet 4 / Sonnet 4.5 / Haiku 4.5 which are not in the
    explicit list). A false negative here means "effort not sent, no
    regression from pre-effort behaviour"; a false positive would mean
    "API 400 error", so we err on the side of silence.
    """
    if _supports_adaptive_thinking(model):
        return True
    # Opus 4.5 is the only legacy (non-adaptive) model that Anthropic docs
    # explicitly confirm supports the effort parameter.
    m = model.lower()
    return "opus-4-5" in m or "opus-4.5" in m


class Anthropic:
    """
    Chat provider backed by Anthropic's Messages API.
    """

    name = "anthropic"

    class GenerationKwargs(TypedDict, total=False):
        max_tokens: int | None
        temperature: float | None
        top_k: int | None
        top_p: float | None
        # e.g., {"type": "adaptive", "display": "summarized"}
        # or   {"type": "enabled", "budget_tokens": 1024}
        thinking: ThinkingConfigParam | None
        # e.g., {"effort": "high"} — soft guidance that applies to all output
        # tokens. Used in adaptive thinking requests, and in legacy requests
        # only when the model is on Anthropic's explicit effort-supporting
        # list (see ``_supports_effort_param``).
        output_config: OutputConfigParam | None
        # e.g., {"type": "auto", "disable_parallel_tool_use": True}
        tool_choice: ToolChoiceParam | None

        beta_features: list[BetaFeatures] | None
        extra_headers: Mapping[str, str] | None

    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        stream: bool = True,
        # which process should we apply on tool result
        tool_message_conversion: ToolMessageConversion | None = None,
        # Must provide a max_tokens. Can be overridden by .with_generation_kwargs()
        default_max_tokens: int,
        metadata: MetadataParam | None = None,
        **client_kwargs: Any,
    ):
        self._model = model
        self._stream = stream
        self._client = AsyncAnthropic(api_key=api_key, base_url=base_url, **client_kwargs)
        self._tool_message_conversion: ToolMessageConversion | None = tool_message_conversion
        self._metadata = metadata
        self._generation_kwargs: Anthropic.GenerationKwargs = {
            "max_tokens": default_max_tokens,
            "beta_features": ["interleaved-thinking-2025-05-14"],
        }

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def thinking_effort(self) -> "ThinkingEffort | None":
        thinking_config = self._generation_kwargs.get("thinking")
        if thinking_config is None:
            return None
        if thinking_config["type"] == "disabled":
            return "off"
        if thinking_config["type"] == "adaptive":
            output_config = self._generation_kwargs.get("output_config") or {}
            effort = output_config.get("effort")
            if effort in ("low", "medium", "high", "xhigh", "max"):
                return effort
            return "high"
        budget = thinking_config["budget_tokens"]
        if budget <= 1024:
            return "low"
        if budget <= 4096:
            return "medium"
        return "high"

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> "AnthropicStreamedMessage":
        # https://docs.claude.com/en/api/messages#body-messages
        # Anthropic API does not support system roles, but just a system prompt.
        system = (
            [
                TextBlockParam(
                    text=system_prompt,
                    type="text",
                    cache_control=CacheControlEphemeralParam(type="ephemeral"),
                )
            ]
            if system_prompt
            else omit
        )
        messages: list[MessageParam] = []
        for message in history:
            messages.append(self._convert_message(message))
        if messages:
            last_message = messages[-1]
            last_content = last_message["content"]

            # inject cache control in the last content.
            # https://docs.claude.com/en/docs/build-with-claude/prompt-caching
            if isinstance(last_content, list) and last_content:
                content_blocks = cast(list[ContentBlockParam], last_content)
                last_block = content_blocks[-1]
                match last_block["type"]:
                    case (
                        "text"
                        | "image"
                        | "document"
                        | "search_result"
                        | "tool_use"
                        | "tool_result"
                        | "server_tool_use"
                        | "web_search_tool_result"
                    ):
                        last_block["cache_control"] = CacheControlEphemeralParam(type="ephemeral")
                    case "thinking" | "redacted_thinking":
                        pass
        generation_kwargs: dict[str, Any] = {}
        generation_kwargs.update(self._generation_kwargs)
        betas = generation_kwargs.pop("beta_features", [])
        extra_headers = {
            **{"anthropic-beta": ",".join(str(e) for e in betas)},
            **(generation_kwargs.pop("extra_headers", {})),
        }

        tools_ = [_convert_tool(tool) for tool in tools]
        if tools:
            tools_[-1]["cache_control"] = CacheControlEphemeralParam(type="ephemeral")
        try:
            response = await self._client.messages.create(
                model=self._model,
                messages=messages,
                system=system,
                tools=tools_,
                stream=self._stream,
                extra_headers=extra_headers,
                metadata=self._metadata if self._metadata is not None else omit,
                **generation_kwargs,
            )
            return AnthropicStreamedMessage(response)
        except (AnthropicError, httpx.HTTPError) as e:
            raise _convert_error(e) from e

    def with_thinking(self, effort: "ThinkingEffort") -> Self:
        if effort == "off":
            new = self.with_generation_kwargs(thinking={"type": "disabled"})
            # Clear any stale output_config from a prior adaptive configuration.
            new._generation_kwargs.pop("output_config", None)
            return new

        # Clamp to whatever the model actually accepts. xhigh/max fall back
        # to high on models that don't support them; low/medium/high pass
        # through; max passes through on 4.6-family and newer.
        effective = _clamp_effort(effort, self._model)
        # SDK 0.78 OutputConfigParam TypedDict lists only low/medium/high/max.
        # `xhigh` is valid on Opus 4.7 per the API docs but not yet typed.
        output_config: OutputConfigParam = {"effort": effective}  # type: ignore[typeddict-item]

        if _supports_adaptive_thinking(self._model):
            # Opus 4.6+ / Sonnet 4.6+ / Mythos: adaptive thinking.
            # `display: "summarized"` is required on Opus 4.7+ (where the default
            # flipped to "omitted") and is a no-op on 4.6. Setting it
            # unconditionally keeps thinking content visible across versions.
            # SDK 0.78 TypedDict doesn't model `display` yet — thus the ignore.
            thinking_config: ThinkingConfigParam = {
                "type": "adaptive",
                "display": "summarized",
            }  # type: ignore[typeddict-item]
            new = self.with_generation_kwargs(
                thinking=thinking_config,
                output_config=output_config,
            )
            # Adaptive mode auto-enables interleaved thinking, so the beta
            # header is redundant. Drop it if still present from construction.
            if (
                beta_features := new._generation_kwargs.get("beta_features")
            ) and "interleaved-thinking-2025-05-14" in beta_features:
                beta_features.remove("interleaved-thinking-2025-05-14")
            return new

        # Pre-4.6 models: legacy budget-based thinking. After clamping,
        # `effective` is guaranteed to be one of low/medium/high here.
        # Only models that Anthropic's docs explicitly list as supporting the
        # effort parameter (e.g. Opus 4.5) get `output_config` emitted; other
        # pre-4.6 models (Sonnet 4, Sonnet 4.5, Haiku 4.5, Claude 3.x) omit it
        # to avoid 400 validation errors on models that don't accept it.
        budgets: dict[str, int] = {"low": 1024, "medium": 4096, "high": 32_000}
        kwargs: dict[str, Any] = {
            "thinking": {"type": "enabled", "budget_tokens": budgets[effective]},
        }
        if _supports_effort_param(self._model):
            kwargs["output_config"] = output_config
        return self.with_generation_kwargs(**kwargs)

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

    def _convert_message(self, message: Message) -> MessageParam:
        """Convert a single internal message into Anthropic wire format."""
        role = message.role

        if role == "system":
            # Anthropic does not support system messages in the conversation.
            # We map it to a special user message.
            return MessageParam(
                role="user",
                content=[
                    TextBlockParam(
                        type="text", text=f"<system>{message.extract_text(sep='\n')}</system>"
                    )
                ],
            )
        elif role == "tool":
            if message.tool_call_id is None:
                raise ChatProviderError("Tool message missing `tool_call_id`.")
            if self._tool_message_conversion == "extract_text":
                content = message.extract_text(sep="\n")
            else:
                content = message.content
            block = _tool_result_message_to_block(message.tool_call_id, content)
            return MessageParam(role="user", content=[block])

        assert role in ("user", "assistant")
        blocks: list[ContentBlockParam] = []
        for part in message.content:
            if isinstance(part, TextPart):
                blocks.append(TextBlockParam(type="text", text=part.text))
            elif isinstance(part, ImageURLPart):
                blocks.append(_image_url_part_to_anthropic(part))
            elif isinstance(part, ThinkPart):
                if part.encrypted is None:
                    # missing signature, strip this thinking block.
                    continue
                else:
                    blocks.append(
                        ThinkingBlockParam(
                            type="thinking", thinking=part.think, signature=part.encrypted
                        )
                    )
            else:
                continue
        for tool_call in message.tool_calls or []:
            if tool_call.function.arguments:
                try:
                    parsed_arguments = json.loads(tool_call.function.arguments, strict=False)
                except json.JSONDecodeError as exc:  # pragma: no cover - defensive guard
                    raise ChatProviderError("Tool call arguments must be valid JSON.") from exc
                if not isinstance(parsed_arguments, dict):
                    raise ChatProviderError("Tool call arguments must be a JSON object.")
                tool_input = cast(dict[str, object], parsed_arguments)
            else:
                tool_input = {}
            blocks.append(
                ToolUseBlockParam(
                    type="tool_use",
                    id=tool_call.id,
                    name=tool_call.function.name,
                    input=tool_input,
                )
            )
        return MessageParam(role=role, content=blocks)


class AnthropicStreamedMessage:
    def __init__(self, response: AnthropicMessage | AsyncStream[RawMessageStreamEvent]):
        if isinstance(response, AnthropicMessage):
            self._iter = self._convert_non_stream_response(response)
        else:
            self._iter = self._convert_stream_response(response)
        self._id: str | None = None
        self._usage = Usage(input_tokens=0, output_tokens=0)

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        return await self._iter.__anext__()

    @property
    def id(self) -> str | None:
        return self._id

    @property
    def usage(self) -> TokenUsage | None:
        # https://docs.claude.com/en/docs/build-with-claude/prompt-caching#tracking-cache-performance
        return TokenUsage(
            # Note: in some Anthropic-compatible APIs, input_tokens can be None
            input_other=self._usage.input_tokens or 0,
            output=self._usage.output_tokens,
            input_cache_read=self._usage.cache_read_input_tokens or 0,
            input_cache_creation=self._usage.cache_creation_input_tokens or 0,
        )

    def _update_usage(self, delta_usage: MessageDeltaUsage) -> None:
        if delta_usage.cache_creation_input_tokens is not None:
            self._usage.cache_creation_input_tokens = delta_usage.cache_creation_input_tokens
        if delta_usage.cache_read_input_tokens is not None:
            self._usage.cache_read_input_tokens = delta_usage.cache_read_input_tokens
        if delta_usage.input_tokens is not None:
            self._usage.input_tokens = delta_usage.input_tokens
        if delta_usage.output_tokens is not None:  # type: ignore
            self._usage.output_tokens = delta_usage.output_tokens

    async def _convert_non_stream_response(
        self,
        response: AnthropicMessage,
    ) -> AsyncIterator[StreamedMessagePart]:
        self._id = response.id
        self._usage = response.usage
        for block in response.content:
            match block.type:
                case "text":
                    yield TextPart(text=block.text)
                case "thinking":
                    yield ThinkPart(think=block.thinking, encrypted=block.signature)
                case "redacted_thinking":
                    yield ThinkPart(think="", encrypted=block.data)
                case "tool_use":
                    yield ToolCall(
                        id=block.id,
                        function=ToolCall.FunctionBody(
                            name=block.name, arguments=json.dumps(block.input)
                        ),
                    )
                case _:
                    continue

    async def _convert_stream_response(
        self,
        manager: AsyncStream[RawMessageStreamEvent],
    ) -> AsyncIterator[StreamedMessagePart]:
        try:
            async with manager as stream:
                async for event in stream:
                    if isinstance(event, MessageStartEvent):
                        self._id = event.message.id
                        # Capture initial usage from start event
                        # (contains initial prompt/input token usage)
                        self._usage = event.message.usage
                    elif isinstance(event, RawContentBlockStartEvent):
                        block = event.content_block
                        match block.type:
                            case "text":
                                yield TextPart(text=block.text)
                            case "thinking":
                                yield ThinkPart(think=block.thinking)
                            case "redacted_thinking":
                                yield ThinkPart(think="", encrypted=block.data)
                            case "tool_use":
                                yield ToolCall(
                                    id=block.id,
                                    function=ToolCall.FunctionBody(name=block.name, arguments=""),
                                )
                            case "server_tool_use" | "web_search_tool_result":
                                # ignore
                                continue
                    elif isinstance(event, RawContentBlockDeltaEvent):
                        delta = event.delta
                        match delta.type:
                            case "text_delta":
                                yield TextPart(text=delta.text)
                            case "thinking_delta":
                                yield ThinkPart(think=delta.thinking)
                            case "input_json_delta":
                                yield ToolCallPart(arguments_part=delta.partial_json)
                            case "signature_delta":
                                yield ThinkPart(think="", encrypted=delta.signature)
                            case "citations_delta":
                                # ignore
                                continue
                    elif isinstance(event, MessageDeltaEvent):
                        if event.usage:
                            self._update_usage(event.usage)
                    elif isinstance(event, MessageStopEvent):
                        continue
        except (AnthropicError, httpx.HTTPError) as exc:
            raise _convert_error(exc) from exc


def _convert_tool(tool: Tool) -> ToolParam:
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.parameters,
    }


def _tool_result_message_to_block(
    tool_call_id: str, content: str | list[ContentPart]
) -> ToolResultBlockParam:
    block_content: str | list[ToolResultContent]
    # If tool_result_process is `extract_text`, we join all text parts into one string
    if isinstance(content, str):
        block_content = content
    else:
        # Otherwise, map parts to content blocks
        blocks: list[ToolResultContent] = []
        for part in content:
            if isinstance(part, TextPart):
                if part.text:
                    blocks.append(TextBlockParam(type="text", text=part.text))
            elif isinstance(part, ImageURLPart):
                blocks.append(_image_url_part_to_anthropic(part))
            else:
                # https://docs.claude.com/en/docs/build-with-claude/files#file-types-and-content-blocks
                # Anthropic API supports very limited file types
                raise ChatProviderError(
                    f"Anthropic API does not support {type(part)} in tool result"
                )
        block_content = blocks

    return ToolResultBlockParam(
        type="tool_result",
        tool_use_id=tool_call_id,
        content=block_content,
    )


def _image_url_part_to_anthropic(part: ImageURLPart) -> ImageBlockParam:
    url = part.image_url.url
    # data:[<media-type>][;base64],<data>
    if url.startswith("data:"):
        res = url[5:].split(";base64,", 1)
        if len(res) != 2:
            raise ChatProviderError(f"Invalid data URL for image: {url}")
        media_type, data = res
        if media_type not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
            raise ChatProviderError(
                f"Unsupported media type for base64 image: {media_type}, url: {url}"
            )
        return ImageBlockParam(
            type="image",
            source=Base64ImageSourceParam(
                type="base64",
                data=data,
                media_type=media_type,
            ),
        )
    else:
        return ImageBlockParam(
            type="image",
            source=URLImageSourceParam(type="url", url=url),
        )


def _convert_error(error: AnthropicError | httpx.HTTPError) -> ChatProviderError:
    # httpx errors may leak through the Anthropic SDK during streaming;
    # delegate to the shared converter.
    if isinstance(error, httpx.HTTPError):
        return convert_httpx_error(error)
    # Anthropic SDK errors — check subclasses before parents to avoid
    # misclassification (e.g. APITimeoutError inherits APIConnectionError).
    if isinstance(error, AnthropicAPIStatusError):
        return APIStatusError(error.status_code, str(error))
    if isinstance(error, AnthropicAuthenticationError):
        return APIStatusError(getattr(error, "status_code", 401), str(error))
    if isinstance(error, AnthropicPermissionDeniedError):
        return APIStatusError(getattr(error, "status_code", 403), str(error))
    if isinstance(error, AnthropicRateLimitError):
        return APIStatusError(getattr(error, "status_code", 429), str(error))
    if isinstance(error, AnthropicAPITimeoutError):
        return APITimeoutError(str(error))
    if isinstance(error, AnthropicAPIConnectionError):
        return APIConnectionError(str(error))
    return ChatProviderError(f"Anthropic error: {error}")
