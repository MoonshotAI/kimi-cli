use std::collections::HashSet;

use kagent::config::ModelCapability;
use kagent::soul::message::{check_message, system, tool_result_to_message};
use kosong::message::{
    ContentPart, ImageURLPart, Message, Role, TextPart, ThinkPart, VideoURLPart,
};
use kosong::tooling::{ToolOutput, ToolResult, ToolReturnValue};

fn tool_value(is_error: bool, output: ToolOutput, message: &str) -> ToolReturnValue {
    ToolReturnValue {
        is_error,
        output,
        message: message.to_string(),
        display: Vec::new(),
        extras: None,
    }
}

#[test]
fn test_system_message_creation() {
    let message = "Test message";
    assert_eq!(
        system(message),
        ContentPart::Text(TextPart::new("<system>Test message</system>"))
    );
}

#[test]
fn test_tool_ok_with_string_output() {
    let tool_ok = tool_value(false, ToolOutput::from("Hello, world!"), "");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };
    let message = tool_result_to_message(&tool_result);
    assert_eq!(
        message,
        Message {
            role: Role::Tool,
            content: vec![ContentPart::Text(TextPart::new("Hello, world!"))],
            name: None,
            tool_calls: None,
            tool_call_id: Some("call_123".to_string()),
            partial: None,
        }
    );
}

#[test]
fn test_tool_ok_with_message() {
    let tool_ok = tool_value(false, ToolOutput::from("Result"), "Operation completed");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };
    let message = tool_result_to_message(&tool_result);
    assert_eq!(
        message,
        Message {
            role: Role::Tool,
            content: vec![
                ContentPart::Text(TextPart::new("<system>Operation completed</system>")),
                ContentPart::Text(TextPart::new("Result")),
            ],
            name: None,
            tool_calls: None,
            tool_call_id: Some("call_123".to_string()),
            partial: None,
        }
    );
}

#[test]
fn test_tool_ok_with_content_part() {
    let content_part = ContentPart::Text(TextPart::new("Text content"));
    let tool_ok = tool_value(false, ToolOutput::from(content_part.clone()), "");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };
    let message = tool_result_to_message(&tool_result);
    assert_eq!(
        message,
        Message {
            role: Role::Tool,
            content: vec![content_part],
            name: None,
            tool_calls: None,
            tool_call_id: Some("call_123".to_string()),
            partial: None,
        }
    );
}

#[test]
fn test_tool_ok_with_sequence_of_parts() {
    let text_part = ContentPart::Text(TextPart::new("Text content"));
    let text_part_2 = ContentPart::Text(TextPart::new("Text content 2"));
    let tool_ok = tool_value(
        false,
        ToolOutput::Parts(vec![text_part.clone(), text_part_2.clone()]),
        "",
    );
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };
    let message = tool_result_to_message(&tool_result);
    assert_eq!(
        message,
        Message {
            role: Role::Tool,
            content: vec![text_part, text_part_2],
            name: None,
            tool_calls: None,
            tool_call_id: Some("call_123".to_string()),
            partial: None,
        }
    );
}

#[test]
fn test_tool_ok_with_empty_output() {
    let tool_ok = tool_value(false, ToolOutput::from(""), "");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };
    let message = tool_result_to_message(&tool_result);
    assert_eq!(
        message,
        Message {
            role: Role::Tool,
            content: vec![ContentPart::Text(TextPart::new(
                "<system>Tool output is empty.</system>"
            ))],
            name: None,
            tool_calls: None,
            tool_call_id: Some("call_123".to_string()),
            partial: None,
        }
    );
}

#[test]
fn test_tool_ok_with_message_but_empty_output() {
    let tool_ok = tool_value(false, ToolOutput::from(""), "Just a message");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };
    let message = tool_result_to_message(&tool_result);
    assert_eq!(
        message,
        Message {
            role: Role::Tool,
            content: vec![ContentPart::Text(TextPart::new(
                "<system>Just a message</system>"
            ))],
            name: None,
            tool_calls: None,
            tool_call_id: Some("call_123".to_string()),
            partial: None,
        }
    );
}

#[test]
fn test_tool_error_result() {
    let tool_error = tool_value(true, ToolOutput::from("Error details"), "Error occurred");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_error,
    };

    let message = tool_result_to_message(&tool_result);

    assert_eq!(message.role, Role::Tool);
    assert_eq!(message.tool_call_id, Some("call_123".to_string()));
    assert_eq!(message.content.len(), 2);
    assert_eq!(message.content[0], system("ERROR: Error occurred"));
    assert_eq!(
        message.content[1],
        ContentPart::Text(TextPart::new("Error details"))
    );
}

#[test]
fn test_tool_error_without_output() {
    let tool_error = tool_value(true, ToolOutput::from(""), "Error occurred");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_error,
    };

    let message = tool_result_to_message(&tool_result);

    assert_eq!(message.role, Role::Tool);
    assert_eq!(message.content.len(), 1);
    assert_eq!(message.content[0], system("ERROR: Error occurred"));
}

#[test]
fn test_tool_ok_with_text_only() {
    let tool_ok = tool_value(false, ToolOutput::from("Simple output"), "Done");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };

    let message = tool_result_to_message(&tool_result);

    assert_eq!(message.role, Role::Tool);
    assert_eq!(message.tool_call_id, Some("call_123".to_string()));
    assert_eq!(message.content.len(), 2);
    assert_eq!(message.content[0], system("Done"));
    assert_eq!(
        message.content[1],
        ContentPart::Text(TextPart::new("Simple output"))
    );
}

#[test]
fn test_tool_ok_with_non_text_parts() {
    let text_part = ContentPart::Text(TextPart::new("Text content"));
    let image_part = ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.jpg"));
    let tool_ok = tool_value(
        false,
        ToolOutput::Parts(vec![text_part.clone(), image_part.clone()]),
        "Mixed content",
    );
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };

    let message = tool_result_to_message(&tool_result);

    assert_eq!(message.role, Role::Tool);
    assert_eq!(message.tool_call_id, Some("call_123".to_string()));
    assert_eq!(message.content.len(), 3);
    assert_eq!(message.content[0], system("Mixed content"));
    assert_eq!(message.content[1], text_part);
    assert_eq!(message.content[2], image_part);
}

#[test]
fn test_tool_ok_with_only_non_text_parts() {
    let image_part = ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.jpg"));
    let tool_ok = tool_value(false, ToolOutput::from(image_part.clone()), "");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };

    let message = tool_result_to_message(&tool_result);

    assert_eq!(message.role, Role::Tool);
    assert_eq!(message.tool_call_id, Some("call_123".to_string()));
    assert_eq!(message.content.len(), 1);
    assert_eq!(message.content[0], image_part);
}

#[test]
fn test_tool_ok_with_only_text_parts() {
    let tool_ok = tool_value(false, ToolOutput::from("Just text"), "");
    let tool_result = ToolResult {
        tool_call_id: "call_123".to_string(),
        return_value: tool_ok,
    };

    let message = tool_result_to_message(&tool_result);

    assert_eq!(message.role, Role::Tool);
    assert_eq!(message.content.len(), 1);
    assert_eq!(
        message.content[0],
        ContentPart::Text(TextPart::new("Just text"))
    );
}

#[test]
fn test_check_message_with_image_and_image_capability() {
    let image_part = ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.jpg"));
    let message = Message::new(Role::User, vec![image_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::ImageIn);
    model_capabilities.insert(ModelCapability::Thinking);

    let missing = check_message(&message, &model_capabilities);

    assert!(missing.is_empty());
}

#[test]
fn test_check_message_with_image_no_image_capability() {
    let image_part = ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.jpg"));
    let message = Message::new(Role::User, vec![image_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::Thinking);

    let missing = check_message(&message, &model_capabilities);

    assert_eq!(missing, HashSet::from([ModelCapability::ImageIn]));
}

#[test]
fn test_check_message_with_video_and_video_capability() {
    let video_part = ContentPart::VideoUrl(VideoURLPart::new("https://example.com/video.mp4"));
    let message = Message::new(Role::User, vec![video_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::VideoIn);

    let missing = check_message(&message, &model_capabilities);

    assert!(missing.is_empty());
}

#[test]
fn test_check_message_with_video_no_video_capability() {
    let video_part = ContentPart::VideoUrl(VideoURLPart::new("https://example.com/video.mp4"));
    let message = Message::new(Role::User, vec![video_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::ImageIn);

    let missing = check_message(&message, &model_capabilities);

    assert_eq!(missing, HashSet::from([ModelCapability::VideoIn]));
}

#[test]
fn test_check_message_with_think_and_think_capability() {
    let think_part = ContentPart::Think(ThinkPart::new("This is a thinking process"));
    let message = Message::new(Role::Assistant, vec![think_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::ImageIn);
    model_capabilities.insert(ModelCapability::Thinking);

    let missing = check_message(&message, &model_capabilities);

    assert!(missing.is_empty());
}

#[test]
fn test_check_message_with_think_no_think_capability() {
    let think_part = ContentPart::Think(ThinkPart::new("This is a thinking process"));
    let message = Message::new(Role::Assistant, vec![think_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::ImageIn);

    let missing = check_message(&message, &model_capabilities);

    assert_eq!(missing, HashSet::from([ModelCapability::Thinking]));
}

#[test]
fn test_check_message_with_mixed_parts_partial_capabilities() {
    let image_part = ContentPart::ImageUrl(ImageURLPart::new("https://example.com/image.jpg"));
    let think_part = ContentPart::Think(ThinkPart::new("Thinking..."));
    let message = Message::new(Role::User, vec![image_part, think_part]);
    let mut model_capabilities = HashSet::new();
    model_capabilities.insert(ModelCapability::ImageIn);

    let missing = check_message(&message, &model_capabilities);

    assert_eq!(missing, HashSet::from([ModelCapability::Thinking]));
}

#[test]
fn test_check_message_with_text_only() {
    let text_part = ContentPart::Text(TextPart::new("Just a text message"));
    let message = Message::new(Role::User, vec![text_part]);
    let model_capabilities = HashSet::new();

    let missing = check_message(&message, &model_capabilities);

    assert!(missing.is_empty());
}
