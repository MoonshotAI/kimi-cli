use serde_json::{Value, json};

use kosong::message::{
    AudioURLPart, ContentPart, ImageURLPart, Message, Role, TextPart, ThinkPart, ToolCall,
    ToolCallFunction, VideoURLPart,
};

fn strip_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut cleaned = serde_json::Map::new();
            for (key, val) in map {
                if val.is_null() {
                    continue;
                }
                cleaned.insert(key, strip_nulls(val));
            }
            Value::Object(cleaned)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(strip_nulls).collect()),
        other => other,
    }
}

fn tool_call(id: &str, name: &str, arguments: Option<&str>) -> ToolCall {
    ToolCall {
        kind: "function".to_string(),
        id: id.to_string(),
        function: ToolCallFunction {
            name: name.to_string(),
            arguments: arguments.map(|value| value.to_string()),
        },
        extras: None,
    }
}

#[test]
fn plain_text_message() {
    let message = Message {
        role: Role::User,
        content: vec![ContentPart::Text(TextPart::new("Hello, world!"))],
        name: None,
        tool_calls: None,
        tool_call_id: None,
        partial: None,
    };

    let dumped = strip_nulls(serde_json::to_value(&message).unwrap());
    assert_eq!(
        dumped,
        json!({
            "role": "user",
            "content": "Hello, world!",
        })
    );
    let parsed: Message = serde_json::from_value(dumped).unwrap();
    assert_eq!(parsed, message);
}

#[test]
fn message_with_single_part() {
    let message = Message {
        role: Role::Assistant,
        content: vec![ContentPart::ImageUrl(ImageURLPart::new(
            "https://example.com/image.png",
        ))],
        name: None,
        tool_calls: None,
        tool_call_id: None,
        partial: None,
    };

    let dumped = strip_nulls(serde_json::to_value(&message).unwrap());
    assert_eq!(
        dumped,
        json!({
            "role": "assistant",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png"}
                }
            ]
        })
    );
    let parsed: Message = serde_json::from_value(dumped).unwrap();
    assert_eq!(parsed, message);
}

#[test]
fn message_with_tool_calls() {
    let message = Message {
        role: Role::Assistant,
        content: vec![ContentPart::Text(TextPart::new("Hello, world!"))],
        name: None,
        tool_calls: Some(vec![tool_call("123", "function", Some("{}"))]),
        tool_call_id: None,
        partial: None,
    };

    let dumped = strip_nulls(serde_json::to_value(&message).unwrap());
    assert_eq!(
        dumped,
        json!({
            "role": "assistant",
            "content": "Hello, world!",
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "function", "arguments": "{}"}
                }
            ]
        })
    );
    let parsed: Message = serde_json::from_value(dumped).unwrap();
    assert_eq!(parsed, message);
}

#[test]
fn message_with_no_content() {
    let message = Message {
        role: Role::Assistant,
        content: Vec::new(),
        name: None,
        tool_calls: Some(vec![tool_call("123", "function", Some("{}"))]),
        tool_call_id: None,
        partial: None,
    };

    let dumped = strip_nulls(serde_json::to_value(&message).unwrap());
    assert_eq!(
        dumped,
        json!({
            "role": "assistant",
            "content": [],
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "function", "arguments": "{}"}
                }
            ]
        })
    );
}

#[test]
fn message_with_complex_content() {
    let message = Message {
        role: Role::User,
        content: vec![
            ContentPart::Text(TextPart::new("Hello, world!")),
            ContentPart::Think(ThinkPart {
                kind: "think".to_string(),
                think: "I think I need to think about this.".to_string(),
                encrypted: None,
            }),
            ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.png")),
            ContentPart::AudioUrl(AudioURLPart::new("https://example.com/audio.mp3")),
            ContentPart::VideoUrl(VideoURLPart::new("https://example.com/video.mp4")),
        ],
        name: None,
        tool_calls: Some(vec![tool_call("123", "function", Some("{}"))]),
        tool_call_id: None,
        partial: None,
    };

    let dumped = strip_nulls(serde_json::to_value(&message).unwrap());
    assert_eq!(
        dumped,
        json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello, world!"},
                {"type": "think", "think": "I think I need to think about this."},
                {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}},
                {"type": "audio_url", "audio_url": {"url": "https://example.com/audio.mp3"}},
                {"type": "video_url", "video_url": {"url": "https://example.com/video.mp4"}}
            ],
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "function", "arguments": "{}"}
                }
            ]
        })
    );
    let parsed: Message = serde_json::from_value(dumped).unwrap();
    assert_eq!(parsed, message);
}

#[test]
fn deserialize_from_json_plain_text() {
    let data = json!({
        "role": "user",
        "content": "Hello, world!",
    });
    let message: Message = serde_json::from_value(data).unwrap();
    let expected = Message {
        role: Role::User,
        content: vec![ContentPart::Text(TextPart::new("Hello, world!"))],
        name: None,
        tool_calls: None,
        tool_call_id: None,
        partial: None,
    };
    assert_eq!(message, expected);
}

#[test]
fn deserialize_from_json_with_content_and_tool_calls() {
    let data = json!({
        "role": "assistant",
        "content": [{"type": "text", "text": "Hello, world!"}],
        "tool_calls": [
            {
                "type": "function",
                "id": "tc_123",
                "function": {"name": "do_something", "arguments": "{\"x\":1}"}
            }
        ]
    });
    let message: Message = serde_json::from_value(data).unwrap();
    let expected = Message {
        role: Role::Assistant,
        content: vec![ContentPart::Text(TextPart::new("Hello, world!"))],
        name: None,
        tool_calls: Some(vec![tool_call("tc_123", "do_something", Some("{\"x\":1}"))]),
        tool_call_id: None,
        partial: None,
    };
    assert_eq!(message, expected);
}

#[test]
fn deserialize_from_json_none_content_with_tool_calls() {
    let data = json!({
        "role": "assistant",
        "content": null,
        "tool_calls": [
            {
                "type": "function",
                "id": "tc_456",
                "function": {"name": "do_other", "arguments": "{}"}
            }
        ]
    });
    let message: Message = serde_json::from_value(data).unwrap();
    let expected = Message {
        role: Role::Assistant,
        content: Vec::new(),
        name: None,
        tool_calls: Some(vec![tool_call("tc_456", "do_other", Some("{}"))]),
        tool_call_id: None,
        partial: None,
    };
    assert_eq!(message, expected);
}

#[test]
fn deserialize_from_json_with_content_but_no_tool_calls() {
    let data = json!({
        "role": "user",
        "content": [{"type": "text", "text": "Only content, no tools."}],
    });
    let message: Message = serde_json::from_value(data).unwrap();
    let expected = Message {
        role: Role::User,
        content: vec![ContentPart::Text(TextPart::new("Only content, no tools."))],
        name: None,
        tool_calls: None,
        tool_call_id: None,
        partial: None,
    };
    assert_eq!(message, expected);
}

#[test]
fn message_with_empty_list_content() {
    let message = Message {
        role: Role::Assistant,
        content: Vec::new(),
        name: None,
        tool_calls: None,
        tool_call_id: None,
        partial: None,
    };

    let dumped = serde_json::to_value(&message).unwrap();
    assert_eq!(
        dumped,
        json!({
            "role": "assistant",
            "content": [],
            "name": null,
            "tool_calls": null,
            "tool_call_id": null,
            "partial": null,
        })
    );

    let parsed: Message = serde_json::from_value(dumped).unwrap();
    assert_eq!(parsed, message);

    let message_with_tools = Message {
        role: Role::Assistant,
        content: Vec::new(),
        name: None,
        tool_calls: Some(vec![tool_call("123", "test_func", Some("{}"))]),
        tool_call_id: None,
        partial: None,
    };
    let dumped = serde_json::to_value(&message_with_tools).unwrap();
    assert_eq!(
        dumped,
        json!({
            "role": "assistant",
            "content": [],
            "name": null,
            "tool_calls": [
                {
                    "type": "function",
                    "id": "123",
                    "function": {"name": "test_func", "arguments": "{}"},
                    "extras": null
                }
            ],
            "tool_call_id": null,
            "partial": null,
        })
    );

    let parsed: Message = serde_json::from_value(dumped).unwrap();
    assert_eq!(parsed, message_with_tools);
}

#[test]
fn message_extract_text() {
    let message = Message {
        role: Role::User,
        content: vec![
            ContentPart::Text(TextPart::new("Hello, ")),
            ContentPart::Text(TextPart::new("world")),
            ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.png")),
            ContentPart::Text(TextPart::new("!")),
            ContentPart::Think(ThinkPart::new("This is a thought.")),
        ],
        name: None,
        tool_calls: None,
        tool_call_id: None,
        partial: None,
    };
    let extracted = message.extract_text(" ");
    assert_eq!(extracted, "Hello,  world !");
    let extracted = message.extract_text("\n");
    assert_eq!(extracted, "Hello, \nworld\n!");
}
