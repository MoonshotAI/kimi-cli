use crate::message::ToolCall;
use crate::tooling::error::tool_not_found;
use crate::tooling::{Tool, ToolResult, ToolResultFuture, Toolset};

pub struct EmptyToolset;

impl Toolset for EmptyToolset {
    fn tools(&self) -> Vec<Tool> {
        Vec::new()
    }

    fn handle(&self, tool_call: ToolCall) -> ToolResultFuture {
        ToolResultFuture::Immediate(ToolResult {
            tool_call_id: tool_call.id,
            return_value: tool_not_found(&tool_call.function.name),
        })
    }
}
