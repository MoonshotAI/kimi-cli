use std::any::Any;
use std::fmt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::message::{Message, StreamedMessagePart};
use crate::tooling::Tool;

pub mod echo;
pub mod kimi;

#[async_trait]
pub trait StreamedMessage: Send {
    async fn next_part(&mut self) -> Result<Option<StreamedMessagePart>, ChatProviderError>;
    fn id(&self) -> Option<String>;
    fn usage(&self) -> Option<TokenUsage>;
}

#[async_trait]
pub trait ChatProvider: Send + Sync {
    fn name(&self) -> &str;
    fn model_name(&self) -> &str;
    fn thinking_effort(&self) -> Option<ThinkingEffort>;
    async fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
    ) -> Result<Box<dyn StreamedMessage>, ChatProviderError>;
    fn with_thinking(&self, effort: ThinkingEffort) -> Box<dyn ChatProvider>;
    fn as_any(&self) -> &dyn Any;
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_other: i64,
    pub output: i64,
    #[serde(default)]
    pub input_cache_read: i64,
    #[serde(default)]
    pub input_cache_creation: i64,
}

impl TokenUsage {
    pub fn total(&self) -> i64 {
        self.input() + self.output
    }

    pub fn input(&self) -> i64 {
        self.input_other + self.input_cache_read + self.input_cache_creation
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingEffort {
    Off,
    Low,
    Medium,
    High,
}

#[derive(Debug)]
pub struct ChatProviderError {
    pub message: String,
    pub kind: ChatProviderErrorKind,
}

#[derive(Debug)]
pub enum ChatProviderErrorKind {
    Connection,
    Timeout,
    Status(u16),
    EmptyResponse,
    Other,
}

impl ChatProviderError {
    pub fn new(kind: ChatProviderErrorKind, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind,
        }
    }
}

impl fmt::Display for ChatProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ChatProviderError {}
