use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::config::ModelCapability;
use crate::utils::{QueueShutDown, SlashCommandInfo};
use crate::wire::{UserInput, Wire, WireFile, WireMessage};

pub mod agent;
pub mod approval;
pub mod compaction;
pub mod context;
pub mod denwarenji;
pub mod kimisoul;
pub mod message;
pub mod toolset;

#[derive(Debug, Error)]
#[error("LLM not set")]
pub struct LLMNotSet;

#[derive(Debug)]
pub struct LLMNotSupported {
    pub model_name: String,
    pub capabilities: Vec<ModelCapability>,
}

impl LLMNotSupported {
    pub fn new(model_name: impl Into<String>, capabilities: Vec<ModelCapability>) -> Self {
        Self {
            model_name: model_name.into(),
            capabilities,
        }
    }

    fn capabilities_label(&self) -> &'static str {
        if self.capabilities.len() == 1 {
            "capability"
        } else {
            "capabilities"
        }
    }

    fn capabilities(&self) -> String {
        self.capabilities
            .iter()
            .map(model_capability_name)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[derive(Debug, Error)]
#[error("Max number of steps reached: {n_steps}")]
pub struct MaxStepsReached {
    pub n_steps: i64,
}

impl MaxStepsReached {
    pub fn new(n_steps: i64) -> Self {
        Self { n_steps }
    }
}

#[derive(Debug, Error)]
#[error("run cancelled")]
pub struct RunCancelled;

#[derive(Clone, Debug)]
pub struct StatusSnapshot {
    pub context_usage: f64,
    pub yolo_enabled: bool,
}

#[async_trait(?Send)]
pub trait Soul: Send + Sync {
    fn name(&self) -> &str;
    fn model_name(&self) -> &str;
    fn model_capabilities(&self) -> Option<&HashSet<ModelCapability>>;
    fn thinking(&self) -> Option<bool>;
    fn status(&self) -> StatusSnapshot;
    fn available_slash_commands(&self) -> Vec<SlashCommandInfo>;

    async fn run(&self, user_input: UserInput) -> anyhow::Result<()>;
}

pub type UILoopResult = Result<(), QueueShutDown>;

pub async fn run_soul<S, F, Fut>(
    soul: &S,
    user_input: UserInput,
    ui_loop_fn: F,
    cancel_token: CancellationToken,
    wire_file: Option<WireFile>,
) -> anyhow::Result<()>
where
    S: Soul + ?Sized,
    F: Fn(Arc<Wire>) -> Fut + Send + Sync,
    Fut: Future<Output = UILoopResult> + Send + 'static,
{
    let wire = Arc::new(Wire::new(wire_file));

    debug!(
        "Starting UI loop with function: {:?}",
        std::any::type_name::<F>()
    );
    let ui_task = tokio::spawn(ui_loop_fn(Arc::clone(&wire)));

    debug!("Starting soul run");
    let soul_future = with_current_wire(Arc::clone(&wire), soul.run(user_input));
    tokio::pin!(soul_future);

    let result = tokio::select! {
        _ = cancel_token.cancelled() => {
            debug!("Cancelling the run task");
            Err(anyhow::Error::new(RunCancelled))
        },
        result = &mut soul_future => result,
    };

    debug!("Shutting down the UI loop");
    wire.shutdown();
    wire.join().await;

    let shutdown = tokio::time::timeout(Duration::from_millis(500), async {
        match ui_task.await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {}
            Err(_) => {}
        }
    })
    .await;
    match shutdown {
        Ok(_) => debug!("UI loop shut down"),
        Err(_) => warn!("UI loop timed out"),
    }

    result
}

tokio::task_local! {
    static CURRENT_WIRE: Arc<Wire>;
}

pub fn with_current_wire<Fut>(wire: Arc<Wire>, fut: Fut) -> impl Future<Output = Fut::Output>
where
    Fut: Future,
{
    CURRENT_WIRE.scope(wire, fut)
}

pub fn spawn_with_current_wire<Fut>(fut: Fut) -> tokio::task::JoinHandle<Fut::Output>
where
    Fut: Future + Send + 'static,
    Fut::Output: Send + 'static,
{
    let wire = get_current_wire_or_none()
        .expect("Wire is expected to be set when spawning with current wire");
    tokio::spawn(with_current_wire(wire, fut))
}

pub fn get_current_wire_or_none() -> Option<Arc<Wire>> {
    CURRENT_WIRE.try_with(|wire| Arc::clone(wire)).ok()
}

pub fn wire_send(msg: WireMessage) {
    let wire = get_current_wire_or_none().expect("Wire is expected to be set when soul is running");
    wire.soul_side().send(msg);
}

fn model_capability_name(capability: &ModelCapability) -> String {
    match capability {
        ModelCapability::ImageIn => "image_in",
        ModelCapability::VideoIn => "video_in",
        ModelCapability::Thinking => "thinking",
        ModelCapability::AlwaysThinking => "always_thinking",
    }
    .to_string()
}

impl std::fmt::Display for LLMNotSupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "LLM model '{}' does not support required {}: {}.",
            self.model_name,
            self.capabilities_label(),
            self.capabilities()
        )
    }
}

impl std::error::Error for LLMNotSupported {}
