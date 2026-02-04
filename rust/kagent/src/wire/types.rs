use std::fmt;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::Notify;

use kosong::chat_provider::TokenUsage;
use kosong::message::{ContentPart, ToolCall, ToolCallPart};
use kosong::tooling::{DisplayBlock, ToolResult, ToolReturnValue};

use super::WireError;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserInput {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl From<String> for UserInput {
    fn from(value: String) -> Self {
        UserInput::Text(value)
    }
}

impl From<&str> for UserInput {
    fn from(value: &str) -> Self {
        UserInput::Text(value.to_string())
    }
}

impl From<Vec<ContentPart>> for UserInput {
    fn from(value: Vec<ContentPart>) -> Self {
        UserInput::Parts(value)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnBegin {
    pub user_input: UserInput,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TurnEnd {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StepBegin {
    pub n: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct StepInterrupted {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct CompactionBegin {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct CompactionEnd {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatusUpdate {
    #[serde(default)]
    pub context_usage: Option<f64>,
    #[serde(default)]
    pub token_usage: Option<TokenUsage>,
    #[serde(default)]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalResponseKind {
    Approve,
    ApproveForSession,
    Reject,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub request_id: String,
    pub response: ApprovalResponseKind,
}

#[derive(Clone)]
struct PendingResponse<T: Clone> {
    value: Arc<Mutex<Option<T>>>,
    notify: Arc<Notify>,
}

impl<T: Clone> PendingResponse<T> {
    fn new() -> Self {
        Self {
            value: Arc::new(Mutex::new(None)),
            notify: Arc::new(Notify::new()),
        }
    }

    fn resolve(&self, value: T) {
        let mut guard = self.value.lock().unwrap();
        if guard.is_none() {
            *guard = Some(value);
            self.notify.notify_waiters();
        }
    }

    async fn wait(&self) -> T {
        loop {
            if let Some(value) = self.value.lock().unwrap().clone() {
                return value;
            }
            self.notify.notified().await;
        }
    }

    fn resolved(&self) -> bool {
        self.value.lock().unwrap().is_some()
    }
}

impl<T: Clone> Default for PendingResponse<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone> fmt::Debug for PendingResponse<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingResponse")
            .field("resolved", &self.resolved())
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub tool_call_id: String,
    pub sender: String,
    pub action: String,
    pub description: String,
    #[serde(default)]
    pub display: Vec<DisplayBlock>,
    #[serde(skip, default)]
    pending: PendingResponse<ApprovalResponseKind>,
}

impl ApprovalRequest {
    pub fn new(
        id: impl Into<String>,
        tool_call_id: impl Into<String>,
        sender: impl Into<String>,
        action: impl Into<String>,
        description: impl Into<String>,
        display: Vec<DisplayBlock>,
    ) -> Self {
        Self {
            id: id.into(),
            tool_call_id: tool_call_id.into(),
            sender: sender.into(),
            action: action.into(),
            description: description.into(),
            display,
            pending: PendingResponse::new(),
        }
    }

    pub async fn wait(&self) -> ApprovalResponseKind {
        self.pending.wait().await
    }

    pub fn resolve(&self, response: ApprovalResponseKind) {
        self.pending.resolve(response);
    }

    pub fn resolved(&self) -> bool {
        self.pending.resolved()
    }
}

impl PartialEq for ApprovalRequest {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.tool_call_id == other.tool_call_id
            && self.sender == other.sender
            && self.action == other.action
            && self.description == other.description
            && self.display == other.display
    }
}

impl Eq for ApprovalRequest {}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    pub arguments: Option<String>,
    #[serde(skip, default)]
    pending: PendingResponse<ToolReturnValue>,
}

impl ToolCallRequest {
    pub fn from_tool_call(tool_call: &ToolCall) -> Self {
        Self {
            id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            arguments: tool_call.function.arguments.clone(),
            pending: PendingResponse::new(),
        }
    }

    pub async fn wait(&self) -> ToolReturnValue {
        self.pending.wait().await
    }

    pub fn resolve(&self, result: ToolReturnValue) {
        self.pending.resolve(result);
    }

    pub fn resolved(&self) -> bool {
        self.pending.resolved()
    }
}

impl PartialEq for ToolCallRequest {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && self.name == other.name && self.arguments == other.arguments
    }
}

impl Eq for ToolCallRequest {}

#[derive(Clone, Debug, PartialEq)]
pub struct SubagentEvent {
    pub task_tool_call_id: String,
    pub event: Box<WireMessage>,
}

impl SubagentEvent {
    pub fn new(
        task_tool_call_id: impl Into<String>,
        event: WireMessage,
    ) -> Result<Self, WireError> {
        if !is_event(&event) {
            return Err(WireError::InvalidSubagentEvent(
                "SubagentEvent event must be an Event".to_string(),
            ));
        }
        Ok(Self {
            task_tool_call_id: task_tool_call_id.into(),
            event: Box::new(event),
        })
    }
}

impl Serialize for SubagentEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        struct SubagentEventSerde {
            task_tool_call_id: String,
            event: WireMessageEnvelope,
        }

        let envelope = WireMessageEnvelope::from_wire_message(&self.event)
            .map_err(serde::ser::Error::custom)?;
        let helper = SubagentEventSerde {
            task_tool_call_id: self.task_tool_call_id.clone(),
            event: envelope,
        };
        helper.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SubagentEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct SubagentEventSerde {
            task_tool_call_id: String,
            event: WireMessageEnvelope,
        }

        let helper = SubagentEventSerde::deserialize(deserializer)?;
        let event = helper
            .event
            .to_wire_message()
            .map_err(serde::de::Error::custom)?;
        if !is_event(&event) {
            return Err(serde::de::Error::custom(
                "SubagentEvent event must be an Event",
            ));
        }
        Ok(SubagentEvent {
            task_tool_call_id: helper.task_tool_call_id,
            event: Box::new(event),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum WireMessage {
    TurnBegin(TurnBegin),
    TurnEnd(TurnEnd),
    StepBegin(StepBegin),
    StepInterrupted(StepInterrupted),
    CompactionBegin(CompactionBegin),
    CompactionEnd(CompactionEnd),
    StatusUpdate(StatusUpdate),
    ContentPart(ContentPart),
    ToolCall(ToolCall),
    ToolCallPart(ToolCallPart),
    ToolResult(ToolResult),
    ApprovalResponse(ApprovalResponse),
    SubagentEvent(SubagentEvent),
    ApprovalRequest(ApprovalRequest),
    ToolCallRequest(ToolCallRequest),
}

impl WireMessage {
    pub fn type_name(&self) -> &'static str {
        match self {
            WireMessage::TurnBegin(_) => "TurnBegin",
            WireMessage::TurnEnd(_) => "TurnEnd",
            WireMessage::StepBegin(_) => "StepBegin",
            WireMessage::StepInterrupted(_) => "StepInterrupted",
            WireMessage::CompactionBegin(_) => "CompactionBegin",
            WireMessage::CompactionEnd(_) => "CompactionEnd",
            WireMessage::StatusUpdate(_) => "StatusUpdate",
            WireMessage::ContentPart(_) => "ContentPart",
            WireMessage::ToolCall(_) => "ToolCall",
            WireMessage::ToolCallPart(_) => "ToolCallPart",
            WireMessage::ToolResult(_) => "ToolResult",
            WireMessage::ApprovalResponse(_) => "ApprovalResponse",
            WireMessage::SubagentEvent(_) => "SubagentEvent",
            WireMessage::ApprovalRequest(_) => "ApprovalRequest",
            WireMessage::ToolCallRequest(_) => "ToolCallRequest",
        }
    }

    pub fn is_event(&self) -> bool {
        is_event(self)
    }

    pub fn is_request(&self) -> bool {
        is_request(self)
    }
}

pub fn is_event(msg: &WireMessage) -> bool {
    !matches!(
        msg,
        WireMessage::ApprovalRequest(_) | WireMessage::ToolCallRequest(_)
    )
}

pub fn is_request(msg: &WireMessage) -> bool {
    matches!(
        msg,
        WireMessage::ApprovalRequest(_) | WireMessage::ToolCallRequest(_)
    )
}

pub fn is_wire_message(_msg: &WireMessage) -> bool {
    true
}

impl From<TurnBegin> for WireMessage {
    fn from(value: TurnBegin) -> Self {
        WireMessage::TurnBegin(value)
    }
}

impl From<TurnEnd> for WireMessage {
    fn from(value: TurnEnd) -> Self {
        WireMessage::TurnEnd(value)
    }
}

impl From<StepBegin> for WireMessage {
    fn from(value: StepBegin) -> Self {
        WireMessage::StepBegin(value)
    }
}

impl From<StepInterrupted> for WireMessage {
    fn from(value: StepInterrupted) -> Self {
        WireMessage::StepInterrupted(value)
    }
}

impl From<CompactionBegin> for WireMessage {
    fn from(value: CompactionBegin) -> Self {
        WireMessage::CompactionBegin(value)
    }
}

impl From<CompactionEnd> for WireMessage {
    fn from(value: CompactionEnd) -> Self {
        WireMessage::CompactionEnd(value)
    }
}

impl From<StatusUpdate> for WireMessage {
    fn from(value: StatusUpdate) -> Self {
        WireMessage::StatusUpdate(value)
    }
}

impl From<ContentPart> for WireMessage {
    fn from(value: ContentPart) -> Self {
        WireMessage::ContentPart(value)
    }
}

impl From<ToolCall> for WireMessage {
    fn from(value: ToolCall) -> Self {
        WireMessage::ToolCall(value)
    }
}

impl From<ToolCallPart> for WireMessage {
    fn from(value: ToolCallPart) -> Self {
        WireMessage::ToolCallPart(value)
    }
}

impl From<ToolResult> for WireMessage {
    fn from(value: ToolResult) -> Self {
        WireMessage::ToolResult(value)
    }
}

impl From<ApprovalResponse> for WireMessage {
    fn from(value: ApprovalResponse) -> Self {
        WireMessage::ApprovalResponse(value)
    }
}

impl From<SubagentEvent> for WireMessage {
    fn from(value: SubagentEvent) -> Self {
        WireMessage::SubagentEvent(value)
    }
}

impl From<ApprovalRequest> for WireMessage {
    fn from(value: ApprovalRequest) -> Self {
        WireMessage::ApprovalRequest(value)
    }
}

impl From<ToolCallRequest> for WireMessage {
    fn from(value: ToolCallRequest) -> Self {
        WireMessage::ToolCallRequest(value)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireMessageEnvelope {
    #[serde(rename = "type")]
    pub type_name: String,
    pub payload: Map<String, Value>,
}

impl WireMessageEnvelope {
    pub fn from_wire_message(msg: &WireMessage) -> Result<Self, WireError> {
        let payload = match msg {
            WireMessage::TurnBegin(value) => payload_from(value)?,
            WireMessage::TurnEnd(value) => payload_from(value)?,
            WireMessage::StepBegin(value) => payload_from(value)?,
            WireMessage::StepInterrupted(value) => payload_from(value)?,
            WireMessage::CompactionBegin(value) => payload_from(value)?,
            WireMessage::CompactionEnd(value) => payload_from(value)?,
            WireMessage::StatusUpdate(value) => payload_from(value)?,
            WireMessage::ContentPart(value) => payload_from(value)?,
            WireMessage::ToolCall(value) => payload_from(value)?,
            WireMessage::ToolCallPart(value) => payload_from(value)?,
            WireMessage::ToolResult(value) => payload_from(value)?,
            WireMessage::ApprovalResponse(value) => payload_from(value)?,
            WireMessage::SubagentEvent(value) => payload_from(value)?,
            WireMessage::ApprovalRequest(value) => payload_from(value)?,
            WireMessage::ToolCallRequest(value) => payload_from(value)?,
        };
        Ok(Self {
            type_name: msg.type_name().to_string(),
            payload,
        })
    }

    pub fn to_wire_message(&self) -> Result<WireMessage, WireError> {
        let payload_value = Value::Object(self.payload.clone());
        match self.type_name.as_str() {
            "TurnBegin" => Ok(WireMessage::TurnBegin(parse_payload(payload_value)?)),
            "TurnEnd" => Ok(WireMessage::TurnEnd(parse_payload(payload_value)?)),
            "StepBegin" => Ok(WireMessage::StepBegin(parse_payload(payload_value)?)),
            "StepInterrupted" => Ok(WireMessage::StepInterrupted(parse_payload(payload_value)?)),
            "CompactionBegin" => Ok(WireMessage::CompactionBegin(parse_payload(payload_value)?)),
            "CompactionEnd" => Ok(WireMessage::CompactionEnd(parse_payload(payload_value)?)),
            "StatusUpdate" => Ok(WireMessage::StatusUpdate(parse_payload(payload_value)?)),
            "ContentPart" => Ok(WireMessage::ContentPart(parse_payload(payload_value)?)),
            "ToolCall" => Ok(WireMessage::ToolCall(parse_payload(payload_value)?)),
            "ToolCallPart" => Ok(WireMessage::ToolCallPart(parse_payload(payload_value)?)),
            "ToolResult" => Ok(WireMessage::ToolResult(parse_payload(payload_value)?)),
            "ApprovalResponse" => Ok(WireMessage::ApprovalResponse(parse_payload(payload_value)?)),
            "ApprovalRequestResolved" => {
                Ok(WireMessage::ApprovalResponse(parse_payload(payload_value)?))
            }
            "SubagentEvent" => Ok(WireMessage::SubagentEvent(parse_payload(payload_value)?)),
            "ApprovalRequest" => Ok(WireMessage::ApprovalRequest(parse_payload(payload_value)?)),
            "ToolCallRequest" => Ok(WireMessage::ToolCallRequest(parse_payload(payload_value)?)),
            other => Err(WireError::UnknownMessageType(other.to_string())),
        }
    }
}

fn payload_from<T: Serialize>(value: &T) -> Result<Map<String, Value>, WireError> {
    let value = serde_json::to_value(value).map_err(|err| WireError::Serde(err.to_string()))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(WireError::InvalidPayloadType),
    }
}

fn parse_payload<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, WireError> {
    serde_json::from_value(value).map_err(|err| WireError::Serde(err.to_string()))
}
