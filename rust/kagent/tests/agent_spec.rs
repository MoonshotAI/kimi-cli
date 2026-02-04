use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use kagent::agentspec::{default_agent_file, load_agent_spec};
use kagent::exception::AgentSpecError;

fn write_file(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, content).expect("write file");
}

fn canonical_or(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

fn as_strs(values: &[String]) -> Vec<&str> {
    values.iter().map(String::as_str).collect()
}

#[tokio::test]
async fn test_load_default_agent_spec() {
    let agent_file = default_agent_file();
    let spec = load_agent_spec(&agent_file)
        .await
        .expect("load default agent spec");

    assert_eq!(spec.name, "");
    assert_eq!(
        spec.system_prompt_path,
        canonical_or(agent_file.parent().unwrap().join("system.md"))
    );
    assert_eq!(
        spec.system_prompt_args,
        HashMap::from([("ROLE_ADDITIONAL".to_string(), "".to_string())])
    );
    assert!(spec.exclude_tools.is_empty());
    assert_eq!(
        as_strs(&spec.tools),
        vec![
            "kimi_cli.tools.multiagent:Task",
            "kimi_cli.tools.todo:SetTodoList",
            "kimi_cli.tools.shell:Shell",
            "kimi_cli.tools.file:ReadFile",
            "kimi_cli.tools.file:ReadMediaFile",
            "kimi_cli.tools.file:Glob",
            "kimi_cli.tools.file:Grep",
            "kimi_cli.tools.file:WriteFile",
            "kimi_cli.tools.file:StrReplaceFile",
            "kimi_cli.tools.web:SearchWeb",
            "kimi_cli.tools.web:FetchURL",
        ]
    );

    let subagent = spec.subagents.get("coder").expect("coder subagent");
    assert_eq!(
        subagent.description,
        "Good at general software engineering tasks."
    );
    assert_eq!(
        subagent.path,
        canonical_or(agent_file.parent().unwrap().join("sub.yaml"))
    );

    let sub_spec = load_agent_spec(&subagent.path)
        .await
        .expect("load subagent spec");
    assert_eq!(sub_spec.name, "");
    assert_eq!(
        sub_spec.system_prompt_path,
        canonical_or(agent_file.parent().unwrap().join("system.md"))
    );
    assert_eq!(
        sub_spec.system_prompt_args,
        HashMap::from([(
            "ROLE_ADDITIONAL".to_string(),
            "You are now running as a subagent. All the `user` messages are sent by the main agent. The main agent cannot see your context, it can only see your last message when you finish the task. You need to provide a comprehensive summary on what you have done and learned in your final message. If you wrote or modified any files, you must mention them in the summary.\n"
                .to_string(),
        )])
    );
    assert_eq!(
        as_strs(&sub_spec.exclude_tools),
        vec![
            "kimi_cli.tools.multiagent:Task",
            "kimi_cli.tools.multiagent:CreateSubagent",
            "kimi_cli.tools.dmail:SendDMail",
            "kimi_cli.tools.todo:SetTodoList",
        ]
    );
    assert_eq!(
        as_strs(&sub_spec.tools),
        vec![
            "kimi_cli.tools.multiagent:Task",
            "kimi_cli.tools.todo:SetTodoList",
            "kimi_cli.tools.shell:Shell",
            "kimi_cli.tools.file:ReadFile",
            "kimi_cli.tools.file:ReadMediaFile",
            "kimi_cli.tools.file:Glob",
            "kimi_cli.tools.file:Grep",
            "kimi_cli.tools.file:WriteFile",
            "kimi_cli.tools.file:StrReplaceFile",
            "kimi_cli.tools.web:SearchWeb",
            "kimi_cli.tools.web:FetchURL",
        ]
    );
    assert!(sub_spec.subagents.is_empty());
}

#[tokio::test]
async fn test_load_agent_spec_basic() {
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
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let spec = load_agent_spec(&agent_yaml).await.expect("load agent spec");

    assert_eq!(spec.name, "Test Agent");
    assert_eq!(spec.system_prompt_path, canonical_or(system_md));
    assert_eq!(as_strs(&spec.tools), vec!["kimi_cli.tools.think:Think"]);
}

#[tokio::test]
async fn test_load_agent_spec_missing_name() {
    let dir = TempDir::new().expect("temp dir");
    let system_md = dir.path().join("system.md");
    write_file(&system_md, "You are a test agent");

    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 1
agent:
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let err = load_agent_spec(&agent_yaml)
        .await
        .expect_err("expected error");
    assert_eq!(err.to_string(), "Agent name is required");
}

#[tokio::test]
async fn test_load_agent_spec_missing_system_prompt() {
    let dir = TempDir::new().expect("temp dir");
    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 1
agent:
  name: "Test Agent"
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let err = load_agent_spec(&agent_yaml)
        .await
        .expect_err("expected error");
    assert_eq!(err.to_string(), "System prompt path is required");
}

#[tokio::test]
async fn test_load_agent_spec_missing_tools() {
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
"#,
    );

    let err = load_agent_spec(&agent_yaml)
        .await
        .expect_err("expected error");
    assert_eq!(err.to_string(), "Tools are required");
}

#[tokio::test]
async fn test_load_agent_spec_with_exclude_tools() {
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
  tools: ["kimi_cli.tools.think:Think", "kimi_cli.tools.shell:Shell"]
  exclude_tools: ["kimi_cli.tools.shell:Shell"]
"#,
    );

    let spec = load_agent_spec(&agent_yaml).await.expect("load agent spec");
    assert_eq!(
        as_strs(&spec.tools),
        vec!["kimi_cli.tools.think:Think", "kimi_cli.tools.shell:Shell"]
    );
    assert_eq!(
        as_strs(&spec.exclude_tools),
        vec!["kimi_cli.tools.shell:Shell"]
    );
}

#[tokio::test]
async fn test_load_agent_spec_extension() {
    let dir = TempDir::new().expect("temp dir");

    let base_agent = dir.path().join("base.yaml");
    write_file(
        &base_agent,
        r#"version: 1
agent:
  name: "Base Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let system_md = dir.path().join("system.md");
    write_file(&system_md, "Base system prompt");

    let extending_agent = dir.path().join("extending.yaml");
    write_file(
        &extending_agent,
        r#"version: 1
agent:
  extend: ./base.yaml
  name: "Extended Agent"
  system_prompt_args:
    CUSTOM_ARG: "custom_value"
"#,
    );

    let spec = load_agent_spec(&extending_agent)
        .await
        .expect("load agent spec");
    assert_eq!(spec.name, "Extended Agent");
    assert_eq!(as_strs(&spec.tools), vec!["kimi_cli.tools.think:Think"]);
}

#[tokio::test]
async fn test_load_agent_spec_default_extension() {
    let dir = TempDir::new().expect("temp dir");
    let extending_agent = dir.path().join("extending.yaml");
    write_file(
        &extending_agent,
        r#"version: 1
agent:
  extend: default
  system_prompt_args:
    CUSTOM_ARG: "custom_value"
  exclude_tools:
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
"#,
    );

    let spec = load_agent_spec(&extending_agent)
        .await
        .expect("load agent spec");

    assert_eq!(spec.name, "");
    assert_eq!(
        spec.system_prompt_path,
        canonical_or(default_agent_file().parent().unwrap().join("system.md"))
    );
    assert_eq!(
        spec.system_prompt_args,
        HashMap::from([
            ("ROLE_ADDITIONAL".to_string(), "".to_string()),
            ("CUSTOM_ARG".to_string(), "custom_value".to_string()),
        ])
    );
    assert_eq!(
        as_strs(&spec.tools),
        vec![
            "kimi_cli.tools.multiagent:Task",
            "kimi_cli.tools.todo:SetTodoList",
            "kimi_cli.tools.shell:Shell",
            "kimi_cli.tools.file:ReadFile",
            "kimi_cli.tools.file:ReadMediaFile",
            "kimi_cli.tools.file:Glob",
            "kimi_cli.tools.file:Grep",
            "kimi_cli.tools.file:WriteFile",
            "kimi_cli.tools.file:StrReplaceFile",
            "kimi_cli.tools.web:SearchWeb",
            "kimi_cli.tools.web:FetchURL",
        ]
    );
    assert_eq!(
        as_strs(&spec.exclude_tools),
        vec![
            "kimi_cli.tools.web:SearchWeb",
            "kimi_cli.tools.web:FetchURL",
        ]
    );
    assert!(spec.subagents.contains_key("coder"));
}

#[tokio::test]
async fn test_load_agent_spec_unsupported_version() {
    let dir = TempDir::new().expect("temp dir");
    let agent_yaml = dir.path().join("agent.yaml");
    write_file(
        &agent_yaml,
        r#"version: 2
agent:
  name: "Test Agent"
  system_prompt_path: ./system.md
  tools: ["kimi_cli.tools.think:Think"]
"#,
    );

    let err = load_agent_spec(&agent_yaml)
        .await
        .expect_err("expected error");
    assert_eq!(err.to_string(), "Unsupported agent spec version: 2");
}

#[tokio::test]
async fn test_load_agent_spec_nonexistent_file() {
    let path = PathBuf::from("/nonexistent/agent.yaml");
    let err = load_agent_spec(&path).await.expect_err("expected error");
    let message = err.to_string();
    assert!(message.starts_with("Agent spec file not found:"));
    assert!(message.contains("nonexistent"));
}

#[test]
fn test_agent_spec_error_is_displayable() {
    let err = AgentSpecError::new("boom");
    assert_eq!(err.to_string(), "boom");
}
