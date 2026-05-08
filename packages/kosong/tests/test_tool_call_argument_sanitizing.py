import json
from typing import cast

from kosong.contrib.chat_provider.common import (
    parse_tool_call_arguments,
    sanitize_tool_call_arguments,
)
from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy
from kosong.contrib.chat_provider.openai_responses import OpenAIResponses
from kosong.message import Message, ToolCall


def _assistant_tool_call(arguments: str | None) -> Message:
    return Message(
        role="assistant",
        content=[],
        tool_calls=[
            ToolCall(
                id="call-1",
                function=ToolCall.FunctionBody(name="run_command", arguments=arguments),
            )
        ],
    )


def test_tool_call_arguments_keep_control_chars_parseable() -> None:
    valid = json.dumps({"command": "printf 'one\ntwo'"})
    raw_with_literal_newline = valid.replace("\\n", "\n")

    parsed = parse_tool_call_arguments(raw_with_literal_newline)
    sanitized = sanitize_tool_call_arguments(raw_with_literal_newline)

    assert parsed == {"command": "printf 'one\ntwo'"}
    assert json.loads(sanitized) == parsed


def test_tool_call_arguments_fall_back_for_malformed_history() -> None:
    arguments = '{"command": "run", description": "missing opening quote"}'

    assert parse_tool_call_arguments(arguments) == {}
    assert sanitize_tool_call_arguments(arguments) == "{}"


def test_openai_responses_sanitizes_malformed_history_tool_call() -> None:
    provider = OpenAIResponses(model="test-model", api_key="test-key")
    message = _assistant_tool_call('{"command": "run", description": "bad"}')

    converted = cast(list[dict[str, object]], provider._convert_message(message))
    function_call = next(item for item in converted if item["type"] == "function_call")

    assert function_call["arguments"] == "{}"
    assert message.tool_calls is not None
    assert message.tool_calls[0].function.arguments == '{"command": "run", description": "bad"}'


def test_openai_legacy_sanitizes_malformed_history_tool_call() -> None:
    provider = OpenAILegacy(model="test-model", api_key="test-key")
    message = _assistant_tool_call('{"command": "run", description": "bad"}')

    converted = cast(dict[str, object], provider._convert_message(message))
    tool_calls = cast(list[dict[str, object]], converted["tool_calls"])
    function = cast(dict[str, object], tool_calls[0]["function"])

    assert function["arguments"] == "{}"
    assert message.tool_calls is not None
    assert message.tool_calls[0].function.arguments == '{"command": "run", description": "bad"}'
