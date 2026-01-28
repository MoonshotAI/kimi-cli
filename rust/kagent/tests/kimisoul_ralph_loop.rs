mod tool_test_utils;

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use kagent::config::ModelCapability;
use kagent::llm::LLM;
use kagent::soul::agent::{Agent, Runtime};
use kagent::soul::context::Context;
use kagent::soul::kimisoul::KimiSoul;
use kagent::soul::message::tool_result_to_message;
use kagent::soul::run_soul;
use kagent::soul::toolset::KimiToolset;
use kagent::tools::utils::tool_rejected_error;
use kagent::utils::QueueShutDown;
use kagent::wire::{TurnBegin, UserInput, Wire, WireMessage};
use kosong::chat_provider::{
    ChatProvider, ChatProviderError, StreamedMessage, ThinkingEffort, TokenUsage,
};
use kosong::message::{
    ContentPart, ImageURLPart, Message, Role, StreamedMessagePart, TextPart, ToolCall,
};
use kosong::tooling::{CallableTool2, Tool, ToolResult, ToolReturnValue};
use schemars::JsonSchema;
use serde::Deserialize;
use tempfile::TempDir;

use tool_test_utils::RuntimeFixture;

const RALPH_IMAGE_URL: &str = "https://example.com/test.png";

fn ralph_prompt(prompt_text: &str) -> String {
    format!(
        "{}. (You are running in an automated loop where the same prompt is fed repeatedly. Only choose STOP when the task is fully complete. Including it will stop further iterations. If you are not 100% sure, choose CONTINUE.)\n\nAvailable branches:\n- CONTINUE\n- STOP\n\nReply with a choice using <choice>...</choice>.",
        prompt_text
    )
}

struct SequenceStreamedMessage {
    parts: VecDeque<StreamedMessagePart>,
}

impl SequenceStreamedMessage {
    fn new(parts: Vec<StreamedMessagePart>) -> Self {
        Self {
            parts: parts.into(),
        }
    }
}

#[async_trait]
impl StreamedMessage for SequenceStreamedMessage {
    async fn next_part(&mut self) -> Result<Option<StreamedMessagePart>, ChatProviderError> {
        Ok(self.parts.pop_front())
    }

    fn id(&self) -> Option<String> {
        Some("sequence".to_string())
    }

    fn usage(&self) -> Option<TokenUsage> {
        None
    }
}

struct SequenceChatProvider {
    sequences: Vec<Vec<StreamedMessagePart>>,
    index: AtomicUsize,
}

impl SequenceChatProvider {
    fn new(sequences: Vec<Vec<StreamedMessagePart>>) -> Self {
        Self {
            sequences,
            index: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl ChatProvider for SequenceChatProvider {
    fn name(&self) -> &str {
        "sequence"
    }

    fn model_name(&self) -> &str {
        "sequence"
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
        let index = self.index.fetch_add(1, Ordering::SeqCst);
        let sequence = if self.sequences.is_empty() {
            Vec::new()
        } else {
            let selected = std::cmp::min(index, self.sequences.len() - 1);
            self.sequences[selected].clone()
        };
        Ok(Box::new(SequenceStreamedMessage::new(sequence)))
    }

    fn with_thinking(&self, _effort: ThinkingEffort) -> Box<dyn ChatProvider> {
        Box::new(SequenceChatProvider {
            sequences: self.sequences.clone(),
            index: AtomicUsize::new(self.index.load(Ordering::SeqCst)),
        })
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RejectParams {}

struct RejectTool;

#[async_trait]
impl CallableTool2 for RejectTool {
    type Params = RejectParams;

    fn name(&self) -> &str {
        "reject_tool"
    }

    fn description(&self) -> &str {
        "Always reject tool calls."
    }

    async fn call_typed(&self, _params: RejectParams) -> ToolReturnValue {
        tool_rejected_error()
    }
}

fn make_llm(
    sequences: Vec<Vec<StreamedMessagePart>>,
    capabilities: HashSet<ModelCapability>,
) -> LLM {
    LLM {
        chat_provider: Box::new(SequenceChatProvider::new(sequences)),
        max_context_size: 100_000,
        capabilities,
        model_config: None,
        provider_config: None,
    }
}

fn runtime_with_llm(mut runtime: Runtime, llm: LLM) -> Runtime {
    runtime.llm = Some(Arc::new(llm));
    runtime
}

fn make_soul(
    runtime: Runtime,
    llm: LLM,
    toolset: KimiToolset,
    tmp_path: &std::path::Path,
) -> KimiSoul {
    let agent = Agent {
        name: "Test Agent".to_string(),
        system_prompt: "Test system prompt.".to_string(),
        toolset: Arc::new(tokio::sync::Mutex::new(toolset)),
        runtime: runtime_with_llm(runtime, llm),
    };

    KimiSoul::new(agent, Context::new(tmp_path.join("history.jsonl")))
}

async fn run_and_collect_turns(soul: &KimiSoul, user_input: UserInput) -> Vec<UserInput> {
    let turns = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let turns_clone = Arc::clone(&turns);

    let ui_loop = move |wire: Arc<Wire>| {
        let turns = Arc::clone(&turns_clone);
        async move {
            let ui = wire.ui_side(true);
            loop {
                let msg = match ui.receive().await {
                    Ok(msg) => msg,
                    Err(QueueShutDown) => return Ok(()),
                };
                if let WireMessage::TurnBegin(TurnBegin { user_input }) = msg {
                    turns.lock().await.push(user_input);
                }
            }
        }
    };

    run_soul(soul, user_input, ui_loop, CancellationToken::new(), None)
        .await
        .expect("run soul");

    turns.lock().await.clone()
}

#[tokio::test]
async fn test_ralph_loop_replays_original_prompt() {
    let fixture = RuntimeFixture::new();
    let mut runtime = fixture.runtime.clone();
    runtime.config.loop_control.max_ralph_iterations = 2;

    let user_input = UserInput::Parts(vec![
        ContentPart::Text(TextPart::new("Check this image")),
        ContentPart::ImageUrl(ImageURLPart::new(RALPH_IMAGE_URL)),
    ]);

    let mut capabilities = HashSet::new();
    capabilities.insert(ModelCapability::ImageIn);

    let llm = make_llm(
        vec![
            vec![ContentPart::Text(TextPart::new("first")).into()],
            vec![ContentPart::Text(TextPart::new("second <choice>CONTINUE</choice>")).into()],
            vec![ContentPart::Text(TextPart::new("third <choice>STOP</choice>")).into()],
        ],
        capabilities,
    );

    let toolset = KimiToolset::new();
    let tmp = TempDir::new().expect("temp dir");
    let soul = make_soul(runtime, llm, toolset, tmp.path());

    run_and_collect_turns(&soul, user_input).await;

    let history = soul.context().lock().await.history().to_vec();
    let prompt_text = ralph_prompt("Check this image");

    assert_eq!(
        history,
        vec![
            Message::new(
                Role::User,
                vec![
                    ContentPart::Text(TextPart::new("Check this image")),
                    ContentPart::ImageUrl(ImageURLPart::new(RALPH_IMAGE_URL)),
                ],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new("first"))]
            ),
            Message::new(
                Role::User,
                vec![ContentPart::Text(TextPart::new(prompt_text.clone()))],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new(
                    "second <choice>CONTINUE</choice>"
                ))],
            ),
            Message::new(
                Role::User,
                vec![ContentPart::Text(TextPart::new(prompt_text))],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new(
                    "third <choice>STOP</choice>"
                ))],
            ),
        ]
    );
}

#[tokio::test]
async fn test_ralph_loop_stops_on_choice() {
    let fixture = RuntimeFixture::new();
    let mut runtime = fixture.runtime.clone();
    runtime.config.loop_control.max_ralph_iterations = -1;

    let llm = make_llm(
        vec![
            vec![ContentPart::Text(TextPart::new("first")).into()],
            vec![ContentPart::Text(TextPart::new("done <choice>STOP</choice>")).into()],
        ],
        HashSet::new(),
    );

    let toolset = KimiToolset::new();
    let tmp = TempDir::new().expect("temp dir");
    let soul = make_soul(runtime, llm, toolset, tmp.path());

    run_and_collect_turns(&soul, UserInput::Text("do it".to_string())).await;

    let history = soul.context().lock().await.history().to_vec();
    let prompt_text = ralph_prompt("do it");

    assert_eq!(
        history,
        vec![
            Message::new(Role::User, vec![ContentPart::Text(TextPart::new("do it"))]),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new("first"))]
            ),
            Message::new(
                Role::User,
                vec![ContentPart::Text(TextPart::new(prompt_text))],
            ),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new(
                    "done <choice>STOP</choice>"
                ))],
            ),
        ]
    );
}

#[tokio::test]
async fn test_ralph_loop_stops_on_tool_rejected() {
    let fixture = RuntimeFixture::new();
    let mut runtime = fixture.runtime.clone();
    runtime.config.loop_control.max_ralph_iterations = 3;

    let mut tool_call = ToolCall::new("call-1", "reject_tool");
    tool_call.function.arguments = Some("{}".to_string());

    let llm = make_llm(
        vec![vec![StreamedMessagePart::from(tool_call.clone())]],
        HashSet::new(),
    );

    let mut toolset = KimiToolset::new();
    toolset.add(Arc::new(RejectTool));

    let tmp = TempDir::new().expect("temp dir");
    let soul = make_soul(runtime, llm, toolset, tmp.path());

    run_and_collect_turns(&soul, UserInput::Text("do it".to_string())).await;

    let history = soul.context().lock().await.history().to_vec();
    let tool_message = tool_result_to_message(&ToolResult {
        tool_call_id: "call-1".to_string(),
        return_value: tool_rejected_error(),
    });

    assert_eq!(
        history,
        vec![
            Message::new(Role::User, vec![ContentPart::Text(TextPart::new("do it"))]),
            Message {
                role: Role::Assistant,
                content: Vec::new(),
                name: None,
                tool_calls: Some(vec![tool_call]),
                tool_call_id: None,
                partial: None,
            },
            tool_message,
        ]
    );
}

#[tokio::test]
async fn test_ralph_loop_disabled_skips_loop_prompt() {
    let fixture = RuntimeFixture::new();
    let mut runtime = fixture.runtime.clone();
    runtime.config.loop_control.max_ralph_iterations = 0;

    let llm = make_llm(
        vec![vec![ContentPart::Text(TextPart::new("done")).into()]],
        HashSet::new(),
    );

    let toolset = KimiToolset::new();
    let tmp = TempDir::new().expect("temp dir");
    let soul = make_soul(runtime, llm, toolset, tmp.path());

    run_and_collect_turns(&soul, UserInput::Text("hello".to_string())).await;

    let history = soul.context().lock().await.history().to_vec();
    assert_eq!(
        history,
        vec![
            Message::new(Role::User, vec![ContentPart::Text(TextPart::new("hello"))]),
            Message::new(
                Role::Assistant,
                vec![ContentPart::Text(TextPart::new("done"))]
            ),
        ]
    );
}
