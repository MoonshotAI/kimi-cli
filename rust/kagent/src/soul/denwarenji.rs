use schemars::JsonSchema;
use serde::Deserialize;
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DMail {
    pub message: String,
    pub checkpoint_id: i64,
}

#[derive(Debug, Error)]
pub enum DenwaRenjiError {
    #[error("only one D-Mail can be sent at a time")]
    AlreadyPending,
    #[error("the checkpoint ID can not be negative")]
    NegativeCheckpoint,
    #[error("there is no checkpoint with the given ID")]
    InvalidCheckpoint,
}

pub struct DenwaRenji {
    pending: Option<DMail>,
    n_checkpoints: i64,
}

impl DenwaRenji {
    pub fn new() -> Self {
        Self {
            pending: None,
            n_checkpoints: 0,
        }
    }

    pub fn send_dmail(&mut self, dmail: DMail) -> Result<(), DenwaRenjiError> {
        if self.pending.is_some() {
            return Err(DenwaRenjiError::AlreadyPending);
        }
        if dmail.checkpoint_id < 0 {
            return Err(DenwaRenjiError::NegativeCheckpoint);
        }
        if dmail.checkpoint_id >= self.n_checkpoints {
            return Err(DenwaRenjiError::InvalidCheckpoint);
        }
        self.pending = Some(dmail);
        Ok(())
    }

    pub fn set_n_checkpoints(&mut self, n_checkpoints: i64) {
        self.n_checkpoints = n_checkpoints;
    }

    pub fn fetch_pending_dmail(&mut self) -> Option<DMail> {
        self.pending.take()
    }
}

impl Default for DenwaRenji {
    fn default() -> Self {
        Self::new()
    }
}
