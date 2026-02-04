use schemars::JsonSchema;
use serde::Deserialize;

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_ok};

pub struct Think {
    description: String,
}

impl Think {
    pub fn new(_runtime: &crate::soul::agent::Runtime) -> Self {
        Self {
            description: include_str!("desc/think/think.md").to_string(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ThinkParams {
    /// A thought to think about.
    #[schemars(description = "A thought to think about.")]
    pub thought: String,
}

#[async_trait::async_trait]
impl CallableTool2 for Think {
    type Params = ThinkParams;

    fn name(&self) -> &str {
        "Think"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, _params: Self::Params) -> ToolReturnValue {
        tool_ok("", "Thought logged", "")
    }
}
