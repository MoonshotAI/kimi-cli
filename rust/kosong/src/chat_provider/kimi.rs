use std::any::Any;
use std::collections::VecDeque;
use std::env;
use std::pin::Pin;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::chat_provider::{
    ChatProvider, ChatProviderError, ChatProviderErrorKind, StreamedMessage, ThinkingEffort,
    TokenUsage,
};
use crate::message::{
    ContentPart, Message, StreamedMessagePart, TextPart, ThinkPart, ToolCall, ToolCallFunction,
    ToolCallPart, VideoURL, VideoURLPart,
};
use crate::tooling::Tool;

#[derive(Clone)]
pub struct Kimi {
    model: String,
    api_key: String,
    base_url: Url,
    stream: bool,
    client: Client,
    generation_kwargs: Map<String, Value>,
}

impl Kimi {
    pub fn new(
        model: impl Into<String>,
        api_key: Option<String>,
        base_url: Option<String>,
        default_headers: Option<HeaderMap>,
    ) -> Result<Self, ChatProviderError> {
        let api_key = api_key
            .or_else(|| env::var("KIMI_API_KEY").ok())
            .ok_or_else(|| {
                ChatProviderError::new(
                    ChatProviderErrorKind::Other,
                    "The api_key client option or the KIMI_API_KEY environment variable is not set",
                )
            })?;
        let mut base_url = base_url
            .or_else(|| env::var("KIMI_BASE_URL").ok())
            .unwrap_or_else(|| "https://api.moonshot.ai/v1".to_string());
        if !base_url.ends_with('/') {
            base_url.push('/');
        }
        let base_url = Url::parse(&base_url).map_err(|err| {
            ChatProviderError::new(
                ChatProviderErrorKind::Other,
                format!("Invalid base URL: {err}"),
            )
        })?;

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(USER_AGENT, HeaderValue::from_static("KimiCLI"));
        if let Some(extra) = default_headers {
            for (k, v) in extra.iter() {
                if let Some(value) = v.to_str().ok() {
                    headers.insert(
                        k,
                        HeaderValue::from_str(value).unwrap_or_else(|_| v.clone()),
                    );
                } else {
                    headers.insert(k, v.clone());
                }
            }
        }

        let client = Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|err| ChatProviderError::new(ChatProviderErrorKind::Other, err.to_string()))?;

        Ok(Self {
            model: model.into(),
            api_key,
            base_url,
            stream: true,
            client,
            generation_kwargs: Map::new(),
        })
    }

    pub fn with_stream(mut self, stream: bool) -> Self {
        self.stream = stream;
        self
    }

    pub fn with_generation_kwargs(mut self, kwargs: Map<String, Value>) -> Self {
        for (k, v) in kwargs {
            self.generation_kwargs.insert(k, v);
        }
        self
    }

    pub fn with_extra_body(mut self, extra_body: Value) -> Self {
        let mut merged = Map::new();
        if let Some(Value::Object(existing)) = self.generation_kwargs.get("extra_body") {
            for (k, v) in existing {
                merged.insert(k.clone(), v.clone());
            }
        }
        if let Value::Object(extra) = extra_body {
            for (k, v) in extra {
                merged.insert(k, v);
            }
        }
        self.generation_kwargs
            .insert("extra_body".to_string(), Value::Object(merged));
        self
    }

    pub fn model_parameters(&self) -> Map<String, Value> {
        let mut params = Map::new();
        params.insert(
            "base_url".to_string(),
            Value::String(self.base_url.to_string()),
        );
        for (k, v) in &self.generation_kwargs {
            params.insert(k.clone(), v.clone());
        }
        params
    }

    pub fn files(&self) -> KimiFiles {
        KimiFiles {
            client: self.client.clone(),
            api_key: self.api_key.clone(),
            base_url: self.base_url.clone(),
        }
    }
}

#[async_trait]
impl ChatProvider for Kimi {
    fn name(&self) -> &str {
        "kimi"
    }

    fn model_name(&self) -> &str {
        &self.model
    }

    fn thinking_effort(&self) -> Option<ThinkingEffort> {
        match self.generation_kwargs.get("reasoning_effort") {
            Some(Value::String(value)) => match value.as_str() {
                "low" => Some(ThinkingEffort::Low),
                "medium" => Some(ThinkingEffort::Medium),
                "high" => Some(ThinkingEffort::High),
                _ => Some(ThinkingEffort::Off),
            },
            _ => None,
        }
    }

    async fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
    ) -> Result<Box<dyn StreamedMessage>, ChatProviderError> {
        let mut messages = Vec::new();
        if !system_prompt.is_empty() {
            messages.push(json!({"role": "system", "content": system_prompt}));
        }
        for message in history {
            messages.push(convert_message(message)?);
        }

        let mut tool_defs = Vec::new();
        for tool in tools {
            tool_defs.push(convert_tool(tool));
        }

        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(self.model.clone()));
        body.insert("messages".to_string(), Value::Array(messages));
        body.insert("tools".to_string(), Value::Array(tool_defs));
        body.insert("stream".to_string(), Value::Bool(self.stream));
        if self.stream {
            body.insert("stream_options".to_string(), json!({"include_usage": true}));
        }
        let mut generation_kwargs = Map::new();
        generation_kwargs.insert("max_tokens".to_string(), Value::from(32000));
        for (k, v) in &self.generation_kwargs {
            generation_kwargs.insert(k.clone(), v.clone());
        }
        let extra_body = match generation_kwargs.remove("extra_body") {
            Some(Value::Object(map)) => Some(map),
            _ => None,
        };

        for (k, v) in generation_kwargs {
            body.insert(k, v);
        }
        if let Some(extra_body) = extra_body {
            for (k, v) in extra_body {
                body.insert(k, v);
            }
        }

        let url = self
            .base_url
            .join("chat/completions")
            .map_err(|err| ChatProviderError::new(ChatProviderErrorKind::Other, err.to_string()))?;

        let resp = self
            .client
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Status(status.as_u16()),
                format!("Kimi API error ({status}): {text}"),
            ));
        }

        if self.stream {
            Ok(Box::new(KimiStreamedMessage::new_stream(resp)))
        } else {
            let value: Value = resp.json().await.map_err(map_reqwest_error)?;
            let (parts, message_id, usage) = parse_non_stream_response(&value)?;
            Ok(Box::new(KimiStreamedMessage::new_parts(
                parts, message_id, usage,
            )))
        }
    }

    fn with_thinking(&self, effort: ThinkingEffort) -> Box<dyn ChatProvider> {
        let mut kwargs = Map::new();
        let reasoning_effort = match effort {
            ThinkingEffort::Off => None,
            ThinkingEffort::Low => Some("low"),
            ThinkingEffort::Medium => Some("medium"),
            ThinkingEffort::High => Some("high"),
        };
        if let Some(value) = reasoning_effort {
            kwargs.insert(
                "reasoning_effort".to_string(),
                Value::String(value.to_string()),
            );
        } else {
            kwargs.insert("reasoning_effort".to_string(), Value::Null);
        }

        let mut extra_body = Map::new();
        extra_body.insert(
            "thinking".to_string(),
            json!({"type": if matches!(effort, ThinkingEffort::Off) {"disabled"} else {"enabled"}}),
        );

        let provider = self
            .clone()
            .with_generation_kwargs(kwargs)
            .with_extra_body(Value::Object(extra_body));
        Box::new(provider)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct KimiFiles {
    client: Client,
    api_key: String,
    base_url: Url,
}

impl KimiFiles {
    pub async fn upload_video(
        &self,
        data: Vec<u8>,
        mime_type: &str,
    ) -> Result<VideoURLPart, ChatProviderError> {
        if !mime_type.starts_with("video/") {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                format!("Expected a video mime type, got {mime_type}"),
            ));
        }
        let filename = guess_filename(mime_type);
        let form = reqwest::multipart::Form::new()
            .text("purpose", "video")
            .part(
                "file",
                reqwest::multipart::Part::bytes(data)
                    .file_name(filename)
                    .mime_str(mime_type)
                    .map_err(|err| {
                        ChatProviderError::new(ChatProviderErrorKind::Other, err.to_string())
                    })?,
            );

        let url = self
            .base_url
            .join("files")
            .map_err(|err| ChatProviderError::new(ChatProviderErrorKind::Other, err.to_string()))?;

        let resp = self
            .client
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
            .multipart(form)
            .send()
            .await
            .map_err(map_reqwest_error)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Status(status.as_u16()),
                format!("Kimi file upload error ({status}): {text}"),
            ));
        }

        let value: Value = resp.json().await.map_err(map_reqwest_error)?;
        let file_id = value.get("id").and_then(|v| v.as_str()).ok_or_else(|| {
            ChatProviderError::new(ChatProviderErrorKind::Other, "Missing file id")
        })?;
        Ok(VideoURLPart {
            kind: "video_url".to_string(),
            video_url: VideoURL {
                url: format!("ms://{file_id}"),
                id: None,
            },
        })
    }
}

pub struct KimiStreamedMessage {
    stream: Option<Pin<Box<dyn futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send>>>,
    buffer: String,
    parts: VecDeque<StreamedMessagePart>,
    id: Option<String>,
    usage: Option<TokenUsage>,
}

impl KimiStreamedMessage {
    pub fn new_stream(resp: reqwest::Response) -> Self {
        let stream = resp.bytes_stream();
        Self {
            stream: Some(Box::pin(stream)),
            buffer: String::new(),
            parts: VecDeque::new(),
            id: None,
            usage: None,
        }
    }

    pub fn new_parts(
        parts: Vec<StreamedMessagePart>,
        id: Option<String>,
        usage: Option<TokenUsage>,
    ) -> Self {
        Self {
            stream: None,
            buffer: String::new(),
            parts: parts.into(),
            id,
            usage,
        }
    }

    fn ingest_chunk(&mut self, value: &Value) -> Result<(), ChatProviderError> {
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            self.id = Some(id.to_string());
        }
        let usage_value = value.get("usage").or_else(|| {
            value
                .get("choices")
                .and_then(|v| v.as_array())
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("usage"))
        });
        if let Some(usage) = usage_value {
            if let Some(parsed) = parse_usage(usage) {
                self.usage = Some(parsed);
            }
        }
        if let Some(choices) = value.get("choices").and_then(|v| v.as_array()) {
            for choice in choices {
                if let Some(delta) = choice.get("delta") {
                    ingest_delta(delta, &mut self.parts);
                }
            }
        }
        Ok(())
    }
}

#[async_trait]
impl StreamedMessage for KimiStreamedMessage {
    async fn next_part(&mut self) -> Result<Option<StreamedMessagePart>, ChatProviderError> {
        loop {
            if let Some(part) = self.parts.pop_front() {
                return Ok(Some(part));
            }
            let stream = match &mut self.stream {
                Some(stream) => stream,
                None => return Ok(None),
            };
            match stream.next().await {
                Some(Ok(bytes)) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    self.buffer.push_str(&chunk);
                    while let Some(pos) = self.buffer.find('\n') {
                        let line = self.buffer[..pos].trim().to_string();
                        self.buffer = self.buffer[pos + 1..].to_string();
                        if line.is_empty() {
                            continue;
                        }
                        if let Some(data) = line.strip_prefix("data: ") {
                            if data.trim() == "[DONE]" {
                                self.stream = None;
                                return Ok(None);
                            }
                            let value: Value = serde_json::from_str(data).map_err(|err| {
                                ChatProviderError::new(
                                    ChatProviderErrorKind::Other,
                                    err.to_string(),
                                )
                            })?;
                            self.ingest_chunk(&value)?;
                        }
                    }
                }
                Some(Err(err)) => return Err(map_reqwest_error(err)),
                None => {
                    self.stream = None;
                    return Ok(None);
                }
            }
        }
    }

    fn id(&self) -> Option<String> {
        self.id.clone()
    }

    fn usage(&self) -> Option<TokenUsage> {
        self.usage.clone()
    }
}

fn convert_message(message: &Message) -> Result<Value, ChatProviderError> {
    let mut reasoning_content = String::new();
    let mut content_parts = Vec::new();
    for part in &message.content {
        match part {
            ContentPart::Think(think) => {
                reasoning_content.push_str(&think.think);
            }
            _ => content_parts.push(part.clone()),
        }
    }

    let payload = serde_json::to_value(Message {
        role: message.role.clone(),
        content: content_parts,
        name: message.name.clone(),
        tool_calls: message.tool_calls.clone(),
        tool_call_id: message.tool_call_id.clone(),
        partial: message.partial,
    })
    .map_err(|err| ChatProviderError::new(ChatProviderErrorKind::Other, err.to_string()))?;

    let mut payload = strip_nulls(payload);
    if !reasoning_content.is_empty() {
        if let Value::Object(map) = &mut payload {
            map.insert(
                "reasoning_content".to_string(),
                Value::String(reasoning_content),
            );
        }
    }
    Ok(payload)
}

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

fn convert_tool(tool: &Tool) -> Value {
    if tool.name.starts_with('$') {
        json!({
            "type": "builtin_function",
            "function": {"name": tool.name},
        })
    } else {
        json!({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
        })
    }
}

fn parse_non_stream_response(
    value: &Value,
) -> Result<(Vec<StreamedMessagePart>, Option<String>, Option<TokenUsage>), ChatProviderError> {
    let message_id = value
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let usage = value.get("usage").and_then(parse_usage);

    let choices = value
        .get("choices")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            ChatProviderError::new(ChatProviderErrorKind::Other, "Missing choices in response")
        })?;
    if choices.is_empty() {
        return Err(ChatProviderError::new(
            ChatProviderErrorKind::EmptyResponse,
            "The API returned an empty response.",
        ));
    }
    let message = choices[0].get("message").ok_or_else(|| {
        ChatProviderError::new(ChatProviderErrorKind::Other, "Missing message in response")
    })?;

    let mut parts = Vec::new();
    if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        parts.push(StreamedMessagePart::Content(ContentPart::Think(
            ThinkPart {
                kind: "think".to_string(),
                think: reasoning.to_string(),
                encrypted: None,
            },
        )));
    }
    if let Some(content) = message.get("content").and_then(|v| v.as_str()) {
        if !content.is_empty() {
            parts.push(StreamedMessagePart::Content(ContentPart::Text(
                TextPart::new(content),
            )));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for tool_call in tool_calls {
            if let Some(call) = parse_tool_call(tool_call) {
                parts.push(StreamedMessagePart::ToolCall(call));
            }
        }
    }

    Ok((parts, message_id, usage))
}

fn ingest_delta(delta: &Value, parts: &mut VecDeque<StreamedMessagePart>) {
    if let Some(reasoning) = delta
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        parts.push_back(StreamedMessagePart::Content(ContentPart::Think(
            ThinkPart {
                kind: "think".to_string(),
                think: reasoning.to_string(),
                encrypted: None,
            },
        )));
    }
    if let Some(content) = delta
        .get("content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        parts.push_back(StreamedMessagePart::Content(ContentPart::Text(
            TextPart::new(content),
        )));
    }
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tool_call in tool_calls {
            if let Some(part) = parse_tool_call_delta(tool_call) {
                parts.push_back(part);
            }
        }
    }
}

fn parse_tool_call(tool_call: &Value) -> Option<ToolCall> {
    let function = tool_call.get("function")?;
    let name = function.get("name")?.as_str()?.to_string();
    let arguments = function
        .get("arguments")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let id = tool_call
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    Some(ToolCall {
        kind: "function".to_string(),
        id,
        function: ToolCallFunction { name, arguments },
        extras: None,
    })
}

fn parse_tool_call_delta(tool_call: &Value) -> Option<StreamedMessagePart> {
    let function = tool_call.get("function")?;
    let name = function
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let arguments = function
        .get("arguments")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    if let Some(name) = name {
        let id = tool_call
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let call = ToolCall {
            kind: "function".to_string(),
            id,
            function: ToolCallFunction {
                name: name.to_string(),
                arguments: arguments.map(|s| s.to_string()),
            },
            extras: None,
        };
        return Some(StreamedMessagePart::ToolCall(call));
    }
    if let Some(arguments) = arguments {
        let part = ToolCallPart {
            arguments_part: Some(arguments.to_string()),
        };
        return Some(StreamedMessagePart::ToolCallPart(part));
    }
    None
}

fn parse_usage(value: &Value) -> Option<TokenUsage> {
    let prompt_tokens = value.get("prompt_tokens")?.as_i64()?;
    let completion_tokens = value.get("completion_tokens")?.as_i64()?;
    let mut cached = 0i64;
    if let Some(cached_tokens) = value.get("cached_tokens").and_then(|v| v.as_i64()) {
        cached = cached_tokens;
    } else if let Some(details) = value.get("prompt_tokens_details") {
        if let Some(cached_tokens) = details.get("cached_tokens").and_then(|v| v.as_i64()) {
            cached = cached_tokens;
        }
    }
    let input_other = if prompt_tokens >= cached {
        prompt_tokens - cached
    } else {
        0
    };
    Some(TokenUsage {
        input_other,
        output: completion_tokens,
        input_cache_read: cached,
        input_cache_creation: 0,
    })
}

fn guess_filename(mime_type: &str) -> String {
    let extension = match mime_type {
        "video/mp4" => ".mp4",
        "video/quicktime" => ".mov",
        "video/webm" => ".webm",
        _ => ".bin",
    };
    format!("upload{}", extension)
}

fn map_reqwest_error(err: reqwest::Error) -> ChatProviderError {
    if err.is_timeout() {
        ChatProviderError::new(ChatProviderErrorKind::Timeout, err.to_string())
    } else if err.is_connect() {
        ChatProviderError::new(ChatProviderErrorKind::Connection, err.to_string())
    } else {
        ChatProviderError::new(ChatProviderErrorKind::Other, err.to_string())
    }
}
