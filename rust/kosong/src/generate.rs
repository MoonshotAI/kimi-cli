use crate::chat_provider::{ChatProvider, ChatProviderError, ChatProviderErrorKind, TokenUsage};
use crate::message::{Message, Role, StreamedMessagePart, ToolCall};
use crate::tooling::Tool;
use tokio::sync::mpsc;
use tracing::trace;

pub struct GenerateResult {
    pub id: Option<String>,
    pub message: Message,
    pub usage: Option<TokenUsage>,
}

pub async fn generate(
    chat_provider: &dyn ChatProvider,
    system_prompt: &str,
    tools: Vec<Tool>,
    history: &[Message],
    message_part_tx: Option<mpsc::UnboundedSender<StreamedMessagePart>>,
    mut on_tool_call: Option<&mut dyn FnMut(ToolCall)>,
) -> Result<GenerateResult, ChatProviderError> {
    let mut message = Message::new(Role::Assistant, Vec::new());
    let mut pending: Option<StreamedMessagePart> = None;

    trace!("Generating with history: {:?}", history);
    let mut stream = chat_provider
        .generate(system_prompt, &tools, history)
        .await?;

    loop {
        let part = stream.next_part().await?;
        if part.is_none() {
            break;
        }
        let part = part.unwrap();
        trace!("Received part: {:?}", part);
        if let Some(tx) = message_part_tx.as_ref() {
            let _ = tx.send(part.clone());
        }

        if pending.is_none() {
            pending = Some(part);
            continue;
        }
        let mut current = pending.take().unwrap();
        if current.merge_in_place(&part) {
            pending = Some(current);
        } else {
            append_part(&mut message, current, &mut on_tool_call);
            pending = Some(part);
        }
    }

    if let Some(final_part) = pending {
        append_part(&mut message, final_part, &mut on_tool_call);
    }

    if message.content.is_empty()
        && message
            .tool_calls
            .as_ref()
            .map(|v| v.is_empty())
            .unwrap_or(true)
    {
        return Err(ChatProviderError::new(
            ChatProviderErrorKind::EmptyResponse,
            "The API returned an empty response.",
        ));
    }

    Ok(GenerateResult {
        id: stream.id(),
        message,
        usage: stream.usage(),
    })
}

fn append_part(
    message: &mut Message,
    part: StreamedMessagePart,
    on_tool_call: &mut Option<&mut dyn FnMut(ToolCall)>,
) {
    match part {
        StreamedMessagePart::Content(content) => {
            message.content.push(content);
        }
        StreamedMessagePart::ToolCall(tool_call) => {
            if message.tool_calls.is_none() {
                message.tool_calls = Some(Vec::new());
            }
            if let Some(list) = &mut message.tool_calls {
                list.push(tool_call.clone());
            }
            if let Some(cb) = on_tool_call.as_deref_mut() {
                cb(tool_call);
            }
        }
        StreamedMessagePart::ToolCallPart(_) => {
            // orphaned tool call part; ignore
        }
    }
}
