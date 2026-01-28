use std::any::Any;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

use crate::chat_provider::{
    ChatProvider, ChatProviderError, ChatProviderErrorKind, StreamedMessage, ThinkingEffort,
};
use crate::message::{Message, StreamedMessagePart};
use crate::tooling::Tool;

use super::dsl::parse_echo_script;

pub struct ScriptedEchoChatProvider {
    scripts: Mutex<VecDeque<String>>,
    turn: AtomicUsize,
    trace: bool,
}

impl ScriptedEchoChatProvider {
    pub fn new<I: IntoIterator<Item = String>>(scripts: I, trace: bool) -> Self {
        Self {
            scripts: Mutex::new(scripts.into_iter().collect()),
            turn: AtomicUsize::new(0),
            trace,
        }
    }
}

#[async_trait]
impl ChatProvider for ScriptedEchoChatProvider {
    fn name(&self) -> &str {
        "scripted_echo"
    }

    fn model_name(&self) -> &str {
        "scripted_echo"
    }

    fn thinking_effort(&self) -> Option<ThinkingEffort> {
        None
    }

    async fn generate(
        &self,
        _system_prompt: &str,
        _tools: &[Tool],
        _history: &[Message],
    ) -> Result<Box<dyn StreamedMessage>, ChatProviderError> {
        let mut scripts = self.scripts.lock().expect("scripted echo scripts lock");
        if scripts.is_empty() {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                format!(
                    "ScriptedEchoChatProvider exhausted at turn {}.",
                    self.turn.load(Ordering::SeqCst) + 1
                ),
            ));
        }
        let script_text = scripts.pop_front().unwrap();
        drop(scripts);
        let turn = self.turn.fetch_add(1, Ordering::SeqCst) + 1;
        if self.trace {
            println!(
                "SCRIPTED_ECHO TURN {}: {}",
                turn,
                serde_json::to_string(&script_text).unwrap_or_default()
            );
        }
        let (parts, message_id, usage) = parse_echo_script(&script_text)?;
        if parts.is_empty() {
            return Err(ChatProviderError::new(
                ChatProviderErrorKind::Other,
                "ScriptedEchoChatProvider DSL produced no streamable parts.",
            ));
        }
        Ok(Box::new(ScriptedEchoStreamedMessage::new(
            parts, message_id, usage,
        )))
    }

    fn with_thinking(&self, _effort: ThinkingEffort) -> Box<dyn ChatProvider> {
        let scripts = self
            .scripts
            .lock()
            .expect("scripted echo scripts lock")
            .clone();
        let turn = self.turn.load(Ordering::SeqCst);
        Box::new(ScriptedEchoChatProvider {
            scripts: Mutex::new(scripts),
            turn: AtomicUsize::new(turn),
            trace: self.trace,
        })
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct ScriptedEchoStreamedMessage {
    parts: Vec<StreamedMessagePart>,
    index: usize,
    id: Option<String>,
    usage: Option<crate::chat_provider::TokenUsage>,
}

impl ScriptedEchoStreamedMessage {
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
impl StreamedMessage for ScriptedEchoStreamedMessage {
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
