use serde_json::Value;
use thiserror::Error;

use crate::message::{AudioURLPart, ContentPart, ImageURLPart, TextPart, VideoURLPart};

#[derive(Debug, Error)]
pub enum McpContentError {
    #[error("Unsupported MCP content: {0}")]
    Unsupported(String),
    #[error("Invalid MCP content: {0}")]
    Invalid(String),
}

pub fn convert_mcp_content(part: &Value) -> Result<ContentPart, McpContentError> {
    let obj = part
        .as_object()
        .ok_or_else(|| McpContentError::Invalid("content block must be an object".to_string()))?;
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| McpContentError::Invalid("content block missing type".to_string()))?;

    match kind {
        "text" => {
            let text = obj
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| McpContentError::Invalid("text content missing text".to_string()))?;
            Ok(ContentPart::Text(TextPart::new(text)))
        }
        "image" => {
            let data = obj.get("data").and_then(Value::as_str).ok_or_else(|| {
                McpContentError::Invalid("image content missing data".to_string())
            })?;
            let mime = obj.get("mimeType").and_then(Value::as_str).ok_or_else(|| {
                McpContentError::Invalid("image content missing mimeType".to_string())
            })?;
            let url = format!("data:{mime};base64,{data}");
            Ok(ContentPart::ImageUrl(ImageURLPart::new(url)))
        }
        "audio" => {
            let data = obj.get("data").and_then(Value::as_str).ok_or_else(|| {
                McpContentError::Invalid("audio content missing data".to_string())
            })?;
            let mime = obj.get("mimeType").and_then(Value::as_str).ok_or_else(|| {
                McpContentError::Invalid("audio content missing mimeType".to_string())
            })?;
            let url = format!("data:{mime};base64,{data}");
            Ok(ContentPart::AudioUrl(AudioURLPart::new(url)))
        }
        "resource" => {
            let resource = obj
                .get("resource")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    McpContentError::Invalid("resource content missing resource".to_string())
                })?;
            let mime = resource
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            let blob = resource
                .get("blob")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    McpContentError::Invalid("resource content missing blob".to_string())
                })?;
            let url = format!("data:{mime};base64,{blob}");
            if mime.starts_with("image/") {
                Ok(ContentPart::ImageUrl(ImageURLPart::new(url)))
            } else if mime.starts_with("audio/") {
                Ok(ContentPart::AudioUrl(AudioURLPart::new(url)))
            } else if mime.starts_with("video/") {
                Ok(ContentPart::VideoUrl(VideoURLPart::new(url)))
            } else {
                Err(McpContentError::Unsupported(format!(
                    "unsupported mime type: {mime}"
                )))
            }
        }
        "resource_link" => {
            let uri = obj
                .get("uri")
                .and_then(Value::as_str)
                .ok_or_else(|| McpContentError::Invalid("resource_link missing uri".to_string()))?;
            let mime = obj
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            if mime.starts_with("image/") {
                Ok(ContentPart::ImageUrl(ImageURLPart::new(uri)))
            } else if mime.starts_with("audio/") {
                Ok(ContentPart::AudioUrl(AudioURLPart::new(uri)))
            } else if mime.starts_with("video/") {
                Ok(ContentPart::VideoUrl(VideoURLPart::new(uri)))
            } else {
                Err(McpContentError::Unsupported(format!(
                    "unsupported mime type: {mime}"
                )))
            }
        }
        other => Err(McpContentError::Unsupported(format!(
            "unsupported content type: {other}"
        ))),
    }
}
