use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use kosong::chat_provider::ChatProviderError;
use kosong::tooling::tool_error;

use crate::constant::{NAME, VERSION};
use crate::soul::kimisoul::KimiSoul;
use crate::soul::{LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, Soul, run_soul};
use crate::utils::{Queue, QueueShutDown};
use crate::wire::{
    ApprovalRequest, ApprovalResponse, ToolCallRequest, ToolResult, Wire, WireMessage,
};

use crate::wire::jsonrpc::{
    InitializeParams, JsonRpcErrorObject, JsonRpcErrorResponse, JsonRpcErrorResponseNullableId,
    JsonRpcMessage, JsonRpcSuccessResponse, PromptParams, build_event_message,
    build_request_message, error_codes, statuses,
};
use crate::wire::protocol::WIRE_PROTOCOL_VERSION;

const STDIO_BUFFER_LIMIT: usize = 100 * 1024 * 1024;

enum PendingRequest {
    Approval(ApprovalRequest),
    ToolCall(ToolCallRequest),
}

pub struct WireServer {
    soul: Arc<KimiSoul>,
    write_queue: Queue<Value>,
    pending: Arc<tokio::sync::Mutex<HashMap<String, PendingRequest>>>,
    cancel_token: Arc<tokio::sync::Mutex<Option<CancellationToken>>>,
}

pub type WireOverStdio = WireServer;

impl WireServer {
    pub fn new(soul: Arc<KimiSoul>) -> Self {
        Self {
            soul,
            write_queue: Queue::new(),
            pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel_token: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub async fn serve(&mut self) -> anyhow::Result<()> {
        info!("Starting Wire server on stdio");
        let stdin = tokio::io::stdin();
        let stdout = tokio::io::stdout();
        let mut reader = BufReader::with_capacity(STDIO_BUFFER_LIMIT, stdin);
        let mut writer = stdout;

        let write_queue = self.write_queue.clone();
        let write_task = tokio::spawn(async move {
            loop {
                let msg = match write_queue.get().await {
                    Ok(msg) => msg,
                    Err(_) => {
                        debug!("Send queue shut down, stopping Wire server write loop");
                        break;
                    }
                };
                let line = match serde_json::to_string(&msg) {
                    Ok(line) => line,
                    Err(err) => {
                        error!("Wire server write loop error: {:?}", err);
                        continue;
                    }
                };
                if let Err(err) = writer.write_all(line.as_bytes()).await {
                    error!("Wire server write loop error: {:?}", err);
                    break;
                }
                if let Err(err) = writer.write_all(b"\n").await {
                    error!("Wire server write loop error: {:?}", err);
                    break;
                }
                let _ = writer.flush().await;
            }
        });

        let mut buf = Vec::new();
        loop {
            buf.clear();
            let n = reader.read_until(b'\n', &mut buf).await?;
            if n == 0 {
                info!("stdin closed, Wire server exiting");
                break;
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg_json: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(_) => {
                    error!("Invalid JSON line: {}", line);
                    self.send_error_nullable(error_codes::PARSE_ERROR, "Invalid JSON format", None)
                        .await;
                    continue;
                }
            };
            let response_hint = msg_json.get("method").is_none() && msg_json.get("id").is_some();
            let msg: JsonRpcMessage = match serde_json::from_value(msg_json.clone()) {
                Ok(msg) => msg,
                Err(err) => {
                    if response_hint {
                        error!("Invalid JSON-RPC response: {:?}", err);
                    } else {
                        error!("Invalid JSON-RPC message: {:?}", err);
                    }
                    let (code, message) = if response_hint {
                        (error_codes::INVALID_REQUEST, "Invalid response")
                    } else {
                        (error_codes::INVALID_REQUEST, "Invalid request")
                    };
                    self.send_error_nullable(code, message, None).await;
                    continue;
                }
            };

            if let Some(version) = &msg.jsonrpc {
                if version != "2.0" {
                    self.send_error_nullable(error_codes::INVALID_REQUEST, "Invalid request", None)
                        .await;
                    continue;
                }
            }

            if msg.is_response() {
                if msg.result.is_none() && msg.error.is_none() {
                    self.send_error_nullable(
                        error_codes::INVALID_REQUEST,
                        "Invalid response",
                        None,
                    )
                    .await;
                    continue;
                }
                self.handle_response(&msg).await;
                continue;
            }

            let method = match msg.method.as_deref() {
                Some(method) => method.to_string(),
                None => {
                    error!("Invalid JSON-RPC inbound message: {:?}", msg);
                    if let Some(id) = msg.id.clone() {
                        self.send_error(
                            id,
                            error_codes::METHOD_NOT_FOUND,
                            "Unexpected method received: None",
                        )
                        .await;
                    }
                    continue;
                }
            };

            match method.as_str() {
                "initialize" => self.handle_initialize(msg).await,
                "prompt" => self.handle_prompt(msg).await,
                "cancel" => self.handle_cancel(msg).await,
                _ => {
                    if let Some(id) = msg.id.clone() {
                        self.send_error(
                            id,
                            error_codes::METHOD_NOT_FOUND,
                            format!("Unexpected method received: {method}"),
                        )
                        .await;
                    }
                }
            }
        }

        self.shutdown().await;
        let _ = write_task.await;
        Ok(())
    }

    async fn handle_initialize(&mut self, msg: JsonRpcMessage) {
        let Some(id) = msg.id.clone() else {
            return;
        };
        if self.cancel_token.lock().await.is_some() {
            self.send_error(
                id,
                error_codes::INVALID_STATE,
                "An agent turn is already in progress",
            )
            .await;
            return;
        }
        let params: InitializeParams = match msg
            .params
            .clone()
            .and_then(|params| serde_json::from_value(params).ok())
        {
            Some(params) => params,
            None => {
                self.send_error(
                    id,
                    error_codes::INVALID_PARAMS,
                    "Invalid parameters for method `initialize`",
                )
                .await;
                return;
            }
        };

        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        if let Some(external_tools) = params.external_tools {
            let mut toolset = self.soul.agent().toolset.lock().await;
            for tool in external_tools {
                if toolset.has_builtin_tool(&tool.name) {
                    rejected
                        .push(json!({"name": tool.name, "reason": "conflicts with builtin tool"}));
                    continue;
                }
                match toolset.register_external_tool(&tool.name, &tool.description, tool.parameters)
                {
                    Ok(()) => accepted.push(tool.name),
                    Err(reason) => rejected.push(json!({"name": tool.name, "reason": reason})),
                }
            }
        }

        let slash_commands: Vec<Value> = self
            .soul
            .available_slash_commands()
            .into_iter()
            .map(|cmd| {
                json!({
                    "name": cmd.name,
                    "description": cmd.description,
                    "aliases": cmd.aliases,
                })
            })
            .collect();

        let mut result = json!({
            "protocol_version": WIRE_PROTOCOL_VERSION,
            "server": {"name": NAME, "version": VERSION},
            "slash_commands": slash_commands,
        });
        if !accepted.is_empty() || !rejected.is_empty() {
            result["external_tools"] = json!({
                "accepted": accepted,
                "rejected": rejected,
            });
        }

        let response = JsonRpcSuccessResponse {
            jsonrpc: "2.0",
            id,
            result,
        };
        let _ = self
            .write_queue
            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
    }

    async fn handle_prompt(&mut self, msg: JsonRpcMessage) {
        let Some(id) = msg.id.clone() else {
            return;
        };
        if self.cancel_token.lock().await.is_some() {
            self.send_error(
                id,
                error_codes::INVALID_STATE,
                "An agent turn is already in progress",
            )
            .await;
            return;
        }
        let params: PromptParams = match msg
            .params
            .clone()
            .and_then(|params| serde_json::from_value(params).ok())
        {
            Some(params) => params,
            None => {
                self.send_error(
                    id,
                    error_codes::INVALID_PARAMS,
                    "Invalid parameters for method `prompt`",
                )
                .await;
                return;
            }
        };

        let cancel_token = CancellationToken::new();
        let cancel_slot = Arc::clone(&self.cancel_token);
        *cancel_slot.lock().await = Some(cancel_token.clone());

        let soul = Arc::clone(&self.soul);
        let write_queue = self.write_queue.clone();
        let pending = Arc::clone(&self.pending);
        let wire_file = Some(self.soul.runtime().session.wire_file());

        tokio::spawn(async move {
            let write_queue_for_stream = write_queue.clone();
            let pending_for_stream = Arc::clone(&pending);
            let run_handle = tokio::task::spawn_blocking(move || {
                let handle = tokio::runtime::Handle::current();
                handle.block_on(run_soul(
                    soul.as_ref(),
                    params.user_input,
                    move |wire| {
                        stream_wire_messages(
                            write_queue_for_stream.clone(),
                            Arc::clone(&pending_for_stream),
                            wire,
                        )
                    },
                    cancel_token,
                    wire_file,
                ))
            });
            let run_result = match run_handle.await {
                Ok(result) => result,
                Err(err) => Err(anyhow::anyhow!("Wire run task failed: {err}")),
            };

            *cancel_slot.lock().await = None;

            match run_result {
                Ok(()) => {
                    let response = JsonRpcSuccessResponse {
                        jsonrpc: "2.0",
                        id,
                        result: json!({"status": statuses::FINISHED}),
                    };
                    let _ = write_queue
                        .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                }
                Err(err) => {
                    if err.is::<LLMNotSet>() {
                        let response = JsonRpcErrorResponse {
                            jsonrpc: "2.0",
                            id,
                            error: JsonRpcErrorObject {
                                code: error_codes::LLM_NOT_SET,
                                message: "LLM is not set".to_string(),
                                data: None,
                            },
                        };
                        let _ = write_queue
                            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                    } else if err.is::<LLMNotSupported>() {
                        let response = JsonRpcErrorResponse {
                            jsonrpc: "2.0",
                            id,
                            error: JsonRpcErrorObject {
                                code: error_codes::LLM_NOT_SUPPORTED,
                                message: err.to_string(),
                                data: None,
                            },
                        };
                        let _ = write_queue
                            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                    } else if err.is::<ChatProviderError>() {
                        let response = JsonRpcErrorResponse {
                            jsonrpc: "2.0",
                            id,
                            error: JsonRpcErrorObject {
                                code: error_codes::CHAT_PROVIDER_ERROR,
                                message: err.to_string(),
                                data: None,
                            },
                        };
                        let _ = write_queue
                            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                    } else if let Some(MaxStepsReached { n_steps }) =
                        err.downcast_ref::<MaxStepsReached>()
                    {
                        let response = JsonRpcSuccessResponse {
                            jsonrpc: "2.0",
                            id,
                            result: json!({
                                "status": statuses::MAX_STEPS_REACHED,
                                "steps": n_steps,
                            }),
                        };
                        let _ = write_queue
                            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                    } else if err.is::<RunCancelled>() {
                        let response = JsonRpcSuccessResponse {
                            jsonrpc: "2.0",
                            id,
                            result: json!({"status": statuses::CANCELLED}),
                        };
                        let _ = write_queue
                            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                    } else {
                        let response = JsonRpcErrorResponse {
                            jsonrpc: "2.0",
                            id,
                            error: JsonRpcErrorObject {
                                code: error_codes::INTERNAL_ERROR,
                                message: err.to_string(),
                                data: None,
                            },
                        };
                        let _ = write_queue
                            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
                    }
                }
            }
        });
    }

    async fn handle_cancel(&mut self, msg: JsonRpcMessage) {
        let Some(id) = msg.id.clone() else {
            return;
        };
        let guard = self.cancel_token.lock().await;
        let Some(token) = guard.as_ref() else {
            self.send_error(
                id,
                error_codes::INVALID_STATE,
                "No agent turn is in progress",
            )
            .await;
            return;
        };
        token.cancel();
        let response = JsonRpcSuccessResponse {
            jsonrpc: "2.0",
            id,
            result: json!({}),
        };
        let _ = self
            .write_queue
            .put_nowait(serde_json::to_value(response).unwrap_or(Value::Null));
    }

    async fn handle_response(&mut self, msg: &JsonRpcMessage) {
        let Some(id) = msg.id.clone() else {
            return;
        };
        let request = {
            let mut pending = self.pending.lock().await;
            pending.remove(&id)
        };
        let Some(request) = request else {
            error!("No pending request for response id={}", id);
            return;
        };

        match request {
            PendingRequest::Approval(req) => {
                if msg.error.is_some() {
                    req.resolve(crate::wire::ApprovalResponseKind::Reject);
                    return;
                }
                let result: ApprovalResponse = match msg
                    .result
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok())
                {
                    Some(result) => result,
                    None => {
                        error!(
                            "Invalid response result for request id={}: missing result",
                            id
                        );
                        req.resolve(crate::wire::ApprovalResponseKind::Reject);
                        return;
                    }
                };
                if result.request_id != req.id {
                    warn!(
                        "Approval response id mismatch: request={}, response={}",
                        req.id, result.request_id
                    );
                }
                req.resolve(result.response);
            }
            PendingRequest::ToolCall(req) => {
                if let Some(error) = &msg.error {
                    let return_value = tool_error("", error.message.clone(), "External tool error");
                    req.resolve(return_value);
                    return;
                }
                let tool_result: ToolResult = match msg
                    .result
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok())
                {
                    Some(result) => result,
                    None => {
                        error!("Invalid tool result for request id={}: missing result", id);
                        let return_value = tool_error(
                            "",
                            "Invalid tool result payload from client.",
                            "Invalid tool result",
                        );
                        req.resolve(return_value);
                        return;
                    }
                };
                if tool_result.tool_call_id != req.id {
                    warn!(
                        "Tool result id mismatch: request={}, result={}",
                        req.id, tool_result.tool_call_id
                    );
                }
                req.resolve(tool_result.return_value);
            }
        }
    }

    async fn send_error(&self, id: String, code: i64, message: impl Into<String>) {
        let response = JsonRpcErrorResponse {
            jsonrpc: "2.0",
            id,
            error: JsonRpcErrorObject {
                code,
                message: message.into(),
                data: None,
            },
        };
        if self
            .write_queue
            .put_nowait(serde_json::to_value(&response).unwrap_or(Value::Null))
            .is_err()
        {
            error!("Send queue shut down; dropping message: {:?}", response);
        }
    }

    async fn send_error_nullable(&self, code: i64, message: impl Into<String>, id: Option<String>) {
        let response = JsonRpcErrorResponseNullableId {
            jsonrpc: "2.0",
            id,
            error: JsonRpcErrorObject {
                code,
                message: message.into(),
                data: None,
            },
        };
        if self
            .write_queue
            .put_nowait(serde_json::to_value(&response).unwrap_or(Value::Null))
            .is_err()
        {
            error!("Send queue shut down; dropping message: {:?}", response);
        }
    }

    async fn shutdown(&self) {
        let pending = {
            let mut pending = self.pending.lock().await;
            std::mem::take(&mut *pending)
        };
        for (_, request) in pending {
            match request {
                PendingRequest::Approval(req) => {
                    req.resolve(crate::wire::ApprovalResponseKind::Reject);
                }
                PendingRequest::ToolCall(req) => {
                    let return_value = tool_error(
                        "",
                        "Wire connection closed before tool result was received.",
                        "Wire closed",
                    );
                    req.resolve(return_value);
                }
            }
        }

        if let Some(token) = self.cancel_token.lock().await.take() {
            token.cancel();
        }

        self.write_queue.shutdown(false);
    }
}

async fn stream_wire_messages(
    write_queue: Queue<Value>,
    pending: Arc<tokio::sync::Mutex<HashMap<String, PendingRequest>>>,
    wire: Arc<Wire>,
) -> Result<(), QueueShutDown> {
    let ui_side = wire.ui_side(false);
    loop {
        let msg = ui_side.receive().await?;
        match msg {
            WireMessage::ApprovalRequest(request) => {
                request_approval(&write_queue, &pending, request).await;
            }
            WireMessage::ToolCallRequest(request) => {
                request_tool_call(&write_queue, &pending, request).await;
            }
            other => {
                let out = build_event_message(other);
                if write_queue
                    .put_nowait(serde_json::to_value(&out).unwrap_or(Value::Null))
                    .is_err()
                {
                    error!("Send queue shut down; dropping message: {:?}", out);
                }
            }
        }
    }
}

async fn request_approval(
    write_queue: &Queue<Value>,
    pending: &Arc<tokio::sync::Mutex<HashMap<String, PendingRequest>>>,
    request: ApprovalRequest,
) {
    let msg_id = request.id.clone();
    pending
        .lock()
        .await
        .insert(msg_id.clone(), PendingRequest::Approval(request.clone()));
    let out = build_request_message(msg_id, WireMessage::ApprovalRequest(request.clone()));
    let _ = write_queue.put_nowait(serde_json::to_value(out).unwrap_or(Value::Null));
    let _ = request.wait().await;
}

async fn request_tool_call(
    write_queue: &Queue<Value>,
    pending: &Arc<tokio::sync::Mutex<HashMap<String, PendingRequest>>>,
    request: ToolCallRequest,
) {
    let msg_id = request.id.clone();
    pending
        .lock()
        .await
        .insert(msg_id.clone(), PendingRequest::ToolCall(request.clone()));
    let out = build_request_message(msg_id, WireMessage::ToolCallRequest(request.clone()));
    let _ = write_queue.put_nowait(serde_json::to_value(out).unwrap_or(Value::Null));
    let _ = request.wait().await;
}
