use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex as AsyncMutex;
use tracing::{debug, error, info};

use kosong::message::{ContentPart, ToolCall, ToolCallPart};

use crate::utils::{BroadcastQueue, Queue, QueueShutDown};
use crate::wire::{WireFile, WireMessage};

pub type WireMessageQueue = BroadcastQueue<WireMessage>;

pub struct Wire {
    raw_queue: Arc<WireMessageQueue>,
    merged_queue: Arc<WireMessageQueue>,
    raw_default: Mutex<Option<Queue<WireMessage>>>,
    merged_default: Mutex<Option<Queue<WireMessage>>>,
    soul_side: WireSoulSide,
    recorder: Option<WireRecorder>,
}

impl Wire {
    pub fn new(file_backend: Option<WireFile>) -> Self {
        let raw_queue = Arc::new(WireMessageQueue::new());
        let merged_queue = Arc::new(WireMessageQueue::new());
        let raw_default = Mutex::new(Some(raw_queue.subscribe()));
        let merged_default = Mutex::new(Some(merged_queue.subscribe()));
        let soul_side = WireSoulSide::new(raw_queue.clone(), merged_queue.clone());
        let recorder = file_backend.map(|path| WireRecorder::new(path, merged_queue.subscribe()));
        Self {
            raw_queue,
            merged_queue,
            raw_default,
            merged_default,
            soul_side,
            recorder,
        }
    }

    pub fn soul_side(&self) -> &WireSoulSide {
        &self.soul_side
    }

    pub fn ui_side(&self, merge: bool) -> WireUISide {
        let queue = if merge {
            self.merged_default
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| self.merged_queue.subscribe())
        } else {
            self.raw_default
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| self.raw_queue.subscribe())
        };
        WireUISide::new(queue)
    }

    pub fn shutdown(&self) {
        debug!("Shutting down wire");
        self.soul_side.flush();
        self.raw_queue.shutdown(false);
        self.merged_queue.shutdown(false);
    }

    pub async fn join(&self) {
        if let Some(recorder) = &self.recorder {
            recorder.join().await;
        }
    }
}

pub struct WireSoulSide {
    raw_queue: Arc<WireMessageQueue>,
    merged_queue: Arc<WireMessageQueue>,
    merge_buffer: Mutex<Option<WireMessage>>,
}

impl WireSoulSide {
    fn new(raw_queue: Arc<WireMessageQueue>, merged_queue: Arc<WireMessageQueue>) -> Self {
        Self {
            raw_queue,
            merged_queue,
            merge_buffer: Mutex::new(None),
        }
    }

    pub fn send(&self, msg: WireMessage) {
        if !matches!(
            msg,
            WireMessage::ContentPart(_) | WireMessage::ToolCallPart(_)
        ) {
            debug!("Sending wire message: {:?}", msg);
        }
        let raw_msg = msg.clone();
        if self.raw_queue.publish_nowait(raw_msg.clone()).is_err() {
            info!(
                "Failed to send raw wire message, queue is shut down: {:?}",
                raw_msg
            );
        }

        match msg {
            WireMessage::ContentPart(part) => self.merge_content_part(part),
            WireMessage::ToolCall(part) => self.merge_tool_call(part),
            WireMessage::ToolCallPart(part) => self.merge_tool_call_part(part),
            other => {
                self.flush();
                if self.merged_queue.publish_nowait(other.clone()).is_err() {
                    info!(
                        "Failed to send merged wire message, queue is shut down: {:?}",
                        other
                    );
                }
            }
        }
    }

    pub fn flush(&self) {
        let buffer = self.merge_buffer.lock().unwrap().take();
        if let Some(msg) = buffer {
            let _ = self.merged_queue.publish_nowait(msg);
        }
    }

    fn merge_content_part(&self, part: ContentPart) {
        let mut buffer = self.merge_buffer.lock().unwrap();
        match buffer.as_mut() {
            None => {
                *buffer = Some(WireMessage::ContentPart(part));
            }
            Some(WireMessage::ContentPart(existing)) => {
                if !existing.merge_in_place(&part) {
                    let flushed = buffer.take();
                    drop(buffer);
                    if let Some(msg) = flushed {
                        let _ = self.merged_queue.publish_nowait(msg);
                    }
                    let mut buffer = self.merge_buffer.lock().unwrap();
                    *buffer = Some(WireMessage::ContentPart(part));
                }
            }
            _ => {
                let flushed = buffer.take();
                drop(buffer);
                if let Some(msg) = flushed {
                    let _ = self.merged_queue.publish_nowait(msg);
                }
                let mut buffer = self.merge_buffer.lock().unwrap();
                *buffer = Some(WireMessage::ContentPart(part));
            }
        }
    }

    fn merge_tool_call_part(&self, part: ToolCallPart) {
        let mut buffer = self.merge_buffer.lock().unwrap();
        match buffer.as_mut() {
            None => {
                *buffer = Some(WireMessage::ToolCallPart(part));
            }
            Some(WireMessage::ToolCallPart(existing)) => {
                if !existing.merge_in_place(&part) {
                    let flushed = buffer.take();
                    drop(buffer);
                    if let Some(msg) = flushed {
                        let _ = self.merged_queue.publish_nowait(msg);
                    }
                    let mut buffer = self.merge_buffer.lock().unwrap();
                    *buffer = Some(WireMessage::ToolCallPart(part));
                }
            }
            Some(WireMessage::ToolCall(existing)) => {
                if !existing.merge_in_place(&part) {
                    let flushed = buffer.take();
                    drop(buffer);
                    if let Some(msg) = flushed {
                        let _ = self.merged_queue.publish_nowait(msg);
                    }
                    let mut buffer = self.merge_buffer.lock().unwrap();
                    *buffer = Some(WireMessage::ToolCallPart(part));
                }
            }
            _ => {
                let flushed = buffer.take();
                drop(buffer);
                if let Some(msg) = flushed {
                    let _ = self.merged_queue.publish_nowait(msg);
                }
                let mut buffer = self.merge_buffer.lock().unwrap();
                *buffer = Some(WireMessage::ToolCallPart(part));
            }
        }
    }

    fn merge_tool_call(&self, call: ToolCall) {
        let mut buffer = self.merge_buffer.lock().unwrap();
        match buffer.as_mut() {
            None => {
                *buffer = Some(WireMessage::ToolCall(call));
            }
            Some(WireMessage::ToolCall(existing)) => {
                if existing.id != call.id || existing.function.name != call.function.name {
                    let flushed = buffer.take();
                    drop(buffer);
                    if let Some(msg) = flushed {
                        let _ = self.merged_queue.publish_nowait(msg);
                    }
                    let mut buffer = self.merge_buffer.lock().unwrap();
                    *buffer = Some(WireMessage::ToolCall(call));
                } else {
                    let flushed = buffer.take();
                    drop(buffer);
                    if let Some(msg) = flushed {
                        let _ = self.merged_queue.publish_nowait(msg);
                    }
                    let mut buffer = self.merge_buffer.lock().unwrap();
                    *buffer = Some(WireMessage::ToolCall(call));
                }
            }
            _ => {
                let flushed = buffer.take();
                drop(buffer);
                if let Some(msg) = flushed {
                    let _ = self.merged_queue.publish_nowait(msg);
                }
                let mut buffer = self.merge_buffer.lock().unwrap();
                *buffer = Some(WireMessage::ToolCall(call));
            }
        }
    }
}

pub struct WireUISide {
    queue: Queue<WireMessage>,
}

impl WireUISide {
    fn new(queue: Queue<WireMessage>) -> Self {
        Self { queue }
    }

    pub async fn receive(&self) -> Result<WireMessage, QueueShutDown> {
        let msg = self.queue.get().await?;
        if !matches!(
            msg,
            WireMessage::ContentPart(_) | WireMessage::ToolCallPart(_)
        ) {
            debug!("Receiving wire message: {:?}", msg);
        }
        Ok(msg)
    }
}

struct WireRecorder {
    task: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl WireRecorder {
    fn new(wire_file: WireFile, queue: Queue<WireMessage>) -> Self {
        let task = tokio::spawn(async move {
            loop {
                match queue.get().await {
                    Ok(msg) => {
                        if let Err(err) =
                            wire_file.append_message(&msg, Some(now_timestamp())).await
                        {
                            error!("Failed to append wire message: {}", err);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            task: AsyncMutex::new(Some(task)),
        }
    }

    async fn join(&self) {
        let handle = self.task.lock().await.take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }
}

fn now_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}
