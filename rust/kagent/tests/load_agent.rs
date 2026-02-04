mod tool_test_utils;

use tempfile::TempDir;

use kagent::exception::SystemPromptTemplateError;
use kagent::soul::agent::load_agent;
use kagent::soul::toolset::KimiToolset;
use kosong::tooling::Toolset;

use tool_test_utils::RuntimeFixture;

fn write_file(path: &std::path::Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, content).expect("write file");
}

#[tokio::test]
async fn test_load_system_prompt_substitution() {
    let fixture = RuntimeFixture::new();

    let dir = TempDir::new().expect("temp dir");
    let system_md = dir.path().join("system.md");
    write_file(
        &system_md,
        "Test system prompt with ${KIMI_NOW} and ${CUSTOM_ARG}",
    );

    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  system_prompt_args:
    CUSTOM_ARG: "test_value"
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let agent = load_agent(&agent_yaml, fixture.runtime.clone(), &[])
        .await
        .expect("load agent");

    assert!(agent.system_prompt.contains("Test system prompt with"));
    assert!(
        agent
            .system_prompt
            .contains(&fixture.runtime.builtin_args.KIMI_NOW)
    );
    assert!(agent.system_prompt.contains("test_value"));
}

#[tokio::test]
async fn test_load_system_prompt_allows_literal_dollar() {
    let fixture = RuntimeFixture::new();

    let dir = TempDir::new().expect("temp dir");
    let system_md = dir.path().join("system.md");
    write_file(&system_md, "Price is $100, path $PATH, time ${KIMI_NOW}.");

    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let agent = load_agent(&agent_yaml, fixture.runtime.clone(), &[])
        .await
        .expect("load agent");

    assert!(agent.system_prompt.contains("$100"));
    assert!(agent.system_prompt.contains("$PATH"));
    assert!(
        agent
            .system_prompt
            .contains(&fixture.runtime.builtin_args.KIMI_NOW)
    );
}

#[tokio::test]
async fn test_load_system_prompt_missing_arg_raises() {
    let fixture = RuntimeFixture::new();

    let dir = TempDir::new().expect("temp dir");
    let system_md = dir.path().join("system.md");
    write_file(&system_md, "Missing ${UNKNOWN_ARG}.");

    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let err = match load_agent(&agent_yaml, fixture.runtime.clone(), &[]).await {
        Ok(_) => panic!("expected error"),
        Err(err) => err,
    };
    assert!(err.downcast_ref::<SystemPromptTemplateError>().is_some());
}

#[test]
fn test_load_tools_valid() {
    let fixture = RuntimeFixture::new();
    let tool_paths = vec![
        "kimi_cli.tools.think:Think".to_string(),
        "kimi_cli.tools.shell:Shell".to_string(),
    ];
    let mut toolset = KimiToolset::new();
    let deps_toolset = std::sync::Arc::new(tokio::sync::Mutex::new(KimiToolset::new()));
    toolset
        .load_tools(&tool_paths, &fixture.runtime, deps_toolset)
        .expect("load tools");
    assert_eq!(toolset.tools().len(), 2);
}

#[test]
fn test_load_tools_invalid() {
    let fixture = RuntimeFixture::new();
    let tool_paths = vec![
        "kimi_cli.tools.nonexistent:Tool".to_string(),
        "kimi_cli.tools.think:Think".to_string(),
    ];
    let mut toolset = KimiToolset::new();
    let deps_toolset = std::sync::Arc::new(tokio::sync::Mutex::new(KimiToolset::new()));
    let result = toolset.load_tools(&tool_paths, &fixture.runtime, deps_toolset);
    let err = result.expect_err("expected error");
    assert!(err.to_string().contains("kimi_cli.tools.nonexistent:Tool"));
}

#[tokio::test]
async fn test_load_agent_invalid_tools() {
    let fixture = RuntimeFixture::new();

    let dir = TempDir::new().expect("temp dir");
    let system_md = dir.path().join("system.md");
    write_file(&system_md, "You are a test agent");

    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 1
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.nonexistent:Tool"]
"#,
    );

    match load_agent(&agent_yaml, fixture.runtime.clone(), &[]).await {
        Ok(_) => panic!("expected error"),
        Err(err) => assert!(err.to_string().contains("Invalid tools")),
    }
}
