use schemars::JsonSchema;
use serde::Deserialize;

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_ok};

pub struct Plus;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PlusParams {
    pub a: f64,
    pub b: f64,
}

#[async_trait::async_trait]
impl CallableTool2 for Plus {
    type Params = PlusParams;

    fn name(&self) -> &str {
        "plus"
    }

    fn description(&self) -> &str {
        "Add two numbers"
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let sum = params.a + params.b;
        tool_ok(format!("{:?}", sum), "", "")
    }
}

pub struct Compare;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CompareParams {
    pub a: f64,
    pub b: f64,
}

#[async_trait::async_trait]
impl CallableTool2 for Compare {
    type Params = CompareParams;

    fn name(&self) -> &str {
        "compare"
    }

    fn description(&self) -> &str {
        "Compare two numbers"
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let result = if params.a > params.b {
            "greater"
        } else if params.a < params.b {
            "less"
        } else {
            "equal"
        };
        tool_ok(result, "", "")
    }
}

pub struct Panic;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PanicParams {
    pub message: String,
}

#[async_trait::async_trait]
impl CallableTool2 for Panic {
    type Params = PanicParams;

    fn name(&self) -> &str {
        "panic"
    }

    fn description(&self) -> &str {
        "Raise an exception to cause the tool call to fail."
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let msg = format!(
            "panicked with a message with {} characters",
            params.message.chars().count()
        );
        panic!("{msg}");
    }
}
