use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use thiserror::Error;
use tracing::debug;
use uuid::Uuid;

use crate::utils::{Queue, QueueShutDown};
use crate::wire::{ApprovalRequest, ApprovalResponseKind, DisplayBlock};

use super::toolset::get_current_tool_call_or_none;

#[derive(Debug, Error)]
pub enum ApprovalError {
    #[error("approval must be requested from a tool call")]
    NoToolCall,
    #[error("approval queue is shut down")]
    QueueShutDown,
    #[error("no pending approval request with id {0}")]
    RequestNotFound(String),
    #[error("approval response channel closed")]
    ResponseClosed,
}

struct ApprovalState {
    yolo: AtomicBool,
    auto_approve_actions: Mutex<HashSet<String>>,
}

impl ApprovalState {
    fn new(yolo: bool) -> Self {
        Self {
            yolo: AtomicBool::new(yolo),
            auto_approve_actions: Mutex::new(HashSet::new()),
        }
    }
}

pub struct Approval {
    request_queue: Queue<ApprovalRequest>,
    requests: Mutex<HashMap<String, ApprovalRequest>>,
    state: Arc<ApprovalState>,
}

impl Approval {
    pub fn new(yolo: bool) -> Self {
        Self {
            request_queue: Queue::new(),
            requests: Mutex::new(HashMap::new()),
            state: Arc::new(ApprovalState::new(yolo)),
        }
    }

    pub fn set_yolo(&self, yolo: bool) {
        self.state.yolo.store(yolo, Ordering::SeqCst);
    }

    pub fn is_yolo(&self) -> bool {
        self.state.yolo.load(Ordering::SeqCst)
    }

    pub fn share(&self) -> Self {
        Self {
            request_queue: Queue::new(),
            requests: Mutex::new(HashMap::new()),
            state: Arc::clone(&self.state),
        }
    }

    pub async fn request(
        &self,
        sender: &str,
        action: &str,
        description: &str,
        display: Option<Vec<DisplayBlock>>,
    ) -> Result<bool, ApprovalError> {
        let tool_call = get_current_tool_call_or_none().ok_or(ApprovalError::NoToolCall)?;
        debug!(
            "{} ({}) requesting approval: {} {}",
            tool_call.function.name, tool_call.id, action, description
        );

        if self.is_yolo() {
            return Ok(true);
        }

        if self
            .state
            .auto_approve_actions
            .lock()
            .unwrap()
            .contains(action)
        {
            return Ok(true);
        }

        let request = ApprovalRequest::new(
            Uuid::new_v4().to_string(),
            tool_call.id,
            sender,
            action,
            description,
            display.unwrap_or_default(),
        );

        self.request_queue
            .put_nowait(request.clone())
            .map_err(|QueueShutDown| ApprovalError::QueueShutDown)?;

        self.requests
            .lock()
            .unwrap()
            .insert(request.id.clone(), request.clone());

        let response = request.wait().await;
        let approved = match response {
            ApprovalResponseKind::Approve => true,
            ApprovalResponseKind::ApproveForSession => {
                self.state
                    .auto_approve_actions
                    .lock()
                    .unwrap()
                    .insert(request.action.clone());
                true
            }
            ApprovalResponseKind::Reject => false,
        };
        Ok(approved)
    }

    pub async fn fetch_request(&self) -> Result<ApprovalRequest, ApprovalError> {
        loop {
            let request = self
                .request_queue
                .get()
                .await
                .map_err(|QueueShutDown| ApprovalError::QueueShutDown)?;

            if self
                .state
                .auto_approve_actions
                .lock()
                .unwrap()
                .contains(&request.action)
            {
                debug!(
                    "Auto-approving previously requested action: {}",
                    request.action
                );
                let _ = self.resolve_request(&request.id, ApprovalResponseKind::Approve);
                continue;
            }

            return Ok(request);
        }
    }

    pub fn resolve_request(
        &self,
        request_id: &str,
        response: ApprovalResponseKind,
    ) -> Result<(), ApprovalError> {
        let request = {
            let mut requests = self.requests.lock().unwrap();
            requests
                .remove(request_id)
                .ok_or_else(|| ApprovalError::RequestNotFound(request_id.to_string()))?
        };

        if matches!(response, ApprovalResponseKind::ApproveForSession) {
            self.state
                .auto_approve_actions
                .lock()
                .unwrap()
                .insert(request.action.clone());
        }

        debug!(
            "Received approval response for request {}: {:?}",
            request_id, response
        );
        request.resolve(response);
        Ok(())
    }
}
