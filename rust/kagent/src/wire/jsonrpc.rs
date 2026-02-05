use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::wire::{UserInput, WireMessage, serialize_wire_message};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcMessage {
    pub jsonrpc: Option<String>,
    pub method: Option<String>,
    pub id: Option<String>,
    pub params: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<JsonRpcErrorObject>,
}

impl JsonRpcMessage {
    pub fn is_request(&self) -> bool {
        self.method.is_some() && self.id.is_some()
    }

    pub fn is_notification(&self) -> bool {
        self.method.is_some() && self.id.is_none()
    }

    pub fn is_response(&self) -> bool {
        self.method.is_none() && self.id.is_some()
    }
}

#[derive(Debug, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExternalTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Deserialize)]
pub struct InitializeParams {
    pub protocol_version: String,
    pub client: Option<ClientInfo>,
    pub external_tools: Option<Vec<ExternalTool>>,
}

#[derive(Debug, Deserialize)]
pub struct PromptParams {
    pub user_input: UserInput,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcSuccessResponse {
    pub jsonrpc: &'static str,
    pub id: String,
    pub result: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: &'static str,
    pub id: String,
    pub error: JsonRpcErrorObject,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorResponseNullableId {
    pub jsonrpc: &'static str,
    pub id: Option<String>,
    pub error: JsonRpcErrorObject,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcEventMessage {
    pub jsonrpc: &'static str,
    pub method: &'static str,
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcRequestMessage {
    pub jsonrpc: &'static str,
    pub method: &'static str,
    pub id: String,
    pub params: Value,
}

pub fn build_event_message(msg: WireMessage) -> JsonRpcEventMessage {
    JsonRpcEventMessage {
        jsonrpc: "2.0",
        method: "event",
        params: serialize_wire_message(&msg).unwrap_or(Value::Null),
    }
}

pub fn build_request_message(id: String, msg: WireMessage) -> JsonRpcRequestMessage {
    JsonRpcRequestMessage {
        jsonrpc: "2.0",
        method: "request",
        id,
        params: serialize_wire_message(&msg).unwrap_or(Value::Null),
    }
}

pub mod error_codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;

    pub const INVALID_STATE: i64 = -32000;
    pub const LLM_NOT_SET: i64 = -32001;
    pub const LLM_NOT_SUPPORTED: i64 = -32002;
    pub const CHAT_PROVIDER_ERROR: i64 = -32003;
}

pub mod statuses {
    pub const FINISHED: &str = "finished";
    pub const CANCELLED: &str = "cancelled";
    pub const MAX_STEPS_REACHED: &str = "max_steps_reached";
}
