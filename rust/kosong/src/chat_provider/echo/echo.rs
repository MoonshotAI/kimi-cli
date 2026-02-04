use std::any::Any;

use async_trait::async_trait;

use crate::chat_provider::{
    ChatProvider, ChatProviderError, ChatProviderErrorKind, StreamedMessage, ThinkingEffort,
};
use crate::message::{Message, StreamedMessagePart};
use crate::tooling::Tool;

use super::dsl::parse_echo_script;

pub struct EchoChatProvider;

#[async_trait]
impl ChatProvider for EchoChatProvider {
    fn name(&self) -> &str {
        "echo"
    }

    fn model_name(&self) -> &str {
        "echo"
    }

    fn thinking_effort(&self) -> Option<ThinkingEffort> {
        None
    }

    async fn generate(
        &self,
        _system_prompt: &str,
        _tools: &[Tool],
        history: &[Message],
    ) -> Result<Box<dyn StreamedMessage>, ChatProviderError> {
        if history.is_empty() {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                "EchoChatProvider requires at least one message in history.",
            ));
        }
        if history.last().map(|m| m.role.clone()) != Some(crate::message::Role::User) {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                "EchoChatProvider expects last history message to be user.",
            ));
        }
        let script_text = history.last().unwrap().extract_text("");
        let (parts, message_id, usage) = parse_echo_script(&script_text)?;
        if parts.is_empty() {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                "EchoChatProvider DSL produced no streamable parts.",
            ));
        }
        Ok(Box::new(EchoStreamedMessage::new(parts, message_id, usage)))
    }

    fn with_thinking(&self, _effort: ThinkingEffort) -> Box<dyn ChatProvider> {
        Box::new(EchoChatProvider)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct EchoStreamedMessage {
    parts: Vec<StreamedMessagePart>,
    index: usize,
    id: Option<String>,
    usage: Option<crate::chat_provider::TokenUsage>,
}

impl EchoStreamedMessage {
    pub fn new(
        parts: Vec<StreamedMessagePart>,
        id: Option<String>,
        usage: Option<crate::chat_provider::TokenUsage>,
    ) -> Self {
        Self {
            parts,
            index: 0,
            id,
            usage,
        }
    }
}

#[async_trait]
impl StreamedMessage for EchoStreamedMessage {
    async fn next_part(&mut self) -> Result<Option<StreamedMessagePart>, ChatProviderError> {
        if self.index >= self.parts.len() {
            return Ok(None);
        }
        let part = self.parts[self.index].clone();
        self.index += 1;
        Ok(Some(part))
    }

    fn id(&self) -> Option<String> {
        self.id.clone()
    }

    fn usage(&self) -> Option<crate::chat_provider::TokenUsage> {
        self.usage.clone()
    }
}
