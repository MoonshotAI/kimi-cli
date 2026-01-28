use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;
use serde_json::Value;

use crate::message::ToolCall;
use crate::tooling::error::{
    tool_not_found, tool_parse_error, tool_runtime_error, tool_validate_error,
};
use crate::tooling::{CallableTool, Tool, ToolResult, ToolResultFuture, Toolset};

pub struct SimpleToolset {
    tools: HashMap<String, Arc<dyn CallableTool>>,
}

impl SimpleToolset {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn add(&mut self, tool: Arc<dyn CallableTool>) {
        let name = tool.base().name.clone();
        self.tools.insert(name, tool);
    }

    pub fn remove(&mut self, name: &str) -> Result<(), String> {
        if self.tools.remove(name).is_none() {
            return Err(format!("Tool `{}` not found in the toolset.", name));
        }
        Ok(())
    }
}

impl Default for SimpleToolset {
    fn default() -> Self {
        Self::new()
    }
}

impl Toolset for SimpleToolset {
    fn tools(&self) -> Vec<Tool> {
        self.tools.values().map(|tool| tool.base()).collect()
    }

    fn handle(&self, tool_call: ToolCall) -> ToolResultFuture {
        let tool = match self.tools.get(&tool_call.function.name) {
            Some(tool) => tool,
            None => {
                return ToolResultFuture::Immediate(ToolResult {
                    tool_call_id: tool_call.id,
                    return_value: tool_not_found(&tool_call.function.name),
                });
            }
        };

        let arguments = tool_call
            .function
            .arguments
            .clone()
            .unwrap_or_else(|| "{}".to_string());
        let args: Value = match serde_json::from_str(&arguments) {
            Ok(value) => value,
            Err(err) => {
                return ToolResultFuture::Immediate(ToolResult {
                    tool_call_id: tool_call.id,
                    return_value: tool_parse_error(&err.to_string()),
                });
            }
        };

        let tool_call_id = tool_call.id.clone();
        let schema = tool.base().parameters;
        let compiled = match jsonschema::validator_for(&schema) {
            Ok(compiled) => compiled,
            Err(err) => {
                return ToolResultFuture::Immediate(ToolResult {
                    tool_call_id,
                    return_value: tool_runtime_error(&err.to_string()),
                });
            }
        };
        if let Err(err) = compiled.validate(&args) {
            let msg = err.to_string();
            return ToolResultFuture::Immediate(ToolResult {
                tool_call_id,
                return_value: tool_validate_error(&msg),
            });
        }
        let tool_ref = Arc::clone(tool);
        ToolResultFuture::Pending(tokio::task::spawn(async move {
            let result = AssertUnwindSafe(tool_ref.call(args))
                .catch_unwind()
                .await
                .unwrap_or_else(|panic| tool_runtime_error(&panic_message(panic)));
            ToolResult {
                tool_call_id,
                return_value: result,
            }
        }))
    }
}

fn panic_message(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        message.to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "tool panicked".to_string()
    }
}
