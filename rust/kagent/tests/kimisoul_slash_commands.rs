mod tool_test_utils;

use std::collections::HashMap;

use tempfile::TempDir;

use kagent::skill::flow::{Flow, FlowEdge, FlowLabel, FlowNode, FlowNodeKind};
use kagent::skill::{Skill, SkillType};
use kagent::soul::Soul;
use kagent::soul::agent::Agent;
use kagent::soul::context::Context;
use kagent::soul::kimisoul::KimiSoul;
use kagent::soul::toolset::KimiToolset;
use kagent::utils::SlashCommandInfo;
use kaos::KaosPath;
use tool_test_utils::RuntimeFixture;

fn make_flow() -> Flow {
    let mut nodes = HashMap::new();
    nodes.insert(
        "BEGIN".to_string(),
        FlowNode::new("BEGIN", FlowLabel::from("Begin"), FlowNodeKind::Begin),
    );
    nodes.insert(
        "END".to_string(),
        FlowNode::new("END", FlowLabel::from("End"), FlowNodeKind::End),
    );

    let mut outgoing = HashMap::new();
    outgoing.insert(
        "BEGIN".to_string(),
        vec![FlowEdge::new("BEGIN", "END", None)],
    );
    outgoing.insert("END".to_string(), vec![]);

    Flow::new(nodes, outgoing, "BEGIN", "END")
}

#[test]
fn test_flow_skill_registers_skill_and_flow_commands() {
    let fixture = RuntimeFixture::new();
    let temp = TempDir::new().expect("temp dir");

    let flow = make_flow();
    let skill_dir = temp.path().join("flow-skill");
    std::fs::create_dir_all(&skill_dir).expect("create skill dir");
    let flow_skill = Skill {
        name: "flow-skill".to_string(),
        description: "Flow skill".to_string(),
        skill_type: SkillType::Flow,
        dir: KaosPath::unsafe_from_local_path(&skill_dir),
        flow: Some(flow),
    };

    let mut runtime = fixture.runtime.clone();
    runtime.skills = HashMap::from([("flow-skill".to_string(), flow_skill)]);

    let agent = Agent {
        name: "Test Agent".to_string(),
        system_prompt: "Test system prompt.".to_string(),
        toolset: std::sync::Arc::new(tokio::sync::Mutex::new(KimiToolset::new())),
        runtime,
    };
    let soul = KimiSoul::new(agent, Context::new(temp.path().join("history.jsonl")));

    let command_names: std::collections::HashSet<String> = soul
        .available_slash_commands()
        .into_iter()
        .map(|cmd: SlashCommandInfo| cmd.name)
        .collect();

    assert!(command_names.contains("skill:flow-skill"));
    assert!(command_names.contains("flow:flow-skill"));
}
