use std::path::PathBuf;

use anyhow::{Result, anyhow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, error};

use kosong::message::{Message, Role};

use crate::soul::message::system;
use crate::utils::next_available_rotation;

#[derive(Debug)]
pub struct Context {
    file_backend: PathBuf,
    history: Vec<Message>,
    token_count: i64,
    next_checkpoint_id: i64,
}

impl Context {
    pub fn new(file_backend: PathBuf) -> Self {
        Self {
            file_backend,
            history: Vec::new(),
            token_count: 0,
            next_checkpoint_id: 0,
        }
    }

    pub async fn restore(&mut self) -> Result<bool> {
        debug!(
            "Restoring context from file: {}",
            self.file_backend.display()
        );
        if !self.history.is_empty() {
            error!("The context storage is already modified");
            return Err(anyhow!("The context storage is already modified"));
        }
        let metadata = match tokio::fs::metadata(&self.file_backend).await {
            Ok(metadata) => metadata,
            Err(_) => {
                debug!("No context file found, skipping restoration");
                return Ok(false);
            }
        };
        if metadata.len() == 0 {
            debug!("Empty context file, skipping restoration");
            return Ok(false);
        }

        let file = tokio::fs::File::open(&self.file_backend).await?;
        let mut lines = BufReader::new(file).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(&line)?;
            if value.get("role").and_then(|v| v.as_str()) == Some("_usage") {
                if let Some(token_count) = value.get("token_count").and_then(|v| v.as_i64()) {
                    self.token_count = token_count;
                }
                continue;
            }
            if value.get("role").and_then(|v| v.as_str()) == Some("_checkpoint") {
                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    self.next_checkpoint_id = id + 1;
                }
                continue;
            }
            let message: Message = serde_json::from_value(value)?;
            self.history.push(message);
        }
        Ok(true)
    }

    pub fn history(&self) -> &[Message] {
        &self.history
    }

    pub fn token_count(&self) -> i64 {
        self.token_count
    }

    pub fn n_checkpoints(&self) -> i64 {
        self.next_checkpoint_id
    }

    pub fn file_backend(&self) -> &PathBuf {
        &self.file_backend
    }

    pub async fn checkpoint(&mut self, add_user_message: bool) -> Result<()> {
        let checkpoint_id = self.next_checkpoint_id;
        self.next_checkpoint_id += 1;
        debug!("Checkpointing, ID: {}", checkpoint_id);

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_backend)
            .await?;
        let line = serde_json::json!({"role": "_checkpoint", "id": checkpoint_id});
        file.write_all(line.to_string().as_bytes()).await?;
        file.write_all(b"\n").await?;

        if add_user_message {
            let message = Message::new(
                Role::User,
                vec![system(&format!("CHECKPOINT {checkpoint_id}"))],
            );
            self.append_messages(message).await?;
        }

        Ok(())
    }

    pub async fn revert_to(&mut self, checkpoint_id: i64) -> Result<()> {
        debug!("Reverting checkpoint, ID: {}", checkpoint_id);
        if checkpoint_id >= self.next_checkpoint_id {
            error!("Checkpoint {} does not exist", checkpoint_id);
            return Err(anyhow!("Checkpoint {checkpoint_id} does not exist"));
        }
        let rotated = next_available_rotation(&self.file_backend)
            .await
            .ok_or_else(|| {
                error!("No available rotation path found");
                anyhow!("No available rotation path found")
            })?;
        tokio::fs::rename(&self.file_backend, &rotated).await?;
        debug!("Rotated context file: {}", rotated.display());

        self.history.clear();
        self.token_count = 0;
        self.next_checkpoint_id = 0;

        let old_file = tokio::fs::File::open(&rotated).await?;
        let mut old_lines = BufReader::new(old_file).lines();
        let mut new_file = tokio::fs::File::create(&self.file_backend).await?;
        while let Ok(Some(line)) = old_lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(&line)?;
            if value.get("role").and_then(|v| v.as_str()) == Some("_checkpoint") {
                if value.get("id").and_then(|v| v.as_i64()) == Some(checkpoint_id) {
                    break;
                }
            }
            new_file.write_all(line.as_bytes()).await?;
            new_file.write_all(b"\n").await?;

            if value.get("role").and_then(|v| v.as_str()) == Some("_usage") {
                if let Some(token_count) = value.get("token_count").and_then(|v| v.as_i64()) {
                    self.token_count = token_count;
                }
            } else if value.get("role").and_then(|v| v.as_str()) == Some("_checkpoint") {
                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    self.next_checkpoint_id = id + 1;
                }
            } else {
                let message: Message = serde_json::from_value(value)?;
                self.history.push(message);
            }
        }
        Ok(())
    }

    pub async fn clear(&mut self) -> Result<()> {
        debug!("Clearing context");
        let rotated = next_available_rotation(&self.file_backend)
            .await
            .ok_or_else(|| {
                error!("No available rotation path found");
                anyhow!("No available rotation path found")
            })?;
        tokio::fs::rename(&self.file_backend, &rotated).await?;
        let _ = tokio::fs::File::create(&self.file_backend).await?;
        debug!("Rotated context file: {}", rotated.display());

        self.history.clear();
        self.token_count = 0;
        self.next_checkpoint_id = 0;
        Ok(())
    }

    pub async fn append_messages<M>(&mut self, messages: M) -> Result<()>
    where
        M: Into<ContextMessages>,
    {
        let messages = match messages.into() {
            ContextMessages::One(message) => vec![message],
            ContextMessages::Many(messages) => messages,
        };
        debug!("Appending message(s) to context: {:?}", messages);
        self.history.extend(messages.clone());

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_backend)
            .await?;
        for message in messages {
            let mut value = serde_json::to_value(&message)?;
            strip_message_nulls(&mut value);
            let line = serde_json::to_string(&value)?;
            file.write_all(line.as_bytes()).await?;
            file.write_all(b"\n").await?;
        }
        Ok(())
    }

    pub async fn update_token_count(&mut self, token_count: i64) -> Result<()> {
        debug!("Updating token count in context: {}", token_count);
        self.token_count = token_count;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_backend)
            .await?;
        let line = serde_json::json!({"role": "_usage", "token_count": token_count});
        file.write_all(line.to_string().as_bytes()).await?;
        file.write_all(b"\n").await?;
        Ok(())
    }
}

fn strip_message_nulls(value: &mut serde_json::Value) {
    let serde_json::Value::Object(map) = value else {
        return;
    };

    for key in ["name", "tool_calls", "tool_call_id", "partial"] {
        if matches!(map.get(key), Some(serde_json::Value::Null)) {
            map.remove(key);
        }
    }

    let Some(serde_json::Value::Array(tool_calls)) = map.get_mut("tool_calls") else {
        return;
    };

    for call in tool_calls.iter_mut() {
        let serde_json::Value::Object(call_map) = call else {
            continue;
        };
        if matches!(call_map.get("extras"), Some(serde_json::Value::Null)) {
            call_map.remove("extras");
        }
        if let Some(serde_json::Value::Object(function)) = call_map.get_mut("function") {
            if matches!(function.get("arguments"), Some(serde_json::Value::Null)) {
                function.remove("arguments");
            }
        }
    }
}

pub enum ContextMessages {
    One(Message),
    Many(Vec<Message>),
}

impl From<Message> for ContextMessages {
    fn from(value: Message) -> Self {
        ContextMessages::One(value)
    }
}

impl From<Vec<Message>> for ContextMessages {
    fn from(value: Vec<Message>) -> Self {
        ContextMessages::Many(value)
    }
}
