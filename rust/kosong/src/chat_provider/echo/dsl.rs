use serde_json::Value;

use crate::chat_provider::{ChatProviderError, ChatProviderErrorKind, TokenUsage};
use crate::message::{
    AudioURL, AudioURLPart, ContentPart, ImageURL, ImageURLPart, StreamedMessagePart, TextPart,
    ThinkPart, ToolCall, ToolCallFunction, ToolCallPart, VideoURL, VideoURLPart,
};

pub fn parse_echo_script(
    script: &str,
) -> Result<(Vec<StreamedMessagePart>, Option<String>, Option<TokenUsage>), ChatProviderError> {
    let mut parts = Vec::new();
    let mut message_id = None;
    let mut usage = None;

    for (lineno, raw_line) in script.lines().enumerate() {
        let line_no = lineno + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("```") {
            continue;
        }
        if line.to_lowercase() == "echo" {
            continue;
        }
        let mut iter = line.splitn(2, ':');
        let key = iter.next().unwrap_or("");
        let payload = iter.next();
        if payload.is_none() {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                format!("Invalid echo DSL at line {}: {:?}", line_no, raw_line),
            ));
        }
        let kind = key.trim().to_lowercase();
        let mut payload = payload.unwrap();
        if payload.starts_with(' ') {
            payload = &payload[1..];
        }
        match kind.as_str() {
            "id" => {
                message_id = Some(strip_quotes(payload.trim()).to_string());
            }
            "usage" => {
                usage = Some(parse_usage(payload)?);
            }
            _ => {
                let part = parse_part(kind.as_str(), payload, line_no, raw_line)?;
                parts.push(part);
            }
        }
    }

    Ok((parts, message_id, usage))
}

fn parse_part(
    kind: &str,
    payload: &str,
    line_no: usize,
    raw_line: &str,
) -> Result<StreamedMessagePart, ChatProviderError> {
    match kind {
        "text" => Ok(StreamedMessagePart::Content(ContentPart::Text(
            TextPart::new(strip_quotes(payload)),
        ))),
        "think" => Ok(StreamedMessagePart::Content(ContentPart::Think(
            ThinkPart::new(strip_quotes(payload)),
        ))),
        "image_url" => {
            let (url, content_id) = parse_url_payload(payload, kind)?;
            Ok(StreamedMessagePart::Content(ContentPart::ImageUrl(
                ImageURLPart {
                    kind: "image_url".to_string(),
                    image_url: ImageURL {
                        url,
                        id: content_id,
                    },
                },
            )))
        }
        "audio_url" => {
            let (url, content_id) = parse_url_payload(payload, kind)?;
            Ok(StreamedMessagePart::Content(ContentPart::AudioUrl(
                AudioURLPart {
                    kind: "audio_url".to_string(),
                    audio_url: AudioURL {
                        url,
                        id: content_id,
                    },
                },
            )))
        }
        "video_url" => {
            let (url, content_id) = parse_url_payload(payload, kind)?;
            Ok(StreamedMessagePart::Content(ContentPart::VideoUrl(
                VideoURLPart {
                    kind: "video_url".to_string(),
                    video_url: VideoURL {
                        url,
                        id: content_id,
                    },
                },
            )))
        }
        "tool_call" => Ok(StreamedMessagePart::ToolCall(parse_tool_call(
            payload, line_no, raw_line,
        )?)),
        "tool_call_part" => Ok(StreamedMessagePart::ToolCallPart(parse_tool_call_part(
            payload,
        )?)),
        _ => Err(ChatProviderError::new(
            ChatProviderErrorKind::Other,
            format!(
                "Unknown echo DSL kind '{}' at line {}: {:?}",
                kind, line_no, raw_line
            ),
        )),
    }
}

fn parse_usage(payload: &str) -> Result<TokenUsage, ChatProviderError> {
    let mapping = parse_mapping(payload, "usage")?;
    let int_value = |key: &str| -> Result<i64, ChatProviderError> {
        let value = mapping.get(key).cloned().unwrap_or(Value::from(0));
        match value {
            Value::Number(n) => n.as_i64().ok_or_else(|| {
                ChatProviderError::new(
                    ChatProviderErrorKind::Other,
                    format!("Usage field '{}' must be integer", key),
                )
            }),
            Value::String(s) => s.parse::<i64>().map_err(|_| {
                ChatProviderError::new(
                    ChatProviderErrorKind::Other,
                    format!("Usage field '{}' must be integer", key),
                )
            }),
            _ => Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                format!("Usage field '{}' must be integer", key),
            )),
        }
    };

    Ok(TokenUsage {
        input_other: int_value("input_other")?,
        output: int_value("output")?,
        input_cache_read: int_value("input_cache_read")?,
        input_cache_creation: int_value("input_cache_creation")?,
    })
}

fn parse_url_payload(
    payload: &str,
    kind: &str,
) -> Result<(String, Option<String>), ChatProviderError> {
    let value = parse_value(payload);
    match value {
        Value::Object(map) => {
            let url = map.get("url").and_then(|v| v.as_str()).ok_or_else(|| {
                ChatProviderError::new(
                    ChatProviderErrorKind::Other,
                    format!("{} requires a url field", kind),
                )
            })?;
            let content_id = map
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok((url.to_string(), content_id))
        }
        Value::String(s) => Ok((s, None)),
        _ => Err(ChatProviderError::new(
            ChatProviderErrorKind::Other,
            format!("{} expects url string or object", kind),
        )),
    }
}

fn parse_tool_call(
    payload: &str,
    line_no: usize,
    raw_line: &str,
) -> Result<ToolCall, ChatProviderError> {
    let mapping = parse_mapping(payload, "tool_call")?;
    let function = mapping.get("function").and_then(|v| v.as_object());
    let tool_call_id = mapping
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut name = mapping
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut arguments = mapping
        .get("arguments")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let extras = mapping
        .get("extras")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect()
        });

    if let Some(func) = function {
        if name.is_none() {
            name = func
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        if arguments.is_none() {
            arguments = func
                .get("arguments")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }

    if tool_call_id.is_none() || name.is_none() {
        return Err(ChatProviderError::new(
            ChatProviderErrorKind::Other,
            format!(
                "tool_call requires string id and name at line {}: {:?}",
                line_no, raw_line
            ),
        ));
    }

    Ok(ToolCall {
        kind: "function".to_string(),
        id: tool_call_id.unwrap(),
        function: ToolCallFunction {
            name: name.unwrap(),
            arguments,
        },
        extras,
    })
}

fn parse_tool_call_part(payload: &str) -> Result<ToolCallPart, ChatProviderError> {
    let value = parse_value(payload);
    let arguments_part = if let Value::Object(map) = value {
        map.get("arguments_part").cloned().unwrap_or(Value::Null)
    } else {
        value
    };
    let arguments_part = match arguments_part {
        Value::Null => None,
        Value::String(s) => Some(s),
        Value::Array(_) | Value::Object(_) => {
            Some(serde_json::to_string(&arguments_part).unwrap_or_default())
        }
        other => Some(other.to_string()),
    };
    Ok(ToolCallPart { arguments_part })
}

fn parse_mapping(
    payload: &str,
    context: &str,
) -> Result<serde_json::Map<String, Value>, ChatProviderError> {
    let trimmed = payload.trim();
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
        return Ok(map);
    }
    if let Ok(_value) = serde_json::from_str::<Value>(trimmed) {
        return Err(ChatProviderError::new(
            ChatProviderErrorKind::Other,
            format!("{} payload must be an object", context),
        ));
    }

    let mut mapping = serde_json::Map::new();
    for token in trimmed.replace(',', " ").split_whitespace() {
        if !token.contains('=') {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                format!("Invalid token '{}' in {} payload", token, context),
            ));
        }
        let mut parts = token.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        mapping.insert(key.trim().to_string(), parse_value(value.trim()));
    }

    if mapping.is_empty() {
        return Err(ChatProviderError::new(
            ChatProviderErrorKind::Other,
            format!("{} payload cannot be empty", context),
        ));
    }

    Ok(mapping)
}

fn parse_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Value::Null;
    }
    let lowered = trimmed.to_lowercase();
    if lowered == "null" || lowered == "none" {
        return Value::Null;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return value;
    }
    Value::String(strip_quotes(trimmed).to_string())
}

fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == bytes[bytes.len() - 1]
        && (bytes[0] == b'\'' || bytes[0] == b'\"')
    {
        return &value[1..value.len() - 1];
    }
    value
}
