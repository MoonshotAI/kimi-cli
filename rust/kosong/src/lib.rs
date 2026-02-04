//! Kosong: LLM abstraction layer.

pub mod chat_provider;
pub mod message;
pub mod tooling;
pub mod utils;

mod generate;

pub use generate::{GenerateResult, generate};

use std::collections::HashMap;

use chat_provider::{ChatProvider, TokenUsage};
use message::{Message, StreamedMessagePart, ToolCall};
use tokio::sync::{mpsc, oneshot};
use tooling::error::tool_runtime_error;
use tooling::{ToolResult, ToolResultFuture, Toolset};

/// Run one step (generate + tool dispatch).
pub async fn step(
    chat_provider: &dyn ChatProvider,
    system_prompt: &str,
    toolset: &dyn Toolset,
    history: &[Message],
    message_part_tx: Option<mpsc::UnboundedSender<StreamedMessagePart>>,
    tool_result_tx: Option<mpsc::UnboundedSender<ToolResult>>,
) -> Result<StepResult, chat_provider::ChatProviderError> {
    let mut tool_calls = Vec::new();
    let mut tool_result_receivers: HashMap<String, oneshot::Receiver<anyhow::Result<ToolResult>>> =
        HashMap::new();

    let result = {
        let tool_calls_ref = &mut tool_calls;
        let tool_results_ref = &mut tool_result_receivers;
        let tool_result_tx = tool_result_tx.clone();

        let mut on_tool_call = move |tool_call: ToolCall| {
            tool_calls_ref.push(tool_call.clone());
            let (result_tx, result_rx) = oneshot::channel();
            tool_results_ref.insert(tool_call.id.clone(), result_rx);
            let result = toolset.handle(tool_call.clone());
            match result {
                ToolResultFuture::Immediate(res) => {
                    if let Some(tx) = tool_result_tx.as_ref() {
                        let _ = tx.send(res.clone());
                    }
                    let _ = result_tx.send(Ok(res));
                }
                ToolResultFuture::Pending(fut) => {
                    let tool_result_tx = tool_result_tx.clone();
                    let tool_call_id = tool_call.id.clone();
                    tokio::spawn(async move {
                        let result = match fut.await {
                            Ok(res) => res,
                            Err(err) => ToolResult {
                                tool_call_id,
                                return_value: tool_runtime_error(&err.to_string()),
                            },
                        };
                        if let Some(tx) = tool_result_tx {
                            let _ = tx.send(result.clone());
                        }
                        let _ = result_tx.send(Ok(result));
                    });
                }
            }
        };

        generate::generate(
            chat_provider,
            system_prompt,
            toolset.tools(),
            history,
            message_part_tx,
            Some(&mut on_tool_call),
        )
        .await?
    };

    Ok(StepResult {
        id: result.id,
        message: result.message,
        usage: result.usage,
        tool_calls,
        tool_result_receivers,
    })
}

/// Step result returned by `step`.
pub struct StepResult {
    pub id: Option<String>,
    pub message: Message,
    pub usage: Option<TokenUsage>,
    pub tool_calls: Vec<ToolCall>,
    tool_result_receivers: HashMap<String, oneshot::Receiver<anyhow::Result<ToolResult>>>,
}

impl StepResult {
    pub async fn tool_results(&mut self) -> anyhow::Result<Vec<ToolResult>> {
        let mut results = Vec::new();
        for tool_call in &self.tool_calls {
            if let Some(rx) = self.tool_result_receivers.remove(&tool_call.id) {
                let result = rx
                    .await
                    .map_err(|_| anyhow::anyhow!("Tool result channel closed"))??;
                results.push(result);
            }
        }
        Ok(results)
    }
}
