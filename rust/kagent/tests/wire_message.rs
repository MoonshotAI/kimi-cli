use serde_json::{Value, json};

use kagent::wire::{
    ApprovalRequest, ApprovalResponse, ApprovalResponseKind, CompactionBegin, CompactionEnd,
    StatusUpdate, StepBegin, StepInterrupted, SubagentEvent, ToolCallRequest, TurnBegin, TurnEnd,
    UserInput, WireMessage, WireMessageEnvelope, WireMessageRecord, deserialize_wire_message,
    is_event, is_request, is_wire_message, serialize_wire_message,
};
use kosong::message::{ContentPart, ImageURLPart, TextPart, ToolCall, ToolCallPart};
use kosong::tooling::{BriefDisplayBlock, DisplayBlock, ToolOutput, ToolResult, ToolReturnValue};

fn assert_roundtrip(msg: WireMessage) {
    let serialized = serialize_wire_message(&msg).expect("serialize wire message");
    let deserialized = deserialize_wire_message(serialized).expect("deserialize wire message");
    assert_eq!(deserialized, msg);
}

#[test]
fn test_wire_message_serde() {
    let msg = WireMessage::TurnBegin(TurnBegin {
        user_input: UserInput::Text("Hello, world!".to_string()),
    });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "TurnBegin", "payload": {"user_input": "Hello, world!"}})
    );
    assert_roundtrip(msg);

    let msg = WireMessage::TurnBegin(TurnBegin {
        user_input: UserInput::Parts(vec![
            ContentPart::Text(TextPart::new("Hello")),
            ContentPart::Text(TextPart::new("world!")),
        ]),
    });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "TurnBegin",
            "payload": {
                "user_input": [
                    {"type": "text", "text": "Hello"},
                    {"type": "text", "text": "world!"}
                ]
            }
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::TurnEnd(TurnEnd::default());
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "TurnEnd", "payload": {}})
    );
    assert_roundtrip(msg);

    let msg = WireMessage::StepBegin(StepBegin { n: 1 });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "StepBegin", "payload": {"n": 1}})
    );
    assert_roundtrip(msg);

    let msg = WireMessage::StepInterrupted(StepInterrupted::default());
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "StepInterrupted", "payload": {}})
    );
    assert_roundtrip(msg);

    let msg = WireMessage::CompactionBegin(CompactionBegin::default());
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "CompactionBegin", "payload": {}})
    );
    assert_roundtrip(msg);

    let msg = WireMessage::CompactionEnd(CompactionEnd::default());
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "CompactionEnd", "payload": {}})
    );
    assert_roundtrip(msg);

    let msg = WireMessage::StatusUpdate(StatusUpdate {
        context_usage: Some(0.5),
        token_usage: None,
        message_id: None,
    });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "StatusUpdate",
            "payload": {"context_usage": 0.5, "token_usage": null, "message_id": null}
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::ContentPart(ContentPart::Text(TextPart::new("Hello world")));
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ContentPart",
            "payload": {"type": "text", "text": "Hello world"}
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::ContentPart(ContentPart::ImageUrl(ImageURLPart::new(
        "http://example.com/image.png",
    )));
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ContentPart",
            "payload": {
                "type": "image_url",
                "image_url": {"url": "http://example.com/image.png", "id": null}
            }
        })
    );
    assert_roundtrip(msg);

    let mut tool_call = ToolCall::new("call_123", "bash");
    tool_call.function.arguments = Some("{\"command\": \"ls -la\"}".to_string());
    let msg = WireMessage::ToolCall(tool_call);
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ToolCall",
            "payload": {
                "type": "function",
                "id": "call_123",
                "function": {"name": "bash", "arguments": "{\"command\": \"ls -la\"}"},
                "extras": null
            }
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::ToolCallPart(ToolCallPart {
        arguments_part: Some("}".to_string()),
    });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({"type": "ToolCallPart", "payload": {"arguments_part": "}"}})
    );
    assert_roundtrip(msg);

    let return_value = ToolReturnValue {
        is_error: false,
        output: ToolOutput::Text(String::new()),
        message: "Command completed".to_string(),
        display: vec![DisplayBlock::Brief(BriefDisplayBlock::new(
            "Command completed",
        ))],
        extras: None,
    };
    let msg = WireMessage::ToolResult(ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value,
    });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ToolResult",
            "payload": {
                "tool_call_id": "call_123",
                "return_value": {
                    "is_error": false,
                    "output": "",
                    "message": "Command completed",
                    "display": [{"type": "brief", "text": "Command completed"}],
                    "extras": null
                }
            }
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::ApprovalResponse(ApprovalResponse {
        request_id: "request_123".to_string(),
        response: ApprovalResponseKind::Approve,
    });
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ApprovalResponse",
            "payload": {"request_id": "request_123", "response": "approve"}
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::SubagentEvent(
        SubagentEvent::new("task_789", WireMessage::StepBegin(StepBegin { n: 2 }))
            .expect("subagent event"),
    );
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "SubagentEvent",
            "payload": {
                "task_tool_call_id": "task_789",
                "event": {"type": "StepBegin", "payload": {"n": 2}}
            }
        })
    );
    assert_roundtrip(msg);

    let msg = WireMessage::ApprovalRequest(ApprovalRequest::new(
        "request_123",
        "call_999",
        "bash",
        "Execute dangerous command",
        "This command will delete files",
        Vec::new(),
    ));
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ApprovalRequest",
            "payload": {
                "id": "request_123",
                "tool_call_id": "call_999",
                "sender": "bash",
                "action": "Execute dangerous command",
                "description": "This command will delete files",
                "display": []
            }
        })
    );
    assert_roundtrip(msg);

    let mut call = ToolCall::new("call_123", "bash");
    call.function.arguments = Some("{\"command\": \"ls -la\"}".to_string());
    let msg = WireMessage::ToolCallRequest(ToolCallRequest::from_tool_call(&call));
    assert_eq!(
        serialize_wire_message(&msg).unwrap(),
        json!({
            "type": "ToolCallRequest",
            "payload": {
                "id": "call_123",
                "name": "bash",
                "arguments": "{\"command\": \"ls -la\"}"
            }
        })
    );
    assert_roundtrip(msg);
}

#[test]
fn test_approval_request_deserialize_without_display() {
    let msg = deserialize_wire_message(json!({
        "type": "ApprovalRequest",
        "payload": {
            "id": "request_123",
            "tool_call_id": "call_999",
            "sender": "bash",
            "action": "Execute dangerous command",
            "description": "This command will delete files"
        }
    }))
    .expect("deserialize wire message");

    match msg {
        WireMessage::ApprovalRequest(request) => {
            assert!(request.display.is_empty());
        }
        _ => panic!("expected ApprovalRequest"),
    }
}

#[test]
fn test_wire_message_record_roundtrip() {
    let envelope = WireMessageEnvelope::from_wire_message(&WireMessage::TurnBegin(TurnBegin {
        user_input: UserInput::Parts(vec![ContentPart::Text(TextPart::new("hi"))]),
    }))
    .expect("envelope");
    let record = WireMessageRecord {
        timestamp: 123.456,
        message: envelope.clone(),
    };

    assert_eq!(
        serde_json::to_value(&record).unwrap(),
        json!({
            "timestamp": 123.456,
            "message": {
                "type": "TurnBegin",
                "payload": {"user_input": [{"type": "text", "text": "hi"}]}
            }
        })
    );

    let parsed: WireMessageRecord =
        serde_json::from_str(&serde_json::to_string(&record).unwrap()).expect("parse record");
    assert_eq!(parsed.message, envelope);
    assert_eq!(
        parsed.to_wire_message().unwrap(),
        WireMessage::TurnBegin(TurnBegin {
            user_input: UserInput::Parts(vec![ContentPart::Text(TextPart::new("hi"))])
        })
    );
}

#[test]
fn test_bad_wire_message_serde() {
    assert!(deserialize_wire_message(Value::Null).is_err());
    assert!(deserialize_wire_message(json!([])).is_err());
    assert!(deserialize_wire_message(json!({})).is_err());
    assert!(
        deserialize_wire_message(json!({
            "timestamp": 123,
            "message": {
                "type": "ContentPart",
                "payload": {"type": "text", "text": "Hello world"}
            }
        }))
        .is_err()
    );
}

#[test]
fn test_approval_request_resolved_compat() {
    let msg = deserialize_wire_message(json!({
        "type": "ApprovalRequestResolved",
        "payload": {"request_id": "request_123", "response": "approve"}
    }))
    .expect("deserialize wire message");

    assert_eq!(
        msg,
        WireMessage::ApprovalResponse(ApprovalResponse {
            request_id: "request_123".to_string(),
            response: ApprovalResponseKind::Approve,
        })
    );
}

#[test]
fn test_type_inspection() {
    let msg = WireMessage::StepBegin(StepBegin { n: 1 });
    assert!(is_wire_message(&msg));
    assert!(is_event(&msg));
    assert!(!is_request(&msg));

    let msg = WireMessage::ContentPart(ContentPart::Text(TextPart::new("Hello world")));
    assert!(is_wire_message(&msg));
    assert!(is_event(&msg));
    assert!(!is_request(&msg));

    let msg = WireMessage::ApprovalResponse(ApprovalResponse {
        request_id: "request_123".to_string(),
        response: ApprovalResponseKind::Approve,
    });
    assert!(is_wire_message(&msg));
    assert!(is_event(&msg));
    assert!(!is_request(&msg));

    let msg = WireMessage::ApprovalRequest(ApprovalRequest::new(
        "request_123",
        "call_999",
        "bash",
        "Execute dangerous command",
        "This command will delete files",
        Vec::new(),
    ));
    assert!(is_wire_message(&msg));
    assert!(!is_event(&msg));
    assert!(is_request(&msg));

    let mut call = ToolCall::new("call_123", "bash");
    call.function.arguments = Some("{}".to_string());
    let msg = WireMessage::ToolCallRequest(ToolCallRequest::from_tool_call(&call));
    assert!(is_wire_message(&msg));
    assert!(!is_event(&msg));
    assert!(is_request(&msg));
}
