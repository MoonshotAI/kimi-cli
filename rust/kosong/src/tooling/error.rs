use crate::tooling::{ToolOutput, ToolReturnValue, tool_error};

pub fn tool_not_found(tool_name: &str) -> ToolReturnValue {
    tool_error(
        ToolOutput::Text(String::new()),
        format!("Tool `{}` not found", tool_name),
        &format!("Tool `{}` not found", tool_name),
    )
}

pub fn tool_parse_error(message: &str) -> ToolReturnValue {
    tool_error(
        ToolOutput::Text(String::new()),
        format!("Error parsing JSON arguments: {}", message),
        "Invalid arguments",
    )
}

pub fn tool_validate_error(message: &str) -> ToolReturnValue {
    tool_error(
        ToolOutput::Text(String::new()),
        format!("Error validating JSON arguments: {}", message),
        "Invalid arguments",
    )
}

pub fn tool_runtime_error(message: &str) -> ToolReturnValue {
    tool_error(
        ToolOutput::Text(String::new()),
        format!("Error running tool: {}", message),
        "Tool runtime error",
    )
}
