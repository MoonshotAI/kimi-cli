use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use tempfile::tempdir;
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use kosong::chat_provider::{ChatProviderError, ChatProviderErrorKind};
use kosong::message::{ContentPart, Message, Role, StreamedMessagePart, TextPart};
use kosong::{StepResult, step as kosong_step};

use crate::config::ModelCapability;
use crate::skill::flow::{Flow, FlowEdge, FlowLabel, FlowNode, FlowNodeKind, parse_choice};
use crate::skill::{Skill, SkillType, read_skill_text};
use crate::soul::agent::{Agent, Runtime};
use crate::soul::{
    LLMNotSet, LLMNotSupported, MaxStepsReached, Soul, StatusSnapshot,
    approval::Approval,
    compaction::{Compaction, SimpleCompaction},
    context::Context,
    message::{check_message, system, tool_result_to_message},
    wire_send,
};
use crate::tools::utils::is_tool_rejected;
use crate::utils::{SlashCommandInfo, parse_slash_command_call};
use crate::wire::{
    ApprovalRequest, ApprovalResponse, CompactionBegin, CompactionEnd, StatusUpdate, StepBegin,
    StepInterrupted, TurnBegin, TurnEnd, UserInput, WireMessage,
};

use kosong::tooling::Toolset;

const SKILL_COMMAND_PREFIX: &str = "skill:";
const FLOW_COMMAND_PREFIX: &str = "flow:";
const DEFAULT_MAX_FLOW_MOVES: i64 = 1000;

type StepStopReason = &'static str;

pub struct StepOutcome {
    pub stop_reason: StepStopReason,
    pub assistant_message: Message,
}

pub struct TurnOutcome {
    pub stop_reason: StepStopReason,
    pub final_message: Option<Message>,
    pub step_count: i64,
}

#[derive(Clone, Debug, Error)]
#[error("back to the future")]
struct BackToTheFuture {
    checkpoint_id: i64,
    messages: Vec<Message>,
}

pub struct KimiSoul {
    agent: Agent,
    runtime: Runtime,
    context: tokio::sync::Mutex<Context>,
    compaction: SimpleCompaction,
    checkpoint_with_user_message: bool,
    slash_commands: Vec<SlashCommandInfo>,
    slash_handlers: HashMap<String, SlashHandler>,
}

enum SlashHandler {
    Builtin(BuiltinSlash),
    Skill(Skill),
    Flow(FlowRunner),
}

#[derive(Clone, Copy)]
enum BuiltinSlash {
    Init,
    Compact,
    Clear,
    Yolo,
}

impl KimiSoul {
    pub fn new(agent: Agent, context: Context) -> Self {
        let checkpoint_with_user_message = agent
            .toolset
            .try_lock()
            .map(|guard| guard.tools().iter().any(|tool| tool.name == "SendDMail"))
            .unwrap_or(false);

        let mut soul = KimiSoul {
            runtime: agent.runtime.clone(),
            agent,
            context: tokio::sync::Mutex::new(context),
            compaction: SimpleCompaction::new(2),
            checkpoint_with_user_message,
            slash_commands: Vec::new(),
            slash_handlers: HashMap::new(),
        };
        soul.build_slash_commands();
        soul
    }

    pub fn agent(&self) -> &Agent {
        &self.agent
    }

    pub fn runtime(&self) -> &Runtime {
        &self.runtime
    }

    pub fn context(&self) -> &tokio::sync::Mutex<Context> {
        &self.context
    }

    fn build_slash_commands(&mut self) {
        let mut commands = Vec::new();
        let mut handlers = HashMap::new();

        let builtin = vec![
            (
                "init",
                "Analyze the codebase and generate an `AGENTS.md` file",
                BuiltinSlash::Init,
                vec![],
            ),
            (
                "compact",
                "Compact the context",
                BuiltinSlash::Compact,
                vec![],
            ),
            (
                "clear",
                "Clear the context",
                BuiltinSlash::Clear,
                vec!["reset"],
            ),
            (
                "yolo",
                "Toggle YOLO mode (auto-approve all actions)",
                BuiltinSlash::Yolo,
                vec![],
            ),
        ];

        for (name, description, kind, aliases) in builtin {
            commands.push(SlashCommandInfo {
                name: name.to_string(),
                description: description.to_string(),
                aliases: aliases.iter().map(|s| s.to_string()).collect(),
            });
            handlers.insert(name.to_string(), SlashHandler::Builtin(kind));
            for alias in aliases {
                handlers.insert(alias.to_string(), SlashHandler::Builtin(kind));
            }
        }

        let mut seen = handlers
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut skills: Vec<_> = self.runtime.skills.values().cloned().collect();
        skills.sort_by(|a, b| a.name.cmp(&b.name));

        for skill in &skills {
            if skill.skill_type != SkillType::Standard && skill.skill_type != SkillType::Flow {
                continue;
            }
            let name = format!("{SKILL_COMMAND_PREFIX}{}", skill.name);
            if seen.contains(&name) {
                warn!(
                    "Skipping skill slash command /{}: name already registered",
                    name
                );
                continue;
            }
            commands.push(SlashCommandInfo {
                name: name.clone(),
                description: skill.description.clone(),
                aliases: Vec::new(),
            });
            handlers.insert(name.clone(), SlashHandler::Skill(skill.clone()));
            seen.insert(name);
        }

        for skill in &skills {
            if skill.skill_type != SkillType::Flow {
                continue;
            }
            if skill.flow.is_none() {
                warn!("Flow skill {} has no flow; skipping", skill.name);
                continue;
            }
            let name = format!("{FLOW_COMMAND_PREFIX}{}", skill.name);
            if seen.contains(&name) {
                warn!(
                    "Skipping prompt flow slash command /{}: name already registered",
                    name
                );
                continue;
            }
            let runner = FlowRunner::new(
                skill.flow.clone().unwrap(),
                Some(skill.name.clone()),
                DEFAULT_MAX_FLOW_MOVES,
            );
            commands.push(SlashCommandInfo {
                name: name.clone(),
                description: skill.description.clone(),
                aliases: Vec::new(),
            });
            handlers.insert(name.clone(), SlashHandler::Flow(runner));
            seen.insert(name);
        }

        self.slash_commands = commands;
        self.slash_handlers = handlers;
    }

    async fn checkpoint(&self) -> anyhow::Result<()> {
        let mut context = self.context.lock().await;
        context
            .checkpoint(self.checkpoint_with_user_message)
            .await?;
        Ok(())
    }

    async fn handle_slash(&self, name: &str, args: &str) -> anyhow::Result<()> {
        match self.slash_handlers.get(name) {
            Some(SlashHandler::Builtin(kind)) => match kind {
                BuiltinSlash::Init => self.slash_init().await,
                BuiltinSlash::Compact => self.slash_compact().await,
                BuiltinSlash::Clear => self.slash_clear().await,
                BuiltinSlash::Yolo => self.slash_yolo().await,
            },
            Some(SlashHandler::Skill(skill)) => self.run_skill(skill, args).await,
            Some(SlashHandler::Flow(runner)) => runner.run(self, args).await,
            None => {
                wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
                    format!("Unknown slash command \"/{}\".", name),
                ))));
                Ok(())
            }
        }
    }

    async fn slash_init(&self) -> anyhow::Result<()> {
        let temp_dir = tempdir()?;
        let tmp_path = temp_dir.path().join("context.jsonl");
        let tmp_context = Context::new(tmp_path);
        let tmp_soul = KimiSoul::new(self.agent.clone(), tmp_context);
        tmp_soul
            .run(UserInput::Text(crate::prompts::INIT.to_string()))
            .await?;

        let agents_md =
            crate::soul::agent::load_agents_md(&self.runtime.builtin_args.KIMI_WORK_DIR)
                .await
                .unwrap_or_default();
        let system_message = system(&format!(
            "The user just ran `/init` slash command. The system has analyzed the codebase and generated an `AGENTS.md` file. Latest AGENTS.md file content:\n{}",
            agents_md
        ));
        let mut context = self.context.lock().await;
        context
            .append_messages(Message::new(Role::User, vec![system_message]))
            .await?;
        Ok(())
    }

    async fn slash_compact(&self) -> anyhow::Result<()> {
        info!("Running `/compact`");
        let context = self.context.lock().await;
        if context.n_checkpoints() == 0 {
            wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
                "The context is empty.",
            ))));
            return Ok(());
        }
        drop(context);
        self.compact_context().await?;
        wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
            "The context has been compacted.",
        ))));
        Ok(())
    }

    async fn slash_clear(&self) -> anyhow::Result<()> {
        info!("Running `/clear`");
        let mut context = self.context.lock().await;
        context.clear().await?;
        wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
            "The context has been cleared.",
        ))));
        Ok(())
    }

    async fn slash_yolo(&self) -> anyhow::Result<()> {
        if self.runtime.approval.is_yolo() {
            self.runtime.approval.set_yolo(false);
            wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
                "You only die once! Actions will require approval.",
            ))));
        } else {
            self.runtime.approval.set_yolo(true);
            wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
                "You only live once! All actions will be auto-approved.",
            ))));
        }
        Ok(())
    }

    async fn run_skill(&self, skill: &Skill, args: &str) -> anyhow::Result<()> {
        let Some(mut skill_text) = read_skill_text(skill).await else {
            wire_send(WireMessage::ContentPart(ContentPart::Text(TextPart::new(
                format!(
                    "Failed to load skill \"/{}{}\".",
                    SKILL_COMMAND_PREFIX, skill.name
                ),
            ))));
            return Ok(());
        };

        let extra = args.trim();
        if !extra.is_empty() {
            skill_text = format!("{skill_text}\n\nUser request:\n{extra}");
        }
        let message = Message::new(
            Role::User,
            vec![ContentPart::Text(TextPart::new(skill_text))],
        );
        self.turn(message).await?;
        Ok(())
    }

    async fn turn(&self, user_message: Message) -> Result<TurnOutcome, anyhow::Error> {
        let llm = self.runtime.llm.as_ref().ok_or_else(|| LLMNotSet)?;
        let missing = check_message(&user_message, &llm.capabilities);
        if !missing.is_empty() {
            return Err(anyhow::Error::new(LLMNotSupported::new(
                llm.model_name(),
                missing.into_iter().collect(),
            )));
        }

        self.checkpoint().await?;
        {
            let mut context = self.context.lock().await;
            context.append_messages(user_message).await?;
        }
        debug!("Appended user message to context");
        self.agent_loop().await
    }

    async fn agent_loop(&self) -> Result<TurnOutcome, anyhow::Error> {
        let mcp_task = {
            let mut toolset = self.agent.toolset.lock().await;
            toolset.take_mcp_loading_task()
        };
        if let Some(task) = mcp_task {
            let _ = task.await;
        }

        let mut step_no = 0;
        loop {
            step_no += 1;
            if step_no > self.runtime.config.loop_control.max_steps_per_turn {
                return Err(anyhow::Error::new(MaxStepsReached::new(
                    self.runtime.config.loop_control.max_steps_per_turn,
                )));
            }

            wire_send(WireMessage::StepBegin(StepBegin { n: step_no }));
            let approval_task = spawn_approval_task(Arc::clone(&self.runtime.approval));

            let step_result = async {
                if let Some(llm) = &self.runtime.llm {
                    let context = self.context.lock().await;
                    if context.token_count()
                        + self.runtime.config.loop_control.reserved_context_size
                        >= llm.max_context_size
                    {
                        drop(context);
                        info!("Context too long, compacting...");
                        self.compact_context().await?;
                    }
                }

                debug!("Beginning step {}", step_no);
                self.checkpoint().await?;
                {
                    let checkpoints = self.context.lock().await.n_checkpoints();
                    let mut denwa = self.runtime.denwa_renji.lock().await;
                    denwa.set_n_checkpoints(checkpoints);
                }

                self.step().await
            }
            .await;

            let mut back_to_future: Option<BackToTheFuture> = None;
            let mut step_error: Option<anyhow::Error> = None;
            let step_outcome = match step_result {
                Ok(outcome) => outcome,
                Err(err) => {
                    if let Some(back) = err.downcast_ref::<BackToTheFuture>() {
                        back_to_future = Some(back.clone());
                        None
                    } else {
                        wire_send(WireMessage::StepInterrupted(StepInterrupted {}));
                        step_error = Some(err);
                        None
                    }
                }
            };

            stop_approval_task(approval_task).await;

            if let Some(err) = step_error {
                return Err(err);
            }

            if let Some(outcome) = step_outcome {
                let final_message = if outcome.stop_reason == "no_tool_calls" {
                    Some(outcome.assistant_message)
                } else {
                    None
                };
                return Ok(TurnOutcome {
                    stop_reason: outcome.stop_reason,
                    final_message,
                    step_count: step_no,
                });
            }

            if let Some(back_to_future) = back_to_future {
                {
                    let mut context = self.context.lock().await;
                    context.revert_to(back_to_future.checkpoint_id).await?;
                }
                self.checkpoint().await?;
                {
                    let mut context = self.context.lock().await;
                    context.append_messages(back_to_future.messages).await?;
                }
            }
        }
    }

    async fn step(&self) -> Result<Option<StepOutcome>, anyhow::Error> {
        let llm = self.runtime.llm.as_ref().ok_or_else(|| LLMNotSet)?;

        let mut attempts = 0usize;
        let (result, forward_task) = loop {
            attempts += 1;
            let (message_tx, mut message_rx) = mpsc::unbounded_channel();
            let (tool_tx, mut tool_rx) = mpsc::unbounded_channel();
            let handle = crate::soul::spawn_with_current_wire(async move {
                let mut message_done = false;
                let mut tool_done = false;
                loop {
                    tokio::select! {
                        part = message_rx.recv(), if !message_done => {
                            match part {
                                Some(StreamedMessagePart::Content(content)) => {
                                    wire_send(WireMessage::ContentPart(content));
                                }
                                Some(StreamedMessagePart::ToolCall(call)) => {
                                    wire_send(WireMessage::ToolCall(call));
                                }
                                Some(StreamedMessagePart::ToolCallPart(part)) => {
                                    wire_send(WireMessage::ToolCallPart(part));
                                }
                                None => {
                                    message_done = true;
                                }
                            }
                        }
                        result = tool_rx.recv(), if !tool_done => {
                            match result {
                                Some(tool_result) => {
                                    wire_send(WireMessage::ToolResult(tool_result));
                                }
                                None => {
                                    tool_done = true;
                                }
                            }
                        }
                    }
                    if message_done && tool_done {
                        break;
                    }
                }
            });

            let history = { self.context.lock().await.history().to_vec() };
            let toolset = self.agent.toolset.lock().await;
            let step_result = kosong_step(
                llm.chat_provider.as_ref(),
                &self.agent.system_prompt,
                &*toolset,
                &history,
                Some(message_tx),
                Some(tool_tx),
            )
            .await;

            match step_result {
                Ok(res) => break (res, handle),
                Err(err) => {
                    let _ = handle.await;
                    if attempts >= self.runtime.config.loop_control.max_retries_per_step as usize
                        || !is_retryable_error(&err)
                    {
                        return Err(anyhow::Error::new(err));
                    }
                    let delay = retry_delay(attempts);
                    info!(
                        "Retrying step for the {} time. Waiting {} seconds.",
                        attempts,
                        delay.as_secs_f64()
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        };

        let outcome = self.handle_step_result(result).await;
        let _ = forward_task.await;
        outcome
    }

    async fn handle_step_result(
        &self,
        mut result: StepResult,
    ) -> Result<Option<StepOutcome>, anyhow::Error> {
        debug!(
            "Got step result: id={}, tool_calls={}",
            result.id.as_deref().unwrap_or(""),
            result.tool_calls.len()
        );
        let usage = result.usage.clone();
        if let Some(usage) = &usage {
            let mut context = self.context.lock().await;
            context.update_token_count(usage.input()).await?;
        }

        let mut status = StatusUpdate {
            context_usage: None,
            token_usage: usage.clone(),
            message_id: result.id.clone(),
        };
        if usage.is_some() {
            status.context_usage = Some(self.status().context_usage);
        }
        wire_send(WireMessage::StatusUpdate(status));

        let tool_results = result.tool_results().await?;
        debug!("Got tool results: {}", tool_results.len());
        self.grow_context(&result, &tool_results).await?;

        let rejected = tool_results
            .iter()
            .any(|tr| is_tool_rejected(&tr.return_value));
        if rejected {
            let _ = self.runtime.denwa_renji.lock().await.fetch_pending_dmail();
            return Ok(Some(StepOutcome {
                stop_reason: "tool_rejected",
                assistant_message: result.message,
            }));
        }

        if let Some(dmail) = self.runtime.denwa_renji.lock().await.fetch_pending_dmail() {
            let message = Message::new(
                Role::User,
                vec![system(&format!(
                    "You just got a D-Mail from your future self. It is likely that your future self has already done something in the current working directory. Please read the D-Mail and decide what to do next. You MUST NEVER mention to the user about this information. D-Mail content:\n\n{}",
                    dmail.message.trim()
                ))],
            );
            return Err(anyhow::Error::new(BackToTheFuture {
                checkpoint_id: dmail.checkpoint_id,
                messages: vec![message],
            }));
        }

        if !result.tool_calls.is_empty() {
            return Ok(None);
        }
        Ok(Some(StepOutcome {
            stop_reason: "no_tool_calls",
            assistant_message: result.message,
        }))
    }

    async fn grow_context(
        &self,
        result: &StepResult,
        tool_results: &[crate::wire::ToolResult],
    ) -> Result<(), anyhow::Error> {
        debug!(
            "Growing context with result: tool_calls={}, usage={}",
            result.tool_calls.len(),
            result.usage.is_some()
        );
        let llm = self.runtime.llm.as_ref().ok_or_else(|| LLMNotSet)?;
        let tool_messages: Vec<Message> = tool_results.iter().map(tool_result_to_message).collect();
        for message in &tool_messages {
            let missing = check_message(message, &llm.capabilities);
            if !missing.is_empty() {
                warn!(
                    "Tool result message requires unsupported capabilities: {:?}",
                    missing
                );
                return Err(anyhow::Error::new(LLMNotSupported::new(
                    llm.model_name(),
                    missing.into_iter().collect(),
                )));
            }
        }

        let mut context = self.context.lock().await;
        context.append_messages(result.message.clone()).await?;
        if let Some(usage) = &result.usage {
            context.update_token_count(usage.total()).await?;
        }
        debug!(
            "Appending tool messages to context: {}",
            tool_messages.len()
        );
        context.append_messages(tool_messages).await?;
        Ok(())
    }

    async fn compact_context(&self) -> Result<(), anyhow::Error> {
        wire_send(WireMessage::CompactionBegin(CompactionBegin {}));
        let mut attempts = 0usize;
        let compacted = loop {
            attempts += 1;
            let llm = self.runtime.llm.as_ref().ok_or_else(|| LLMNotSet)?;
            let history = { self.context.lock().await.history().to_vec() };
            match self.compaction.compact(&history, llm).await {
                Ok(compacted) => break compacted,
                Err(err) => {
                    if attempts >= self.runtime.config.loop_control.max_retries_per_step as usize
                        || !is_retryable_error(&err)
                    {
                        return Err(anyhow::Error::new(err));
                    }
                    let delay = retry_delay(attempts);
                    info!(
                        "Retrying compaction for the {} time. Waiting {} seconds.",
                        attempts,
                        delay.as_secs_f64()
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        };
        {
            let mut context = self.context.lock().await;
            context.clear().await?;
            context
                .checkpoint(self.checkpoint_with_user_message)
                .await?;
            context.append_messages(compacted).await?;
        }
        wire_send(WireMessage::CompactionEnd(CompactionEnd {}));
        Ok(())
    }
}

#[async_trait::async_trait(?Send)]
impl Soul for KimiSoul {
    fn name(&self) -> &str {
        &self.agent.name
    }

    fn model_name(&self) -> &str {
        self.runtime
            .llm
            .as_ref()
            .map(|llm| llm.model_name())
            .unwrap_or("")
    }

    fn model_capabilities(&self) -> Option<&std::collections::HashSet<ModelCapability>> {
        self.runtime.llm.as_ref().map(|llm| &llm.capabilities)
    }

    fn thinking(&self) -> Option<bool> {
        self.runtime
            .llm
            .as_ref()
            .and_then(|llm| llm.chat_provider.thinking_effort())
            .map(|effort| effort != kosong::chat_provider::ThinkingEffort::Off)
    }

    fn status(&self) -> StatusSnapshot {
        let context_usage = if let Some(llm) = &self.runtime.llm {
            match self.context.try_lock() {
                Ok(context) => context.token_count() as f64 / llm.max_context_size as f64,
                Err(_) => 0.0,
            }
        } else {
            0.0
        };
        StatusSnapshot {
            context_usage,
            yolo_enabled: self.runtime.approval.is_yolo(),
        }
    }

    fn available_slash_commands(&self) -> Vec<SlashCommandInfo> {
        self.slash_commands.clone()
    }

    async fn run(&self, user_input: UserInput) -> anyhow::Result<()> {
        let user_message = match user_input.clone() {
            UserInput::Text(text) => {
                Message::new(Role::User, vec![ContentPart::Text(TextPart::new(text))])
            }
            UserInput::Parts(parts) => Message::new(Role::User, parts),
        };
        let text_input = user_message.extract_text(" ").trim().to_string();

        wire_send(WireMessage::TurnBegin(TurnBegin { user_input }));

        if let Some(command_call) = parse_slash_command_call(&text_input) {
            self.handle_slash(&command_call.name, &command_call.args)
                .await?;
        } else if self.runtime.config.loop_control.max_ralph_iterations != 0 {
            let runner = FlowRunner::ralph_loop(
                user_message.clone(),
                self.runtime.config.loop_control.max_ralph_iterations,
            );
            runner.run(self, "").await?;
        } else {
            let _ = self.turn(user_message).await?;
        }
        wire_send(WireMessage::TurnEnd(TurnEnd::default()));
        Ok(())
    }
}

pub struct FlowRunner {
    flow: Flow,
    name: Option<String>,
    max_moves: i64,
}

#[derive(Clone)]
struct FlowPrompt {
    user_input: UserInput,
    text: String,
}

impl FlowRunner {
    pub fn new(flow: Flow, name: Option<String>, max_moves: i64) -> Self {
        Self {
            flow,
            name,
            max_moves,
        }
    }

    pub fn ralph_loop(user_message: Message, max_ralph_iterations: i64) -> FlowRunner {
        let prompt_content = user_message.content.clone();
        let prompt_text = Message::new(Role::User, prompt_content.clone())
            .extract_text(" ")
            .trim()
            .to_string();
        let total_runs = if max_ralph_iterations < 0 {
            1_000_000_000_000_000i64
        } else {
            max_ralph_iterations + 1
        };

        let mut nodes: HashMap<String, FlowNode> = HashMap::new();
        let mut outgoing: HashMap<String, Vec<FlowEdge>> = HashMap::new();

        nodes.insert(
            "BEGIN".to_string(),
            FlowNode::new("BEGIN", "BEGIN", FlowNodeKind::Begin),
        );
        nodes.insert(
            "END".to_string(),
            FlowNode::new("END", "END", FlowNodeKind::End),
        );
        nodes.insert(
            "R1".to_string(),
            FlowNode::new("R1", prompt_content.clone(), FlowNodeKind::Task),
        );
        nodes.insert(
            "R2".to_string(),
            FlowNode::new(
                "R2",
                format!(
                    "{}. (You are running in an automated loop where the same prompt is fed repeatedly. Only choose STOP when the task is fully complete. Including it will stop further iterations. If you are not 100% sure, choose CONTINUE.)",
                    prompt_text
                ),
                FlowNodeKind::Decision,
            ),
        );

        outgoing.insert(
            "BEGIN".to_string(),
            vec![FlowEdge::new("BEGIN", "R1", None)],
        );
        outgoing.insert("R1".to_string(), vec![FlowEdge::new("R1", "R2", None)]);
        outgoing.insert(
            "R2".to_string(),
            vec![
                FlowEdge::new("R2", "R2", Some("CONTINUE".to_string())),
                FlowEdge::new("R2", "END", Some("STOP".to_string())),
            ],
        );
        outgoing.insert("END".to_string(), Vec::new());

        let flow = Flow::new(nodes, outgoing, "BEGIN", "END");
        FlowRunner::new(flow, None, total_runs)
    }

    pub async fn run(&self, soul: &KimiSoul, args: &str) -> anyhow::Result<()> {
        if !args.trim().is_empty() {
            let command = if let Some(name) = &self.name {
                format!("/{FLOW_COMMAND_PREFIX}{name}")
            } else {
                "/flow".to_string()
            };
            warn!("Agent flow {command} ignores args: {args}");
            return Ok(());
        }

        let mut current_id = self.flow.begin_id.clone();
        let mut moves = 0i64;
        let mut total_steps = 0i64;

        loop {
            let node = self
                .flow
                .nodes
                .get(&current_id)
                .expect("flow node not found");
            let edges = self
                .flow
                .outgoing
                .get(&current_id)
                .cloned()
                .unwrap_or_default();

            if node.kind == FlowNodeKind::End {
                info!("Agent flow reached END node {}", current_id);
                return Ok(());
            }
            if node.kind == FlowNodeKind::Begin {
                if edges.is_empty() {
                    error!(
                        "Agent flow BEGIN node \"{}\" has no outgoing edges; stopping.",
                        node.id
                    );
                    return Ok(());
                }
                current_id = edges[0].dst.clone();
                continue;
            }

            if moves >= self.max_moves {
                return Err(anyhow::Error::new(MaxStepsReached::new(total_steps)));
            }

            let (next_id, steps_used) = self.execute_flow_node(soul, node, &edges).await?;
            total_steps += steps_used;
            if let Some(next_id) = next_id {
                moves += 1;
                current_id = next_id;
                continue;
            }
            return Ok(());
        }
    }

    async fn execute_flow_node(
        &self,
        soul: &KimiSoul,
        node: &FlowNode,
        edges: &[FlowEdge],
    ) -> anyhow::Result<(Option<String>, i64)> {
        if edges.is_empty() {
            error!(
                "Agent flow node \"{}\" has no outgoing edges; stopping.",
                node.id
            );
            return Ok((None, 0));
        }

        let base_prompt = self.build_flow_prompt(node, edges);
        let mut prompt = base_prompt.user_input.clone();
        let mut steps_used = 0;
        loop {
            let outcome = self.flow_turn(soul, prompt.clone()).await?;
            steps_used += outcome.step_count;
            if outcome.stop_reason == "tool_rejected" {
                error!("Agent flow stopped after tool rejection.");
                return Ok((None, steps_used));
            }
            if node.kind != FlowNodeKind::Decision {
                return Ok((Some(edges[0].dst.clone()), steps_used));
            }
            let choice = outcome
                .final_message
                .as_ref()
                .and_then(|msg| parse_choice(&msg.extract_text(" ")));
            if let Some(choice_value) = choice.as_ref() {
                if let Some(next_id) = edges
                    .iter()
                    .find(|edge| edge.label.as_deref() == Some(choice_value.as_str()))
                    .map(|edge| edge.dst.clone())
                {
                    return Ok((Some(next_id), steps_used));
                }
            }
            let options = edges
                .iter()
                .filter_map(|edge| edge.label.as_deref())
                .collect::<Vec<_>>()
                .join(", ");
            warn!(
                "Agent flow invalid choice. Got: {}. Available: {}.",
                choice.clone().unwrap_or_else(|| "<missing>".to_string()),
                options
            );
            prompt = UserInput::Text(format!(
                "{}\n\nYour last response did not include a valid choice. Reply with one of the choices using <choice>...</choice>.",
                base_prompt.text
            ));
        }
    }

    fn build_flow_prompt(&self, node: &FlowNode, edges: &[FlowEdge]) -> FlowPrompt {
        if node.kind != FlowNodeKind::Decision {
            return match &node.label {
                FlowLabel::Parts(parts) => FlowPrompt {
                    user_input: UserInput::Parts(parts.clone()),
                    text: node.label_as_string(),
                },
                FlowLabel::Text(text) => FlowPrompt {
                    user_input: UserInput::Text(text.clone()),
                    text: text.clone(),
                },
            };
        }
        let label_text = node.label_as_string();
        let choices: Vec<String> = edges.iter().filter_map(|edge| edge.label.clone()).collect();
        let mut lines = Vec::new();
        lines.push(label_text);
        lines.push(String::new());
        lines.push("Available branches:".to_string());
        for choice in choices {
            lines.push(format!("- {choice}"));
        }
        lines.push(String::new());
        lines.push("Reply with a choice using <choice>...</choice>.".to_string());
        let text = lines.join("\n");
        FlowPrompt {
            user_input: UserInput::Text(text.clone()),
            text,
        }
    }

    async fn flow_turn(&self, soul: &KimiSoul, prompt: UserInput) -> anyhow::Result<TurnOutcome> {
        wire_send(WireMessage::TurnBegin(TurnBegin {
            user_input: prompt.clone(),
        }));
        let message = match prompt {
            UserInput::Text(text) => {
                Message::new(Role::User, vec![ContentPart::Text(TextPart::new(text))])
            }
            UserInput::Parts(parts) => Message::new(Role::User, parts),
        };
        let outcome = soul.turn(message).await?;
        wire_send(WireMessage::TurnEnd(TurnEnd::default()));
        Ok(outcome)
    }
}

async fn stop_approval_task(task: tokio::task::JoinHandle<()>) {
    task.abort();
    match task.await {
        Ok(_) => {}
        Err(err) => {
            if !err.is_cancelled() {
                error!("Approval piping task failed: {:?}", err);
            }
        }
    }
}

fn spawn_approval_task(approval: Arc<Approval>) -> tokio::task::JoinHandle<()> {
    crate::soul::spawn_with_current_wire(async move {
        loop {
            let request = match approval.fetch_request().await {
                Ok(req) => req,
                Err(_) => return,
            };
            let wire_request = ApprovalRequest::new(
                request.id.clone(),
                request.tool_call_id.clone(),
                request.sender.clone(),
                request.action.clone(),
                request.description.clone(),
                request.display.clone(),
            );
            wire_send(WireMessage::ApprovalRequest(wire_request.clone()));
            let resp = wire_request.wait().await;
            let _ = approval.resolve_request(&request.id, resp.clone());
            wire_send(WireMessage::ApprovalResponse(ApprovalResponse {
                request_id: request.id,
                response: resp,
            }));
        }
    })
}

fn retry_delay(attempt: usize) -> Duration {
    let base = 0.3 * 2f64.powi((attempt as i32).saturating_sub(1));
    let capped = base.min(5.0);
    let jitter: f64 = rand::rng().random_range(0.0..0.5);
    Duration::from_secs_f64(capped + jitter)
}

fn is_retryable_error(err: &ChatProviderError) -> bool {
    match err.kind {
        ChatProviderErrorKind::Connection
        | ChatProviderErrorKind::Timeout
        | ChatProviderErrorKind::EmptyResponse => true,
        ChatProviderErrorKind::Status(code) => matches!(code, 429 | 500 | 502 | 503),
        ChatProviderErrorKind::Other => false,
    }
}
