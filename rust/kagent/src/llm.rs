use std::collections::{HashMap, HashSet};
use std::env;
use std::path::PathBuf;

use serde_json::{Map, Value};
use thiserror::Error;

use kosong::chat_provider::{ChatProvider, ChatProviderError, ThinkingEffort};

use crate::config::{LLMModel, LLMProvider, ModelCapability, ProviderType};
use crate::constant::user_agent;

#[derive(Debug, Error)]
pub enum LLMError {
    #[error("chat provider error: {0}")]
    ChatProvider(String),
    #[error("scripted echo error: {0}")]
    ScriptedEcho(String),
    #[error("{0}")]
    EnvVar(String),
}

pub struct LLM {
    pub chat_provider: Box<dyn ChatProvider>,
    pub max_context_size: i64,
    pub capabilities: HashSet<ModelCapability>,
    pub model_config: Option<LLMModel>,
    pub provider_config: Option<LLMProvider>,
}

impl LLM {
    pub fn model_name(&self) -> &str {
        self.chat_provider.model_name()
    }
}

pub fn augment_provider_with_env_vars(
    provider: &mut LLMProvider,
    model: &mut LLMModel,
) -> Result<HashMap<String, String>, LLMError> {
    let mut applied = HashMap::new();

    match provider.provider_type {
        ProviderType::Kimi => {
            if let Ok(base_url) = env::var("KIMI_BASE_URL") {
                if !base_url.is_empty() {
                    provider.base_url = base_url.clone();
                    applied.insert("KIMI_BASE_URL".to_string(), base_url);
                }
            }
            if let Ok(api_key) = env::var("KIMI_API_KEY") {
                if !api_key.is_empty() {
                    provider.api_key = api_key;
                    applied.insert("KIMI_API_KEY".to_string(), "******".to_string());
                }
            }
            if let Ok(model_name) = env::var("KIMI_MODEL_NAME") {
                if !model_name.is_empty() {
                    model.model = model_name.clone();
                    applied.insert("KIMI_MODEL_NAME".to_string(), model_name);
                }
            }
            if let Ok(max_context_size) = env::var("KIMI_MODEL_MAX_CONTEXT_SIZE") {
                if !max_context_size.is_empty() {
                    let value = parse_env_i64(&max_context_size)?;
                    model.max_context_size = value;
                    applied.insert("KIMI_MODEL_MAX_CONTEXT_SIZE".to_string(), max_context_size);
                }
            }
            if let Ok(caps) = env::var("KIMI_MODEL_CAPABILITIES") {
                if !caps.is_empty() {
                    let mut parsed = HashSet::new();
                    for cap in caps.split(',').map(|s| s.trim().to_lowercase()) {
                        match cap.as_str() {
                            "image_in" => {
                                parsed.insert(ModelCapability::ImageIn);
                            }
                            "video_in" => {
                                parsed.insert(ModelCapability::VideoIn);
                            }
                            "thinking" => {
                                parsed.insert(ModelCapability::Thinking);
                            }
                            "always_thinking" => {
                                parsed.insert(ModelCapability::AlwaysThinking);
                            }
                            _ => {}
                        }
                    }
                    model.capabilities = Some(parsed);
                    applied.insert("KIMI_MODEL_CAPABILITIES".to_string(), caps);
                }
            }
        }
        ProviderType::OpenaiLegacy | ProviderType::OpenaiResponses => {
            if let Ok(base_url) = env::var("OPENAI_BASE_URL") {
                if !base_url.is_empty() {
                    provider.base_url = base_url;
                }
            }
            if let Ok(api_key) = env::var("OPENAI_API_KEY") {
                if !api_key.is_empty() {
                    provider.api_key = api_key;
                }
            }
        }
        _ => {}
    }

    Ok(applied)
}

pub async fn create_llm(
    provider: &LLMProvider,
    model: &LLMModel,
    thinking: Option<bool>,
    session_id: Option<&str>,
) -> Result<Option<LLM>, LLMError> {
    if provider.provider_type != ProviderType::Echo
        && provider.provider_type != ProviderType::ScriptedEcho
        && (provider.base_url.is_empty() || model.model.is_empty())
    {
        return Ok(None);
    }

    let chat_provider: Box<dyn ChatProvider> = match provider.provider_type {
        ProviderType::Kimi => {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                reqwest::header::USER_AGENT,
                reqwest::header::HeaderValue::from_str(&user_agent())
                    .map_err(|err| LLMError::ChatProvider(err.to_string()))?,
            );
            if let Some(custom) = &provider.custom_headers {
                for (key, value) in custom {
                    if let (Ok(header_name), Ok(header_value)) = (
                        reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                        reqwest::header::HeaderValue::from_str(value),
                    ) {
                        headers.insert(header_name, header_value);
                    }
                }
            }
            let mut kimi = kosong::chat_provider::kimi::Kimi::new(
                model.model.clone(),
                Some(provider.api_key.clone()),
                Some(provider.base_url.clone()),
                Some(headers),
            )
            .map_err(map_chat_provider_error)?;

            let mut kwargs = Map::new();
            if let Some(session_id) = session_id {
                kwargs.insert(
                    "prompt_cache_key".to_string(),
                    Value::String(session_id.to_string()),
                );
            }
            if let Ok(value) = env::var("KIMI_MODEL_TEMPERATURE") {
                if !value.is_empty() {
                    let parsed = parse_env_f64(&value)?;
                    kwargs.insert("temperature".to_string(), Value::from(parsed));
                }
            }
            if let Ok(value) = env::var("KIMI_MODEL_TOP_P") {
                if !value.is_empty() {
                    let parsed = parse_env_f64(&value)?;
                    kwargs.insert("top_p".to_string(), Value::from(parsed));
                }
            }
            if let Ok(value) = env::var("KIMI_MODEL_MAX_TOKENS") {
                if !value.is_empty() {
                    let parsed = parse_env_i64(&value)?;
                    kwargs.insert("max_tokens".to_string(), Value::from(parsed));
                }
            }
            if !kwargs.is_empty() {
                kimi = kimi.with_generation_kwargs(kwargs);
            }
            Box::new(kimi)
        }
        ProviderType::Echo => Box::new(kosong::chat_provider::echo::echo::EchoChatProvider),
        ProviderType::ScriptedEcho => {
            if let Some(envs) = &provider.env {
                for (key, value) in envs {
                    // SAFETY: matches Python behavior of mutating process env for provider setup.
                    unsafe {
                        env::set_var(key, value);
                    }
                }
            }
            let scripts = load_scripted_echo_scripts().await?;
            let trace = env::var("KIMI_SCRIPTED_ECHO_TRACE")
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            let trace_enabled = matches!(trace.as_str(), "1" | "true" | "yes" | "on");
            Box::new(
                kosong::chat_provider::echo::scripted_echo::ScriptedEchoChatProvider::new(
                    scripts,
                    trace_enabled,
                ),
            )
        }
        _ => {
            return Ok(None);
        }
    };

    let capabilities = derive_model_capabilities(model);

    let chat_provider = apply_thinking(chat_provider, &capabilities, thinking);

    Ok(Some(LLM {
        chat_provider,
        max_context_size: model.max_context_size,
        capabilities,
        model_config: Some(model.clone()),
        provider_config: Some(provider.clone()),
    }))
}

pub fn derive_model_capabilities(model: &LLMModel) -> HashSet<ModelCapability> {
    let mut capabilities = model.capabilities.clone().unwrap_or_default();
    let name = model.model.to_lowercase();
    if name.contains("thinking") || name.contains("reason") {
        capabilities.insert(ModelCapability::Thinking);
        capabilities.insert(ModelCapability::AlwaysThinking);
    } else if model.model == "kimi-for-coding" || model.model == "kimi-code" {
        capabilities.insert(ModelCapability::Thinking);
        capabilities.insert(ModelCapability::ImageIn);
        capabilities.insert(ModelCapability::VideoIn);
    }
    capabilities
}

fn apply_thinking(
    chat_provider: Box<dyn ChatProvider>,
    capabilities: &HashSet<ModelCapability>,
    thinking: Option<bool>,
) -> Box<dyn ChatProvider> {
    if capabilities.contains(&ModelCapability::AlwaysThinking)
        || (thinking == Some(true) && capabilities.contains(&ModelCapability::Thinking))
    {
        chat_provider.with_thinking(ThinkingEffort::High)
    } else if thinking == Some(false) {
        chat_provider.with_thinking(ThinkingEffort::Off)
    } else {
        chat_provider
    }
}

fn parse_env_i64(value: &str) -> Result<i64, LLMError> {
    value.parse::<i64>().map_err(|_| {
        LLMError::EnvVar(format!(
            "invalid literal for int() with base 10: '{}'",
            value
        ))
    })
}

fn parse_env_f64(value: &str) -> Result<f64, LLMError> {
    value
        .parse::<f64>()
        .map_err(|_| LLMError::EnvVar(format!("could not convert string to float: '{}'", value)))
}

async fn load_scripted_echo_scripts() -> Result<Vec<String>, LLMError> {
    let script_path = env::var("KIMI_SCRIPTED_ECHO_SCRIPTS").map_err(|_| {
        LLMError::ScriptedEcho(
            "KIMI_SCRIPTED_ECHO_SCRIPTS is required for _scripted_echo.".to_string(),
        )
    })?;
    let path = PathBuf::from(script_path).expanduser();
    if tokio::fs::metadata(&path).await.is_err() {
        return Err(LLMError::ScriptedEcho(format!(
            "Scripted echo file not found: {}",
            path.display()
        )));
    }
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|err| LLMError::ScriptedEcho(err.to_string()))?;
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if let Value::Array(items) = value {
            if items.iter().all(|item| matches!(item, Value::String(_))) {
                return Ok(items
                    .into_iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect());
            }
        }
        return Err(LLMError::ScriptedEcho(
            "Scripted echo JSON must be an array of strings.".to_string(),
        ));
    }
    let scripts: Vec<String> = text
        .split("\n---\n")
        .map(|chunk| chunk.trim())
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| chunk.to_string())
        .collect();
    if scripts.is_empty() {
        return Err(LLMError::ScriptedEcho(
            "Scripted echo file must be a JSON array of strings or a text file split by '\\n---\\n'."
                .to_string(),
        ));
    }
    Ok(scripts)
}

fn map_chat_provider_error(err: ChatProviderError) -> LLMError {
    LLMError::ChatProvider(err.to_string())
}

trait ExpandUser {
    fn expanduser(&self) -> PathBuf;
}

impl ExpandUser for PathBuf {
    fn expanduser(&self) -> PathBuf {
        let Some(home) = dirs::home_dir() else {
            return self.clone();
        };
        let path_str = self.to_string_lossy();
        if path_str == "~" {
            return home;
        }
        if let Some(stripped) = path_str.strip_prefix("~/") {
            return home.join(stripped);
        }
        self.clone()
    }
}
