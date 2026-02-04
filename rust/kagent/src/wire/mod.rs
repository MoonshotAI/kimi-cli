pub mod channel;
pub mod file;
pub mod jsonrpc;
pub mod protocol;
pub mod serde;
pub mod server;
pub mod types;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WireError {
    #[error("unknown wire message type: {0}")]
    UnknownMessageType(String),
    #[error("wire message payload must be a JSON object")]
    InvalidPayloadType,
    #[error("invalid subagent event: {0}")]
    InvalidSubagentEvent(String),
    #[error("invalid wire envelope: {0}")]
    InvalidEnvelope(String),
    #[error("serialization error: {0}")]
    Serde(String),
}

pub use channel::{Wire, WireMessageQueue, WireSoulSide, WireUISide};
pub use file::{WireFile, WireFileMetadata, WireMessageRecord};
pub use serde::{deserialize_wire_message, serialize_wire_message};
pub use types::{
    ApprovalRequest, ApprovalResponse, ApprovalResponseKind, CompactionBegin, CompactionEnd,
    StatusUpdate, StepBegin, StepInterrupted, SubagentEvent, ToolCallRequest, TurnBegin, TurnEnd,
    UserInput, WireMessage, WireMessageEnvelope,
};

pub use types::{is_event, is_request, is_wire_message};

pub use protocol::{WIRE_PROTOCOL_LEGACY_VERSION, WIRE_PROTOCOL_VERSION};

pub use kosong::message::{
    AudioURLPart, ContentPart, ImageURLPart, TextPart, ThinkPart, ToolCall, ToolCallPart,
    VideoURLPart,
};
pub use kosong::tooling::{
    BriefDisplayBlock, DiffDisplayBlock, DisplayBlock, ShellDisplayBlock, TodoDisplayBlock,
    TodoDisplayItem, ToolResult, ToolReturnValue, UnknownDisplayBlock,
};
