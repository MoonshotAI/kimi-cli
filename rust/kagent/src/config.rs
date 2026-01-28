use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::exception::ConfigError;
use crate::share::{ensure_share_dir, get_share_dir};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    Kimi,
    OpenaiLegacy,
    OpenaiResponses,
    Anthropic,
    GoogleGenai,
    Gemini,
    Vertexai,
    #[serde(rename = "_echo")]
    Echo,
    #[serde(rename = "_scripted_echo")]
    ScriptedEcho,
    #[serde(rename = "_chaos")]
    Chaos,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCapability {
    ImageIn,
    VideoIn,
    Thinking,
    AlwaysThinking,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LLMProvider {
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    pub base_url: String,
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LLMModel {
    pub provider: String,
    pub model: String,
    pub max_context_size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<HashSet<ModelCapability>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopControl {
    #[serde(default = "default_max_steps_per_turn", alias = "max_steps_per_run")]
    pub max_steps_per_turn: i64,
    #[serde(default = "default_max_retries_per_step")]
    pub max_retries_per_step: i64,
    #[serde(default = "default_max_ralph_iterations")]
    pub max_ralph_iterations: i64,
    #[serde(default = "default_reserved_context_size")]
    pub reserved_context_size: i64,
}

impl Default for LoopControl {
    fn default() -> Self {
        Self {
            max_steps_per_turn: default_max_steps_per_turn(),
            max_retries_per_step: default_max_retries_per_step(),
            max_ralph_iterations: default_max_ralph_iterations(),
            reserved_context_size: default_reserved_context_size(),
        }
    }
}

impl LoopControl {
    fn validate(&self) -> Result<(), ConfigError> {
        if self.max_steps_per_turn < 1 {
            return Err(ConfigError::new("max_steps_per_turn must be >= 1"));
        }
        if self.max_retries_per_step < 1 {
            return Err(ConfigError::new("max_retries_per_step must be >= 1"));
        }
        if self.max_ralph_iterations < -1 {
            return Err(ConfigError::new("max_ralph_iterations must be >= -1"));
        }
        if self.reserved_context_size < 1000 {
            return Err(ConfigError::new("reserved_context_size must be >= 1000"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoonshotSearchConfig {
    pub base_url: String,
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoonshotFetchConfig {
    pub base_url: String,
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Services {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moonshot_search: Option<MoonshotSearchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moonshot_fetch: Option<MoonshotFetchConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MCPClientConfig {
    #[serde(default = "default_mcp_tool_timeout")]
    pub tool_call_timeout_ms: i64,
}

impl Default for MCPClientConfig {
    fn default() -> Self {
        Self {
            tool_call_timeout_ms: default_mcp_tool_timeout(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MCPConfig {
    #[serde(default)]
    pub client: MCPClientConfig,
}

impl Default for MCPConfig {
    fn default() -> Self {
        Self {
            client: MCPClientConfig::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(skip)]
    pub is_from_default_location: bool,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub default_thinking: bool,
    #[serde(default)]
    pub models: HashMap<String, LLMModel>,
    #[serde(default)]
    pub providers: HashMap<String, LLMProvider>,
    #[serde(default)]
    pub loop_control: LoopControl,
    #[serde(default)]
    pub services: Services,
    #[serde(default)]
    pub mcp: MCPConfig,
}

impl Config {
    pub fn validate(&self) -> Result<(), ConfigError> {
        self.loop_control.validate()?;
        if !self.default_model.is_empty() && !self.models.contains_key(&self.default_model) {
            return Err(ConfigError::new(format!(
                "Default model {} not found in models",
                self.default_model
            )));
        }
        for model in self.models.values() {
            if !self.providers.contains_key(&model.provider) {
                return Err(ConfigError::new(format!(
                    "Provider {} not found in providers",
                    model.provider
                )));
            }
        }
        Ok(())
    }
}

pub fn get_config_file() -> PathBuf {
    get_share_dir().join("config.toml")
}

pub fn get_default_config() -> Config {
    Config {
        is_from_default_location: false,
        default_model: String::new(),
        default_thinking: false,
        models: HashMap::new(),
        providers: HashMap::new(),
        loop_control: LoopControl::default(),
        services: Services::default(),
        mcp: MCPConfig::default(),
    }
}

pub async fn load_config(config_file: Option<&Path>) -> Result<Config, ConfigError> {
    let _ = ensure_share_dir().await;
    let default_config_file = get_config_file();
    let config_file = config_file.unwrap_or(default_config_file.as_path());
    let is_default_config_file =
        normalize_path(config_file).await == normalize_path(&default_config_file).await;
    debug!("Loading config from file: {}", config_file.display());

    if is_default_config_file && !path_exists(config_file).await {
        migrate_json_config_to_toml().await?;
    }

    if !path_exists(config_file).await {
        let mut config = get_default_config();
        debug!(
            "No config file found, creating default config: {:?}",
            config
        );
        save_config(&config, Some(config_file)).await?;
        config.is_from_default_location = is_default_config_file;
        return Ok(config);
    }

    let config_text = tokio::fs::read_to_string(config_file)
        .await
        .map_err(|err| ConfigError::new(format!("Failed to read config file: {err}")))?;

    let mut config: Config = if config_file
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
    {
        let data: serde_json::Value = serde_json::from_str(&config_text).map_err(|err| {
            ConfigError::new(format!("Invalid JSON in configuration file: {err}"))
        })?;
        serde_json::from_value::<Config>(data)
            .map_err(|err| ConfigError::new(format!("Invalid configuration file: {err}")))?
    } else {
        toml::from_str::<Config>(&config_text)
            .map_err(|err| ConfigError::new(format!("Invalid TOML in configuration file: {err}")))?
    };

    config.is_from_default_location = is_default_config_file;
    config
        .validate()
        .map_err(|err| ConfigError::new(format!("Invalid configuration file: {err}")))?;
    Ok(config)
}

pub fn load_config_from_string(config_string: &str) -> Result<Config, ConfigError> {
    if config_string.trim().is_empty() {
        return Err(ConfigError::new("Configuration text cannot be empty"));
    }

    let mut json_error: Option<String> = None;
    let json_value: Option<serde_json::Value> = match serde_json::from_str(config_string) {
        Ok(value) => Some(value),
        Err(err) => {
            json_error = Some(err.to_string());
            None
        }
    };
    if let Some(value) = json_value {
        let mut config: Config = serde_json::from_value(value)
            .map_err(|err| ConfigError::new(format!("Invalid configuration text: {err}")))?;
        config.is_from_default_location = false;
        config
            .validate()
            .map_err(|err| ConfigError::new(format!("Invalid configuration text: {err}")))?;
        return Ok(config);
    }

    let toml_result: Result<Config, _> = toml::from_str::<Config>(config_string);
    match toml_result {
        Ok(mut config) => {
            config.is_from_default_location = false;
            config
                .validate()
                .map_err(|err| ConfigError::new(format!("Invalid configuration text: {err}")))?;
            Ok(config)
        }
        Err(toml_error) => Err(ConfigError::new(format!(
            "Invalid configuration text: {}; {}",
            json_error.unwrap_or_else(|| "invalid json".to_string()),
            toml_error
        ))),
    }
}

pub async fn save_config(config: &Config, config_file: Option<&Path>) -> Result<(), ConfigError> {
    let config_file = config_file
        .map(PathBuf::from)
        .unwrap_or_else(get_config_file);
    debug!("Saving config to file: {}", config_file.display());
    if let Some(parent) = config_file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| ConfigError::new(format!("Failed to create config dir: {err}")))?;
    }

    let mut config_data = config.clone();
    config_data.is_from_default_location = false;

    let contents = if config_file
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
    {
        serde_json::to_string_pretty(&config_data)
            .map_err(|err| ConfigError::new(format!("Failed to serialize config: {err}")))?
    } else {
        toml::to_string_pretty(&config_data)
            .map_err(|err| ConfigError::new(format!("Failed to serialize config: {err}")))?
    };

    tokio::fs::write(&config_file, contents)
        .await
        .map_err(|err| ConfigError::new(format!("Failed to write config file: {err}")))?;
    Ok(())
}

async fn migrate_json_config_to_toml() -> Result<(), ConfigError> {
    let old_json_config_file = get_share_dir().join("config.json");
    let new_toml_config_file = get_share_dir().join("config.toml");

    if !path_exists(&old_json_config_file).await || path_exists(&new_toml_config_file).await {
        return Ok(());
    }

    info!(
        "Migrating legacy config file from {} to {}",
        old_json_config_file.display(),
        new_toml_config_file.display()
    );

    let data = tokio::fs::read_to_string(&old_json_config_file)
        .await
        .map_err(|err| {
            ConfigError::new(format!("Invalid JSON in legacy configuration file: {err}"))
        })?;
    let value: serde_json::Value = serde_json::from_str(&data).map_err(|err| {
        ConfigError::new(format!("Invalid JSON in legacy configuration file: {err}"))
    })?;
    let config: Config = serde_json::from_value(value)
        .map_err(|err| ConfigError::new(format!("Invalid legacy configuration file: {err}")))?;

    save_config(&config, Some(&new_toml_config_file)).await?;
    let backup_path = old_json_config_file.with_file_name("config.json.bak");
    tokio::fs::rename(&old_json_config_file, &backup_path)
        .await
        .map_err(|err| ConfigError::new(format!("Failed to backup legacy config file: {err}")))?;
    info!("Legacy config backed up to {}", backup_path.display());
    Ok(())
}

async fn normalize_path(path: &Path) -> PathBuf {
    let expanded = expand_user(path);
    tokio::fs::canonicalize(&expanded).await.unwrap_or(expanded)
}

fn expand_user(path: &Path) -> PathBuf {
    let Some(home) = dirs::home_dir() else {
        return path.to_path_buf();
    };
    let path_str = path.to_string_lossy();
    if path_str == "~" {
        return home;
    }
    if let Some(stripped) = path_str.strip_prefix("~/") {
        return home.join(stripped);
    }
    path.to_path_buf()
}

async fn path_exists(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

fn default_max_steps_per_turn() -> i64 {
    100
}

fn default_max_retries_per_step() -> i64 {
    3
}

fn default_max_ralph_iterations() -> i64 {
    0
}

fn default_reserved_context_size() -> i64 {
    50_000
}

fn default_mcp_tool_timeout() -> i64 {
    60_000
}
