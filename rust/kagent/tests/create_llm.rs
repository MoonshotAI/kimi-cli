use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::json;

use kagent::config::{LLMModel, LLMProvider, ModelCapability, ProviderType};
use kagent::llm::{augment_provider_with_env_vars, create_llm};
use kosong::chat_provider::echo::echo::EchoChatProvider;
use kosong::chat_provider::kimi::Kimi;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    key: &'static str,
    prev: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let prev = std::env::var(key).ok();
        // SAFETY: tests serialize env access via ENV_LOCK to avoid races.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(prev) = &self.prev {
            // SAFETY: tests serialize env access via ENV_LOCK to avoid races.
            unsafe {
                std::env::set_var(self.key, prev);
            }
        } else {
            // SAFETY: tests serialize env access via ENV_LOCK to avoid races.
            unsafe {
                std::env::remove_var(self.key);
            }
        }
    }
}

#[test]
fn test_augment_provider_with_env_vars_kimi() {
    let _lock = ENV_LOCK.lock().unwrap();
    let _guards = vec![
        EnvGuard::set("KIMI_BASE_URL", "https://env.test/v1"),
        EnvGuard::set("KIMI_API_KEY", "env-key"),
        EnvGuard::set("KIMI_MODEL_NAME", "kimi-env-model"),
        EnvGuard::set("KIMI_MODEL_MAX_CONTEXT_SIZE", "8192"),
        EnvGuard::set("KIMI_MODEL_CAPABILITIES", "Image_In,THINKING,unknown"),
    ];

    let mut provider = LLMProvider {
        provider_type: ProviderType::Kimi,
        base_url: "https://original.test/v1".to_string(),
        api_key: "orig-key".to_string(),
        env: None,
        custom_headers: None,
    };
    let mut model = LLMModel {
        provider: "kimi".to_string(),
        model: "kimi-base".to_string(),
        max_context_size: 4096,
        capabilities: None,
    };

    augment_provider_with_env_vars(&mut provider, &mut model).expect("env overrides");

    assert_eq!(
        provider,
        LLMProvider {
            provider_type: ProviderType::Kimi,
            base_url: "https://env.test/v1".to_string(),
            api_key: "env-key".to_string(),
            env: None,
            custom_headers: None,
        }
    );
    assert_eq!(
        model,
        LLMModel {
            provider: "kimi".to_string(),
            model: "kimi-env-model".to_string(),
            max_context_size: 8192,
            capabilities: Some(HashSet::from([
                ModelCapability::ImageIn,
                ModelCapability::Thinking,
            ])),
        }
    );
}

#[test]
fn test_augment_provider_with_env_vars_invalid_max_context_size() {
    let _lock = ENV_LOCK.lock().unwrap();
    let _guard = EnvGuard::set("KIMI_MODEL_MAX_CONTEXT_SIZE", "not-a-number");

    let mut provider = LLMProvider {
        provider_type: ProviderType::Kimi,
        base_url: "https://original.test/v1".to_string(),
        api_key: "orig-key".to_string(),
        env: None,
        custom_headers: None,
    };
    let mut model = LLMModel {
        provider: "kimi".to_string(),
        model: "kimi-base".to_string(),
        max_context_size: 4096,
        capabilities: None,
    };

    let err = augment_provider_with_env_vars(&mut provider, &mut model)
        .expect_err("invalid max context size");
    assert!(
        err.to_string()
            .contains("invalid literal for int() with base 10")
    );
}

#[tokio::test]
async fn test_create_llm_kimi_model_parameters() {
    let _lock = ENV_LOCK.lock().unwrap();
    let _guards = vec![
        EnvGuard::set("KIMI_MODEL_TEMPERATURE", "0.2"),
        EnvGuard::set("KIMI_MODEL_TOP_P", "0.8"),
        EnvGuard::set("KIMI_MODEL_MAX_TOKENS", "1234"),
    ];

    let provider = LLMProvider {
        provider_type: ProviderType::Kimi,
        base_url: "https://api.test/v1".to_string(),
        api_key: "test-key".to_string(),
        env: None,
        custom_headers: None,
    };
    let model = LLMModel {
        provider: "kimi".to_string(),
        model: "kimi-base".to_string(),
        max_context_size: 4096,
        capabilities: None,
    };

    let llm = create_llm(&provider, &model, None, None)
        .await
        .expect("create llm")
        .expect("llm");

    let kimi = llm
        .chat_provider
        .as_any()
        .downcast_ref::<Kimi>()
        .expect("kimi provider");

    assert_eq!(
        serde_json::Value::Object(kimi.model_parameters()),
        json!({
            "base_url": "https://api.test/v1/",
            "temperature": 0.2,
            "top_p": 0.8,
            "max_tokens": 1234
        })
    );
}

#[tokio::test]
async fn test_create_llm_invalid_temperature_env() {
    let _lock = ENV_LOCK.lock().unwrap();
    let _guard = EnvGuard::set("KIMI_MODEL_TEMPERATURE", "not-a-number");

    let provider = LLMProvider {
        provider_type: ProviderType::Kimi,
        base_url: "https://api.test/v1".to_string(),
        api_key: "test-key".to_string(),
        env: None,
        custom_headers: None,
    };
    let model = LLMModel {
        provider: "kimi".to_string(),
        model: "kimi-base".to_string(),
        max_context_size: 4096,
        capabilities: None,
    };

    let err = match create_llm(&provider, &model, None, None).await {
        Ok(_) => panic!("expected temperature parsing error"),
        Err(err) => err,
    };
    assert!(
        err.to_string()
            .contains("could not convert string to float")
    );
}

#[tokio::test]
async fn test_create_llm_echo_provider() {
    let provider = LLMProvider {
        provider_type: ProviderType::Echo,
        base_url: "".to_string(),
        api_key: "".to_string(),
        env: None,
        custom_headers: None,
    };
    let model = LLMModel {
        provider: "_echo".to_string(),
        model: "echo".to_string(),
        max_context_size: 1234,
        capabilities: None,
    };

    let llm = create_llm(&provider, &model, None, None)
        .await
        .expect("create llm")
        .expect("llm");

    assert!(llm.chat_provider.as_any().is::<EchoChatProvider>());
    assert_eq!(llm.max_context_size, 1234);
}

#[tokio::test]
async fn test_create_llm_requires_base_url_for_kimi() {
    let provider = LLMProvider {
        provider_type: ProviderType::Kimi,
        base_url: "".to_string(),
        api_key: "test-key".to_string(),
        env: None,
        custom_headers: None,
    };
    let model = LLMModel {
        provider: "kimi".to_string(),
        model: "kimi-base".to_string(),
        max_context_size: 4096,
        capabilities: None,
    };

    let llm = create_llm(&provider, &model, None, None)
        .await
        .expect("create llm");
    assert!(llm.is_none());
}
