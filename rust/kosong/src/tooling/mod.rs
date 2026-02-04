use std::collections::BTreeMap;

use schemars::JsonSchema;
use schemars::generate::{SchemaGenerator, SchemaSettings};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::message::ContentPart;
use crate::utils::typing::JsonValue;

pub type ParametersType = JsonValue;

pub mod empty;
pub mod error;
pub mod mcp;
pub mod simple;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: JsonValue,
}

impl Tool {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: JsonValue,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DisplayBlock {
    Brief(BriefDisplayBlock),
    Diff(DiffDisplayBlock),
    Todo(TodoDisplayBlock),
    Shell(ShellDisplayBlock),
    Unknown(UnknownDisplayBlock),
}

impl Serialize for DisplayBlock {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            DisplayBlock::Brief(block) => block.serialize(serializer),
            DisplayBlock::Diff(block) => block.serialize(serializer),
            DisplayBlock::Todo(block) => block.serialize(serializer),
            DisplayBlock::Shell(block) => block.serialize(serializer),
            DisplayBlock::Unknown(block) => block.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for DisplayBlock {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let kind = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::custom("DisplayBlock missing type"))?;
        match kind {
            "brief" => Ok(DisplayBlock::Brief(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "diff" => Ok(DisplayBlock::Diff(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "todo" => Ok(DisplayBlock::Todo(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            "shell" => Ok(DisplayBlock::Shell(
                serde_json::from_value(value).map_err(serde::de::Error::custom)?,
            )),
            _ => {
                let mut data = value.clone();
                if let Value::Object(map) = &mut data {
                    map.remove("type");
                }
                Ok(DisplayBlock::Unknown(UnknownDisplayBlock {
                    kind: kind.to_string(),
                    data,
                }))
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefDisplayBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

impl BriefDisplayBlock {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            kind: "brief".to_string(),
            text: text.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownDisplayBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: JsonValue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffDisplayBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

impl DiffDisplayBlock {
    pub fn new(
        path: impl Into<String>,
        old_text: impl Into<String>,
        new_text: impl Into<String>,
    ) -> Self {
        Self {
            kind: "diff".to_string(),
            path: path.into(),
            old_text: old_text.into(),
            new_text: new_text.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoDisplayItem {
    pub title: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoDisplayBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub items: Vec<TodoDisplayItem>,
}

impl TodoDisplayBlock {
    pub fn new(items: Vec<TodoDisplayItem>) -> Self {
        Self {
            kind: "todo".to_string(),
            items,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellDisplayBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub language: String,
    pub command: String,
}

impl ShellDisplayBlock {
    pub fn new(language: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            kind: "shell".to_string(),
            language: language.into(),
            command: command.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolReturnValue {
    pub is_error: bool,
    #[serde(default)]
    pub output: ToolOutput,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub display: Vec<DisplayBlock>,
    #[serde(default)]
    pub extras: Option<BTreeMap<String, JsonValue>>,
}

impl ToolReturnValue {
    pub fn brief(&self) -> String {
        for block in &self.display {
            if let DisplayBlock::Brief(brief) = block {
                return brief.text.clone();
            }
        }
        String::new()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolOutput {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl Default for ToolOutput {
    fn default() -> Self {
        ToolOutput::Text(String::new())
    }
}

impl From<String> for ToolOutput {
    fn from(value: String) -> Self {
        ToolOutput::Text(value)
    }
}

impl From<&str> for ToolOutput {
    fn from(value: &str) -> Self {
        ToolOutput::Text(value.to_string())
    }
}

impl From<ContentPart> for ToolOutput {
    fn from(value: ContentPart) -> Self {
        ToolOutput::Parts(vec![value])
    }
}

impl From<Vec<ContentPart>> for ToolOutput {
    fn from(value: Vec<ContentPart>) -> Self {
        ToolOutput::Parts(value)
    }
}

impl Serialize for ToolOutput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            ToolOutput::Text(text) => serializer.serialize_str(text),
            ToolOutput::Parts(parts) => parts.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ToolOutput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        if let Some(text) = value.as_str() {
            return Ok(ToolOutput::Text(text.to_string()));
        }
        let parts: Vec<ContentPart> =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(ToolOutput::Parts(parts))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub return_value: ToolReturnValue,
}

pub enum ToolResultFuture {
    Immediate(ToolResult),
    Pending(tokio::task::JoinHandle<ToolResult>),
}

impl ToolResultFuture {
    pub async fn resolve(self) -> anyhow::Result<ToolResult> {
        match self {
            ToolResultFuture::Immediate(result) => Ok(result),
            ToolResultFuture::Pending(task) => Ok(task.await?),
        }
    }
}

pub trait Toolset: Send + Sync {
    fn tools(&self) -> Vec<Tool>;
    fn handle(&self, tool_call: crate::message::ToolCall) -> ToolResultFuture;
}

#[async_trait::async_trait]
pub trait CallableTool: Send + Sync {
    fn base(&self) -> Tool;
    async fn call(&self, arguments: JsonValue) -> ToolReturnValue;
}

pub fn tool_ok(
    output: impl Into<ToolOutput>,
    message: impl Into<String>,
    brief: &str,
) -> ToolReturnValue {
    let mut display = Vec::new();
    if !brief.is_empty() {
        display.push(DisplayBlock::Brief(BriefDisplayBlock::new(brief)));
    }
    ToolReturnValue {
        is_error: false,
        output: output.into(),
        message: message.into(),
        display,
        extras: None,
    }
}

pub fn tool_error(
    output: impl Into<ToolOutput>,
    message: impl Into<String>,
    brief: &str,
) -> ToolReturnValue {
    let mut display = Vec::new();
    if !brief.is_empty() {
        display.push(DisplayBlock::Brief(BriefDisplayBlock::new(brief)));
    }
    ToolReturnValue {
        is_error: true,
        output: output.into(),
        message: message.into(),
        display,
        extras: None,
    }
}

pub fn schema_for<T: JsonSchema>() -> JsonValue {
    let settings = SchemaSettings::draft07().with(|s| {
        s.inline_subschemas = true;
    });
    let generator = SchemaGenerator::new(settings);
    let schema = generator.into_root_schema_for::<T>();
    let mut value = serde_json::to_value(&schema).unwrap_or(Value::Null);
    normalize_schema(&mut value);
    let mut resolved = crate::utils::jsonschema::deref_json_schema(&value);
    normalize_schema(&mut resolved);
    resolved
}

fn normalize_schema(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if matches!(map.get("title"), Some(Value::String(_))) {
                map.remove("title");
            }
            if matches!(map.get("$schema"), Some(Value::String(_))) {
                map.remove("$schema");
            }
            if matches!(map.get("format"), Some(Value::String(_))) {
                map.remove("format");
            }
            if let Some(Value::Array(types)) = map.get("type") {
                if types.iter().any(|value| value.as_str() == Some("null")) {
                    let mut any_of = Vec::new();
                    for entry in types {
                        if let Some(kind) = entry.as_str() {
                            any_of.push(serde_json::json!({ "type": kind }));
                        }
                    }
                    map.remove("type");
                    map.insert("anyOf".to_string(), Value::Array(any_of));
                }
            }
            for v in map.values_mut() {
                normalize_schema(v);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_schema(item);
            }
        }
        Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                if float.fract() == 0.0 {
                    if let Some(int_value) = i64::try_from(float as i128).ok() {
                        *value = Value::Number(serde_json::Number::from(int_value));
                    }
                }
            }
        }
        _ => {}
    }
}

#[async_trait::async_trait]
pub trait CallableTool2: Send + Sync {
    type Params: for<'de> Deserialize<'de> + JsonSchema + Send;

    fn name(&self) -> &str;
    fn description(&self) -> &str;
    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue;
}

#[async_trait::async_trait]
impl<T> CallableTool for T
where
    T: CallableTool2 + Send + Sync,
{
    fn base(&self) -> Tool {
        let parameters = schema_for::<T::Params>();
        Tool::new(self.name(), self.description(), parameters)
    }

    async fn call(&self, arguments: JsonValue) -> ToolReturnValue {
        match serde_json::from_value::<T::Params>(arguments) {
            Ok(params) => self.call_typed(params).await,
            Err(err) => crate::tooling::error::tool_validate_error(&err.to_string()),
        }
    }
}
