from __future__ import annotations

from pathlib import Path

from pydantic import SecretStr

from kimi_cli.config import Config, LLMProvider, MoonshotSearchConfig, OAuthRef, Services
from kimi_cli.feedback.redact import (
    anonymize_path,
    redact_config,
    redact_git_url,
    redact_log_content,
)


class TestRedactLogContent:
    def test_redacts_sk_api_key(self):
        text = "Error: invalid key sk-abcdefghij1234567890"
        result = redact_log_content(text)
        assert "sk-abcdefghij1234567890" not in result
        assert "sk-***" in result

    def test_redacts_bearer_token(self):
        text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.token"
        result = redact_log_content(text)
        assert "eyJhbGciOiJIUzI1NiJ9" not in result
        assert "Bearer ***" in result

    def test_redacts_api_key_assignment(self):
        text = 'api_key="sk-abcdefghij1234567890"'
        result = redact_log_content(text)
        assert "sk-abcdefghij1234567890" not in result
        assert "api_key=" in result

    def test_redacts_api_key_equals(self):
        text = "api_key=mySecretKey123456"
        result = redact_log_content(text)
        assert "mySecretKey123456" not in result

    def test_preserves_normal_text(self):
        text = "INFO | 2024-01-01 | Normal log message without secrets"
        result = redact_log_content(text)
        assert result == text

    def test_redacts_multiple_patterns(self):
        text = "key=sk-abcdefghij1234567890 auth=Bearer mytoken123 api_key=secret123"
        result = redact_log_content(text)
        assert "sk-abcdefghij1234567890" not in result
        assert "mytoken123" not in result
        assert "secret123" not in result


class TestRedactConfig:
    def _make_config(self, **kwargs) -> Config:
        providers = kwargs.get(
            "providers",
            {
                "openai": LLMProvider(
                    type="openai_responses",
                    base_url="https://api.openai.com/v1",
                    api_key=SecretStr("sk-real-secret-key-12345"),
                ),
            },
        )
        return Config(providers=providers, **{k: v for k, v in kwargs.items() if k != "providers"})

    def test_redacts_provider_api_key(self):
        config = self._make_config()
        result = redact_config(config)
        assert result["providers"]["openai"]["api_key"] == "***"

    def test_redacts_provider_oauth_key(self):
        config = self._make_config(
            providers={
                "test": LLMProvider(
                    type="openai_responses",
                    base_url="https://api.example.com",
                    api_key=SecretStr("key"),
                    oauth=OAuthRef(key="my-oauth-key"),
                ),
            }
        )
        result = redact_config(config)
        assert result["providers"]["test"]["oauth"]["key"] == "***"

    def test_redacts_provider_custom_headers(self):
        config = self._make_config(
            providers={
                "test": LLMProvider(
                    type="openai_responses",
                    base_url="https://api.example.com",
                    api_key=SecretStr("key"),
                    custom_headers={"Authorization": "Bearer secret"},
                ),
            }
        )
        result = redact_config(config)
        assert result["providers"]["test"]["custom_headers"] == "***"

    def test_redacts_provider_env(self):
        config = self._make_config(
            providers={
                "test": LLMProvider(
                    type="openai_responses",
                    base_url="https://api.example.com",
                    api_key=SecretStr("key"),
                    env={"SECRET_KEY": "value"},
                ),
            }
        )
        result = redact_config(config)
        assert result["providers"]["test"]["env"] == "***"

    def test_redacts_service_api_key(self):
        config = self._make_config(
            services=Services(
                moonshot_search=MoonshotSearchConfig(
                    base_url="https://search.example.com",
                    api_key=SecretStr("search-secret-key"),
                ),
            )
        )
        result = redact_config(config)
        assert result["services"]["moonshot_search"]["api_key"] == "***"


class TestRedactGitUrl:
    def test_redacts_https_token(self):
        url = "https://mytoken@github.com/org/repo.git"
        result = redact_git_url(url)
        assert "mytoken" not in result
        assert result == "https://***@github.com/org/repo.git"

    def test_redacts_https_user_pass(self):
        url = "https://user:password@github.com/org/repo.git"
        result = redact_git_url(url)
        assert "user:password" not in result
        assert "***@github.com" in result

    def test_preserves_plain_https(self):
        url = "https://github.com/org/repo.git"
        result = redact_git_url(url)
        assert result == url

    def test_preserves_ssh_url(self):
        url = "git@github.com:org/repo.git"
        result = redact_git_url(url)
        assert result == url


class TestAnonymizePath:
    def test_replaces_home_dir(self):
        home = str(Path.home())
        path = f"{home}/projects/my-app"
        result = anonymize_path(path)
        assert result == "~/projects/my-app"

    def test_preserves_non_home_path(self):
        result = anonymize_path("/opt/bin/tool")
        assert result == "/opt/bin/tool"

    def test_handles_home_dir_only(self):
        home = str(Path.home())
        result = anonymize_path(home)
        assert result == "~"
