use schemars::JsonSchema;
use serde::Deserialize;

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error, tool_ok};

use crate::soul::agent::{Agent, Runtime};
use crate::tools::utils::load_desc;

const CREATE_DESC: &str = include_str!("../desc/multiagent/create.md");

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateSubagentParams {
    #[schemars(
        description = "Unique name for this agent configuration (e.g., 'summarizer', 'code_reviewer'). This name will be used to reference the agent in the Task tool."
    )]
    pub name: String,
    #[schemars(
        description = "System prompt defining the agent's role, capabilities, and boundaries."
    )]
    pub system_prompt: String,
}

pub struct CreateSubagent {
    description: String,
    toolset: std::sync::Arc<tokio::sync::Mutex<crate::soul::toolset::KimiToolset>>,
    runtime: Runtime,
}

impl CreateSubagent {
    pub fn new(
        toolset: std::sync::Arc<tokio::sync::Mutex<crate::soul::toolset::KimiToolset>>,
        runtime: &Runtime,
    ) -> Self {
        Self {
            description: load_desc(CREATE_DESC, &[]),
            toolset,
            runtime: runtime.clone(),
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for CreateSubagent {
    type Params = CreateSubagentParams;

    fn name(&self) -> &str {
        "CreateSubagent"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let mut market = self.runtime.labor_market.lock().await;
        if market.all_subagents().contains_key(&params.name) {
            return tool_error(
                "",
                format!("Subagent with name '{}' already exists.", params.name),
                "Subagent already exists",
            );
        }

        let subagent = Agent {
            name: params.name.clone(),
            system_prompt: params.system_prompt,
            toolset: std::sync::Arc::clone(&self.toolset),
            runtime: self.runtime.copy_for_dynamic_subagent(),
        };
        market.add_dynamic_subagent(params.name.clone(), subagent);

        let mut names: Vec<String> = market.all_subagents().keys().cloned().collect();
        names.sort();
        let output = format!("Available subagents: {}", names.join(", "));

        tool_ok(
            output,
            format!("Subagent '{}' created successfully.", params.name),
            "",
        )
    }
}
