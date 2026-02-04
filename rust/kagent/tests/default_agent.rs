mod tool_test_utils;

use std::collections::HashMap;

use kagent::agentspec::{default_agent_file, load_agent_spec};
use kagent::soul::agent::load_agent;
use kosong::tooling::Toolset;
use tool_test_utils::RuntimeFixture;

fn build_expected_prompt(
    template: &str,
    prompt_args: &HashMap<String, String>,
    runtime: &tool_test_utils::RuntimeFixture,
    work_dir_placeholder: &str,
) -> String {
    let mut expected = template.trim().to_string();
    let mut values = HashMap::new();
    values.insert(
        "ROLE_ADDITIONAL".to_string(),
        prompt_args
            .get("ROLE_ADDITIONAL")
            .cloned()
            .unwrap_or_default(),
    );
    values.insert(
        "KIMI_NOW".to_string(),
        runtime.runtime.builtin_args.KIMI_NOW.clone(),
    );
    values.insert(
        "KIMI_WORK_DIR".to_string(),
        work_dir_placeholder.to_string(),
    );
    values.insert(
        "KIMI_WORK_DIR_LS".to_string(),
        runtime.runtime.builtin_args.KIMI_WORK_DIR_LS.clone(),
    );
    values.insert(
        "KIMI_AGENTS_MD".to_string(),
        runtime.runtime.builtin_args.KIMI_AGENTS_MD.clone(),
    );
    values.insert(
        "KIMI_SKILLS".to_string(),
        runtime.runtime.builtin_args.KIMI_SKILLS.clone(),
    );

    for (key, value) in values {
        expected = expected.replace(&format!("${{{}}}", key), &value);
        expected = expected.replace(&format!("${}", key), &value);
    }

    expected
}

#[tokio::test]
async fn test_default_agent() {
    if cfg!(windows) {
        return;
    }

    let fixture = RuntimeFixture::new();
    let agent_file = default_agent_file();
    let spec = load_agent_spec(&agent_file).await.expect("load agent spec");

    let agent = load_agent(&agent_file, fixture.runtime.clone(), &[])
        .await
        .expect("load agent");

    let template = std::fs::read_to_string(&spec.system_prompt_path).expect("read system prompt");
    let work_dir_placeholder = "/path/to/work/dir";
    let expected = build_expected_prompt(
        &template,
        &spec.system_prompt_args,
        &fixture,
        work_dir_placeholder,
    );

    let actual = agent.system_prompt.replace(
        &fixture.runtime.builtin_args.KIMI_WORK_DIR.to_string_lossy(),
        work_dir_placeholder,
    );

    assert_eq!(actual, expected);

    let mut expected_tool_names: Vec<String> = spec
        .tools
        .iter()
        .filter_map(|tool| tool.split(':').last())
        .map(|name| name.to_string())
        .collect();
    expected_tool_names.sort();

    let toolset_guard = agent.toolset.lock().await;
    let mut actual_tool_names: Vec<String> = toolset_guard
        .tools()
        .iter()
        .map(|tool| tool.name.clone())
        .collect();
    actual_tool_names.sort();

    assert_eq!(actual_tool_names, expected_tool_names);
}
