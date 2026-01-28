use std::collections::HashMap;

use kagent::config::{
    Config, LoopControl, MCPConfig, Services, get_default_config, load_config_from_string,
};

#[test]
fn test_default_config() {
    let config = get_default_config();
    let expected = Config {
        is_from_default_location: false,
        default_model: String::new(),
        default_thinking: false,
        models: HashMap::new(),
        providers: HashMap::new(),
        loop_control: LoopControl::default(),
        services: Services::default(),
        mcp: MCPConfig::default(),
    };
    assert_eq!(config, expected);
}

#[test]
fn test_default_config_dump() {
    let config = get_default_config();
    let value = serde_json::to_value(&config).expect("serialize config");
    assert_eq!(
        value,
        serde_json::json!({
            "default_model": "",
            "default_thinking": false,
            "models": {},
            "providers": {},
            "loop_control": {
                "max_steps_per_turn": 100,
                "max_retries_per_step": 3,
                "max_ralph_iterations": 0,
                "reserved_context_size": 50000,
            },
            "services": {
            },
            "mcp": {
                "client": {
                    "tool_call_timeout_ms": 60000,
                },
            },
        })
    );
}

#[test]
fn test_load_config_text_toml() {
    let config = load_config_from_string("default_model = \"\"").expect("load toml");
    assert_eq!(config, get_default_config());
}

#[test]
fn test_load_config_text_json() {
    let config = load_config_from_string("{\"default_model\": \"\"}").expect("load json");
    assert_eq!(config, get_default_config());
}

#[test]
fn test_load_config_text_invalid() {
    let err = load_config_from_string("not valid {").expect_err("invalid config");
    assert!(err.to_string().contains("Invalid configuration text"));
}

#[test]
fn test_load_config_invalid_ralph_iterations() {
    let err = load_config_from_string("{\"loop_control\": {\"max_ralph_iterations\": -2}}")
        .expect_err("invalid ralph iterations");
    assert!(err.to_string().contains("max_ralph_iterations"));
}

#[test]
fn test_load_config_reserved_context_size() {
    let config = load_config_from_string("{\"loop_control\": {\"reserved_context_size\": 30000}}")
        .expect("load config");
    assert_eq!(config.loop_control.reserved_context_size, 30000);
}

#[test]
fn test_load_config_reserved_context_size_too_low() {
    let err = load_config_from_string("{\"loop_control\": {\"reserved_context_size\": 500}}")
        .expect_err("reserved_context_size too low");
    assert!(err.to_string().contains("reserved_context_size"));
}
