use std::collections::VecDeque;

use async_trait::async_trait;
use tracing::debug;

use kosong::chat_provider::ChatProviderError;
use kosong::message::{ContentPart, Message, Role, TextPart, ThinkPart};
use kosong::tooling::empty::EmptyToolset;

use crate::llm::LLM;
use crate::prompts;
use crate::soul::message::system;

#[async_trait(?Send)]
pub trait Compaction: Send + Sync {
    async fn compact(
        &self,
        messages: &[Message],
        llm: &LLM,
    ) -> Result<Vec<Message>, ChatProviderError>;
}

pub struct SimpleCompaction {
    pub max_preserved_messages: usize,
}

impl SimpleCompaction {
    pub fn new(max_preserved_messages: usize) -> Self {
        Self {
            max_preserved_messages,
        }
    }

    fn prepare(&self, messages: &[Message]) -> PrepareResult {
        if messages.is_empty() || self.max_preserved_messages == 0 {
            return PrepareResult {
                compact_message: None,
                to_preserve: messages.to_vec(),
            };
        }

        let mut preserve_start_index = messages.len();
        let mut preserved = 0usize;
        for (index, message) in messages.iter().enumerate().rev() {
            if matches!(message.role, Role::User | Role::Assistant) {
                preserved += 1;
                if preserved == self.max_preserved_messages {
                    preserve_start_index = index;
                    break;
                }
            }
        }

        if preserved < self.max_preserved_messages {
            return PrepareResult {
                compact_message: None,
                to_preserve: messages.to_vec(),
            };
        }

        let to_compact = &messages[..preserve_start_index];
        let to_preserve = messages[preserve_start_index..].to_vec();

        if to_compact.is_empty() {
            return PrepareResult {
                compact_message: None,
                to_preserve,
            };
        }

        let mut compact_message = Message::new(Role::User, Vec::new());
        for (idx, msg) in to_compact.iter().enumerate() {
            compact_message
                .content
                .push(ContentPart::Text(TextPart::new(format!(
                    "## Message {}\nRole: {}\nContent:\n",
                    idx + 1,
                    role_label(&msg.role)
                ))));
            compact_message.content.extend(
                msg.content
                    .iter()
                    .filter(|part| !matches!(part, ContentPart::Think(_)))
                    .cloned(),
            );
        }
        compact_message
            .content
            .push(ContentPart::Text(TextPart::new(format!(
                "\n{}",
                prompts::COMPACT
            ))));

        PrepareResult {
            compact_message: Some(compact_message),
            to_preserve,
        }
    }
}

#[async_trait(?Send)]
impl Compaction for SimpleCompaction {
    async fn compact(
        &self,
        messages: &[Message],
        llm: &LLM,
    ) -> Result<Vec<Message>, ChatProviderError> {
        let prepared = self.prepare(messages);
        let compact_message = match prepared.compact_message {
            Some(message) => message,
            None => return Ok(prepared.to_preserve),
        };

        debug!("Compacting context...");
        let result = kosong::step(
            llm.chat_provider.as_ref(),
            "You are a helpful assistant that compacts conversation context.",
            &EmptyToolset,
            &[compact_message],
            None,
            None,
        )
        .await?;
        if let Some(usage) = &result.usage {
            debug!(
                "Compaction used {} input tokens and {} output tokens",
                usage.input(),
                usage.output
            );
        }

        let mut content: Vec<ContentPart> = vec![system(
            "Previous context has been compacted. Here is the compaction output:",
        )];
        content.extend(
            result
                .message
                .content
                .into_iter()
                .filter(|part| !matches!(part, ContentPart::Think(ThinkPart { .. }))),
        );

        let mut compacted_messages = VecDeque::new();
        compacted_messages.push_back(Message::new(Role::User, content));
        compacted_messages.extend(prepared.to_preserve);
        Ok(compacted_messages.into())
    }
}

struct PrepareResult {
    compact_message: Option<Message>,
    to_preserve: Vec<Message>,
}

fn role_label(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

#[cfg(test)]
mod tests {
    use super::{SimpleCompaction, role_label};
    use crate::prompts;
    use kosong::message::{ContentPart, Message, Role, TextPart, ThinkPart};

    #[test]
    fn test_prepare_returns_original_when_not_enough_messages() {
        let messages = vec![Message::new(
            Role::User,
            vec![ContentPart::Text(TextPart::new("Only one message"))],
        )];

        let result = SimpleCompaction::new(2).prepare(&messages);

        assert!(result.compact_message.is_none());
        assert_eq!(result.to_preserve, messages);
    }

    #[test]
    fn test_prepare_skips_compaction_with_only_preserved_messages() {
        let messages = vec![
            Message::new(
                Role::User,
                vec![ContentPart::Text(TextPart::new("Latest question"))],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new("Latest reply"))],
            ),
        ];

        let result = SimpleCompaction::new(2).prepare(&messages);

        assert!(result.compact_message.is_none());
        assert_eq!(result.to_preserve, messages);
    }

    #[test]
    fn test_prepare_builds_compact_message_and_preserves_tail() {
        let messages = vec![
            Message::new(
                Role::System,
                vec![ContentPart::Text(TextPart::new("System note"))],
            ),
            Message::new(
                Role::User,
                vec![
                    ContentPart::Text(TextPart::new("Old question")),
                    ContentPart::Think(ThinkPart::new("Hidden thoughts")),
                ],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new("Old answer"))],
            ),
            Message::new(
                Role::User,
                vec![ContentPart::Text(TextPart::new("Latest question"))],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new("Latest answer"))],
            ),
        ];

        let result = SimpleCompaction::new(2).prepare(&messages);

        let mut compact_message = Message::new(Role::User, Vec::new());
        let to_compact = &messages[..3];
        for (idx, msg) in to_compact.iter().enumerate() {
            compact_message
                .content
                .push(ContentPart::Text(TextPart::new(format!(
                    "## Message {}\nRole: {}\nContent:\n",
                    idx + 1,
                    role_label(&msg.role)
                ))));
            compact_message.content.extend(
                msg.content
                    .iter()
                    .filter(|part| !matches!(part, ContentPart::Think(_)))
                    .cloned(),
            );
        }
        compact_message
            .content
            .push(ContentPart::Text(TextPart::new(format!(
                "\n{}",
                prompts::COMPACT
            ))));

        assert_eq!(result.compact_message, Some(compact_message));
        assert_eq!(result.to_preserve, messages[3..].to_vec());
    }
}
