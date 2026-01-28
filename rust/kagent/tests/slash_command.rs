use std::collections::BTreeMap;

use kagent::utils::{SlashCommandRegistry, parse_slash_command_call};

fn snapshot_commands(registry: &SlashCommandRegistry<()>) -> String {
    let mut alias_to_cmd = BTreeMap::new();
    for cmd in registry.list_commands() {
        alias_to_cmd.insert(cmd.name.clone(), cmd.clone());
        for alias in &cmd.aliases {
            alias_to_cmd.insert(alias.clone(), cmd.clone());
        }
    }

    let mut pretty = BTreeMap::new();
    for (alias, cmd) in alias_to_cmd {
        pretty.insert(alias, format!("{}: {}", cmd.slash_name(), cmd.description));
    }
    serde_json::to_string_pretty(&pretty).unwrap()
}

#[test]
fn test_parse_slash_command_call() {
    let result = parse_slash_command_call("/help");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some(("help".to_string(), "".to_string(), "/help".to_string()))
    );

    let result = parse_slash_command_call("/search query");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some((
            "search".to_string(),
            "query".to_string(),
            "/search query".to_string()
        ))
    );

    let result = parse_slash_command_call("/skill:doc-writing");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some((
            "skill:doc-writing".to_string(),
            "".to_string(),
            "/skill:doc-writing".to_string()
        ))
    );

    assert!(parse_slash_command_call("//comment").is_none());
    assert!(parse_slash_command_call("//").is_none());
    assert!(parse_slash_command_call("/* comment */").is_none());
    assert!(parse_slash_command_call("# comment").is_none());
    assert!(parse_slash_command_call("#!/bin/bash").is_none());

    let result = parse_slash_command_call("/echo 你好世界");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some((
            "echo".to_string(),
            "你好世界".to_string(),
            "/echo 你好世界".to_string()
        ))
    );

    let result = parse_slash_command_call("/search 中文查询 english query");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some((
            "search".to_string(),
            "中文查询 english query".to_string(),
            "/search 中文查询 english query".to_string()
        ))
    );

    let result = parse_slash_command_call("/skill:update-docs 这是一个 带空格的    内容");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some((
            "skill:update-docs".to_string(),
            "这是一个 带空格的    内容".to_string(),
            "/skill:update-docs 这是一个 带空格的    内容".to_string()
        ))
    );

    assert!(parse_slash_command_call("/测试命令 参数").is_none());
    assert!(parse_slash_command_call("/命令").is_none());
    assert!(parse_slash_command_call("").is_none());
    assert!(parse_slash_command_call("help").is_none());
    assert!(parse_slash_command_call("/").is_none());
    assert!(parse_slash_command_call("/skill:").is_none());
    assert!(parse_slash_command_call("/.invalid").is_none());

    let result = parse_slash_command_call("/cmd \"unmatched quote");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some((
            "cmd".to_string(),
            "\"unmatched quote".to_string(),
            "/cmd \"unmatched quote".to_string()
        ))
    );

    let result = parse_slash_command_call("/cmd '");
    assert_eq!(
        result.map(|call| (call.name, call.args, call.raw_input)),
        Some(("cmd".to_string(), "'".to_string(), "/cmd '".to_string()))
    );
}

#[test]
fn test_slash_command_registration() {
    let mut registry: SlashCommandRegistry<()> = SlashCommandRegistry::new();

    registry.register(
        "basic".to_string(),
        "Basic command.".to_string(),
        (),
        vec![],
    );
    registry.register("run".to_string(), "Run something.".to_string(), (), vec![]);
    registry.register(
        "help".to_string(),
        "Show help.".to_string(),
        (),
        vec!["h".to_string(), "?".to_string()],
    );
    registry.register(
        "search".to_string(),
        "Search items.".to_string(),
        (),
        vec!["s".to_string(), "find".to_string()],
    );
    registry.register("no_doc".to_string(), "".to_string(), (), vec![]);
    registry.register(
        "whitespace_doc".to_string(),
        " \n\t".to_string(),
        (),
        vec![],
    );
    registry.register(
        "dedup_test".to_string(),
        "Test deduplication.".to_string(),
        (),
        vec!["dup".to_string(), "dup".to_string()],
    );

    let pretty = snapshot_commands(&registry);
    assert_eq!(
        pretty,
        "\
{\n  \"?\": \"/help (h, ?): Show help.\",\n  \"basic\": \"/basic: Basic command.\",\n  \"dedup_test\": \"/dedup_test (dup, dup): Test deduplication.\",\n  \"dup\": \"/dedup_test (dup, dup): Test deduplication.\",\n  \"find\": \"/search (s, find): Search items.\",\n  \"h\": \"/help (h, ?): Show help.\",\n  \"help\": \"/help (h, ?): Show help.\",\n  \"no_doc\": \"/no_doc: \",\n  \"run\": \"/run: Run something.\",\n  \"s\": \"/search (s, find): Search items.\",\n  \"search\": \"/search (s, find): Search items.\",\n  \"whitespace_doc\": \"/whitespace_doc: \"\n}"
    );
}

#[test]
fn test_slash_command_overwriting() {
    let mut registry: SlashCommandRegistry<()> = SlashCommandRegistry::new();

    registry.register(
        "test_cmd".to_string(),
        "First version.".to_string(),
        (),
        vec![],
    );

    let pretty = snapshot_commands(&registry);
    assert_eq!(
        pretty,
        "{\n  \"test_cmd\": \"/test_cmd: First version.\"\n}"
    );

    registry.register(
        "test_cmd".to_string(),
        "Second version.".to_string(),
        (),
        vec![],
    );
    let pretty = snapshot_commands(&registry);
    assert_eq!(
        pretty,
        "{\n  \"test_cmd\": \"/test_cmd: Second version.\"\n}"
    );
}
