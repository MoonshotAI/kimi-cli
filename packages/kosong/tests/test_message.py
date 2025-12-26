from inline_snapshot import snapshot

from kosong.message import AudioURLPart, ImageURLPart, Message, TextPart, ThinkPart, ToolCall


def test_plain_text_message():
    message = Message(role="user", content="Hello, world!")
    dumped = message.model_dump(exclude_none=True)
    assert dumped == snapshot({"role": "user", "content": "Hello, world!"})
    assert Message.model_validate(dumped) == message


def test_message_with_single_part():
    message = Message(
        role="assistant",
        content=ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")),
    )
    dumped = message.model_dump(exclude_none=True)
    assert dumped == snapshot(
        {
            "role": "assistant",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png", "id": None},
                }
            ],
        }
    )
    assert Message.model_validate(dumped) == message


def test_message_with_tool_calls():
    message = Message(
        role="assistant",
        content=[TextPart(text="Hello, world!")],
        tool_calls=[
            ToolCall(id="123", function=ToolCall.FunctionBody(name="function", arguments="{}"))
        ],
    )
    dumped = message.model_dump(exclude_none=True)
    assert dumped == snapshot(
        {
            "role": "assistant",
            "content": "Hello, world!",
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "function", "arguments": "{}"},
                }
            ],
        }
    )
    assert Message.model_validate(dumped) == message


def test_message_with_no_content():
    message = Message(
        role="assistant",
        content=[],
        tool_calls=[
            ToolCall(id="123", function=ToolCall.FunctionBody(name="function", arguments="{}"))
        ],
    )

    assert message.model_dump(exclude_none=True) == snapshot(
        {
            "role": "assistant",
            "content": [],
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "function", "arguments": "{}"},
                }
            ],
        }
    )


def test_message_with_complex_content():
    message = Message(
        role="user",
        content=[
            TextPart(text="Hello, world!"),
            ThinkPart(think="I think I need to think about this."),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")),
            AudioURLPart(audio_url=AudioURLPart.AudioURL(url="https://example.com/audio.mp3")),
        ],
        tool_calls=[
            ToolCall(id="123", function=ToolCall.FunctionBody(name="function", arguments="{}")),
        ],
    )
    dumped = message.model_dump(exclude_none=True)
    assert dumped == snapshot(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello, world!"},
                {
                    "type": "think",
                    "think": "I think I need to think about this.",
                    "encrypted": None,
                },
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png", "id": None},
                },
                {
                    "type": "audio_url",
                    "audio_url": {"url": "https://example.com/audio.mp3", "id": None},
                },
            ],
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "function", "arguments": "{}"},
                }
            ],
        }
    )
    assert Message.model_validate(dumped) == message


def test_deserialize_from_json_plain_text():
    data = {
        "role": "user",
        "content": "Hello, world!",
    }
    message = Message.model_validate(data)
    assert message == snapshot(Message(role="user", content=[TextPart(text="Hello, world!")]))


def test_deserialize_from_json_with_content_and_tool_calls():
    data = {
        "role": "assistant",
        "content": [
            {
                "type": "text",
                "text": "Hello, world!",
            }
        ],
        "tool_calls": [
            {
                "type": "function",
                "id": "tc_123",
                "function": {"name": "do_something", "arguments": '{"x":1}'},
            }
        ],
    }
    message = Message.model_validate(data)
    assert message == snapshot(
        Message(
            role="assistant",
            content=[TextPart(text="Hello, world!")],
            tool_calls=[
                ToolCall(
                    id="tc_123",
                    function=ToolCall.FunctionBody(name="do_something", arguments='{"x":1}'),
                )
            ],
        )
    )


def test_deserialize_from_json_none_content_with_tool_calls():
    data = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "type": "function",
                "id": "tc_456",
                "function": {"name": "do_other", "arguments": "{}"},
            }
        ],
    }
    message = Message.model_validate(data)
    assert message == snapshot(
        Message(
            role="assistant",
            content=[],
            tool_calls=[
                ToolCall(
                    id="tc_456", function=ToolCall.FunctionBody(name="do_other", arguments="{}")
                )
            ],
        )
    )


def test_deserialize_from_json_with_content_but_no_tool_calls():
    data = {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "Only content, no tools.",
            }
        ],
    }
    message = Message.model_validate(data)
    assert message == snapshot(
        Message(role="user", content=[TextPart(text="Only content, no tools.")])
    )


def test_message_with_empty_list_content():
    """Test that content=[] serializes to None and deserializes back to []."""
    # Create message with empty list content
    message = Message(role="assistant", content=[])

    # Serialize - empty list should become None
    dumped = message.model_dump()
    assert dumped == snapshot(
        {
            "role": "assistant",
            "name": None,
            "content": [],
            "tool_calls": None,
            "tool_call_id": None,
            "partial": None,
        }
    )

    # Deserialize back - None should become empty list
    assert Message.model_validate(dumped) == snapshot(Message(role="assistant", content=[]))

    # Test with tool_calls
    message_with_tools = Message(
        role="assistant",
        content=[],
        tool_calls=[
            ToolCall(id="123", function=ToolCall.FunctionBody(name="test_func", arguments="{}"))
        ],
    )
    dumped = message_with_tools.model_dump()
    assert dumped == snapshot(
        {
            "role": "assistant",
            "name": None,
            "content": [],
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "test_func", "arguments": "{}"},
                    "extras": None,
                }
            ],
            "tool_call_id": None,
            "partial": None,
        }
    )
    assert Message.model_validate(dumped) == snapshot(
        Message(
            role="assistant",
            content=[],
            tool_calls=[
                ToolCall(id="123", function=ToolCall.FunctionBody(name="test_func", arguments="{}"))
            ],
        )
    )


def test_message_extract_text():
    message = Message(
        role="user",
        content=[
            TextPart(text="Hello, "),
            TextPart(text="world"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")),
            TextPart(text="!"),
            ThinkPart(think="This is a thought."),
        ],
    )
    extracted_text = message.extract_text()
    assert extracted_text == snapshot("Hello, world!")
    extracted_text = message.extract_text(sep="\n")
    assert extracted_text == snapshot("""\
Hello, \n\
world
!\
""")
