mod tool_test_utils;

use std::sync::Arc;

use kagent::soul::toolset::KimiToolset;
use kagent::tools::multiagent::{CreateSubagent, CreateSubagentParams};
use kosong::tooling::CallableTool2;

use tool_test_utils::RuntimeFixture;

#[tokio::test]
async fn test_create_subagent() {
    let fixture = RuntimeFixture::new();
    let tool = CreateSubagent::new(
        Arc::new(tokio::sync::Mutex::new(KimiToolset::new())),
        &fixture.runtime,
    );

    let result = tool
        .call_typed(CreateSubagentParams {
            name: "test_agent".to_string(),
            system_prompt: "You are a test agent.".to_string(),
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        result.output,
        kosong::tooling::ToolOutput::Text("Available subagents: mocker, test_agent".to_string())
    );
    assert_eq!(
        result.message,
        "Subagent 'test_agent' created successfully."
    );
    let subagents = fixture.runtime.labor_market.lock().await.all_subagents();
    assert!(subagents.contains_key("test_agent"));
}

#[tokio::test]
async fn test_create_existing_subagent() {
    let fixture = RuntimeFixture::new();
    let tool = CreateSubagent::new(
        Arc::new(tokio::sync::Mutex::new(KimiToolset::new())),
        &fixture.runtime,
    );

    let _ = tool
        .call_typed(CreateSubagentParams {
            name: "existing_agent".to_string(),
            system_prompt: "You are an existing agent.".to_string(),
        })
        .await;

    let subagents = fixture.runtime.labor_market.lock().await.all_subagents();
    assert!(subagents.contains_key("existing_agent"));

    let result = tool
        .call_typed(CreateSubagentParams {
            name: "existing_agent".to_string(),
            system_prompt: "You are an existing agent.".to_string(),
        })
        .await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        "Subagent with name 'existing_agent' already exists."
    );
    assert_eq!(result.brief(), "Subagent already exists");
    let subagents = fixture.runtime.labor_market.lock().await.all_subagents();
    assert!(subagents.contains_key("existing_agent"));
}
