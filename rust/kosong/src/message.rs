use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::utils::typing::JsonValue;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContentPart {
    Text(TextPart),
    Think(ThinkPart),
    ImageUrl(ImageURLPart),
    AudioUrl(AudioURLPart),
    VideoUrl(VideoURLPart),
}

impl ContentPart {
    pub fn merge_in_place(&mut self, other: &ContentPart) -> bool {
        match (self, other) {
            (ContentPart::Text(left), ContentPart::Text(right)) => {
                left.text.push_str(&right.text);
                true
            }
            (ContentPart::Think(left), ContentPart::Think(right)) => {
                if left.encrypted.is_some() {
                    return false;
                }
                left.think.push_str(&right.think);
                if right.encrypted.is_some() {
                    left.encrypted = right.encrypted.clone();
                }
                true
            }
            _ => false,
        }
    }
}

impl Serialize for ContentPart {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            ContentPart::Text(part) => part.serialize(serializer),
            ContentPart::Think(part) => part.serialize(serializer),
            ContentPart::ImageUrl(part) => part.serialize(serializer),
            ContentPart::AudioUrl(part) => part.serialize(serializer),
            ContentPart::VideoUrl(part) => part.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ContentPart {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let kind = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::custom("ContentPart missing type"))?;
        match kind {
            "text" => Ok(ContentPart::Text(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "think" => Ok(ContentPart::Think(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "image_url" => Ok(ContentPart::ImageUrl(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "audio_url" => Ok(ContentPart::AudioUrl(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "video_url" => Ok(ContentPart::VideoUrl(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            _ => Err(serde::de::Error::custom(format!(
                "Unknown ContentPart type: {kind}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextPart {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

impl TextPart {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            kind: "text".to_string(),
            text: text.into(),
        }
    }
}

impl From<TextPart> for ContentPart {
    fn from(part: TextPart) -> Self {
        ContentPart::Text(part)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkPart {
    #[serde(rename = "type")]
    pub kind: String,
    pub think: String,
    pub encrypted: Option<String>,
}

impl ThinkPart {
    pub fn new(think: impl Into<String>) -> Self {
        Self {
            kind: "think".to_string(),
            think: think.into(),
            encrypted: None,
        }
    }
}

impl From<ThinkPart> for ContentPart {
    fn from(part: ThinkPart) -> Self {
        ContentPart::Think(part)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageURLPart {
    #[serde(rename = "type")]
    pub kind: String,
    pub image_url: ImageURL,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageURL {
    pub url: String,
    pub id: Option<String>,
}

impl ImageURLPart {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            kind: "image_url".to_string(),
            image_url: ImageURL {
                url: url.into(),
                id: None,
            },
        }
    }
}

impl From<ImageURLPart> for ContentPart {
    fn from(part: ImageURLPart) -> Self {
        ContentPart::ImageUrl(part)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioURLPart {
    #[serde(rename = "type")]
    pub kind: String,
    pub audio_url: AudioURL,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioURL {
    pub url: String,
    pub id: Option<String>,
}

impl AudioURLPart {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            kind: "audio_url".to_string(),
            audio_url: AudioURL {
                url: url.into(),
                id: None,
            },
        }
    }
}

impl From<AudioURLPart> for ContentPart {
    fn from(part: AudioURLPart) -> Self {
        ContentPart::AudioUrl(part)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoURLPart {
    #[serde(rename = "type")]
    pub kind: String,
    pub video_url: VideoURL,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoURL {
    pub url: String,
    pub id: Option<String>,
}

impl VideoURLPart {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            kind: "video_url".to_string(),
            video_url: VideoURL {
                url: url.into(),
                id: None,
            },
        }
    }
}

impl From<VideoURLPart> for ContentPart {
    fn from(part: VideoURLPart) -> Self {
        ContentPart::VideoUrl(part)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub function: ToolCallFunction,
    pub extras: Option<std::collections::BTreeMap<String, JsonValue>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: Option<String>,
}

impl ToolCall {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            kind: "function".to_string(),
            id: id.into(),
            function: ToolCallFunction {
                name: name.into(),
                arguments: None,
            },
            extras: None,
        }
    }

    pub fn merge_in_place(&mut self, other: &ToolCallPart) -> bool {
        if self.function.arguments.is_none() {
            self.function.arguments = other.arguments_part.clone();
        } else if let Some(ref mut args) = self.function.arguments {
            if let Some(part) = &other.arguments_part {
                args.push_str(part);
            }
        }
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallPart {
    pub arguments_part: Option<String>,
}

impl ToolCallPart {
    pub fn merge_in_place(&mut self, other: &ToolCallPart) -> bool {
        if self.arguments_part.is_none() {
            self.arguments_part = other.arguments_part.clone();
        } else if let Some(ref mut args) = self.arguments_part {
            if let Some(part) = &other.arguments_part {
                args.push_str(part);
            }
        }
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamedMessagePart {
    Content(ContentPart),
    ToolCall(ToolCall),
    ToolCallPart(ToolCallPart),
}

impl From<ContentPart> for StreamedMessagePart {
    fn from(part: ContentPart) -> Self {
        StreamedMessagePart::Content(part)
    }
}

impl From<ToolCall> for StreamedMessagePart {
    fn from(call: ToolCall) -> Self {
        StreamedMessagePart::ToolCall(call)
    }
}

impl From<ToolCallPart> for StreamedMessagePart {
    fn from(part: ToolCallPart) -> Self {
        StreamedMessagePart::ToolCallPart(part)
    }
}

impl StreamedMessagePart {
    pub fn merge_in_place(&mut self, other: &StreamedMessagePart) -> bool {
        match (self, other) {
            (
                StreamedMessagePart::Content(ContentPart::Text(left)),
                StreamedMessagePart::Content(ContentPart::Text(right)),
            ) => {
                left.text.push_str(&right.text);
                true
            }
            (
                StreamedMessagePart::Content(ContentPart::Think(left)),
                StreamedMessagePart::Content(ContentPart::Think(right)),
            ) => {
                if left.encrypted.is_some() {
                    return false;
                }
                left.think.push_str(&right.think);
                if right.encrypted.is_some() {
                    left.encrypted = right.encrypted.clone();
                }
                true
            }
            (StreamedMessagePart::ToolCall(left), StreamedMessagePart::ToolCallPart(right)) => {
                left.merge_in_place(right)
            }
            (StreamedMessagePart::ToolCallPart(left), StreamedMessagePart::ToolCallPart(right)) => {
                left.merge_in_place(right)
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    #[serde(
        default,
        serialize_with = "serialize_content",
        deserialize_with = "deserialize_content"
    )]
    pub content: Vec<ContentPart>,
    pub name: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
    pub tool_call_id: Option<String>,
    pub partial: Option<bool>,
}

impl Message {
    pub fn new(role: Role, content: Vec<ContentPart>) -> Self {
        Self {
            role,
            content,
            name: None,
            tool_calls: None,
            tool_call_id: None,
            partial: None,
        }
    }

    pub fn extract_text(&self, sep: &str) -> String {
        let mut parts = Vec::new();
        for part in &self.content {
            if let ContentPart::Text(text) = part {
                parts.push(text.text.clone());
            }
        }
        parts.join(sep)
    }
}

fn serialize_content<S>(content: &[ContentPart], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if content.len() == 1 {
        if let ContentPart::Text(text) = &content[0] {
            return serializer.serialize_str(&text.text);
        }
    }
    content.serialize(serializer)
}

fn deserialize_content<'de, D>(deserializer: D) -> Result<Vec<ContentPart>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(Vec::new());
    }
    if let Some(text) = value.as_str() {
        return Ok(vec![ContentPart::Text(TextPart::new(text))]);
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

impl fmt::Display for Message {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.role, self.extract_text(""))
    }
}
