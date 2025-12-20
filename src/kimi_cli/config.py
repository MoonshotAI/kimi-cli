from __future__ import annotations

import json
from pathlib import Path
from typing import Self

import tomlkit
from pydantic import BaseModel, Field, SecretStr, ValidationError, field_serializer, model_validator
from tomlkit.exceptions import TOMLKitError

from kimi_cli.exception import ConfigError
from kimi_cli.llm import ModelCapability, ProviderType
from kimi_cli.share import get_share_dir
from kimi_cli.utils.logging import logger


class LLMProvider(BaseModel):
    """LLM provider configuration."""

    type: ProviderType
    """Provider type"""
    base_url: str
    """API base URL"""
    api_key: SecretStr
    """API key"""
    env: dict[str, str] | None = None
    """Environment variables to set before creating the provider instance"""
    custom_headers: dict[str, str] | None = None
    """Custom headers to include in API requests"""

    @field_serializer("api_key", when_used="json")
    def dump_secret(self, v: SecretStr):
        return v.get_secret_value()


class LLMModel(BaseModel):
    """LLM model configuration."""

    provider: str
    """Provider name"""
    model: str
    """Model name"""
    max_context_size: int
    """Maximum context size (unit: tokens)"""
    capabilities: set[ModelCapability] | None = None
    """Model capabilities"""


class LoopControl(BaseModel):
    """Agent loop control configuration."""

    max_steps_per_run: int = 100
    """Maximum number of steps in one run"""
    max_retries_per_step: int = 3
    """Maximum number of retries in one step"""


class MoonshotSearchConfig(BaseModel):
    """Moonshot Search configuration."""

    base_url: str
    """Base URL for Moonshot Search service."""
    api_key: SecretStr
    """API key for Moonshot Search service."""
    custom_headers: dict[str, str] | None = None
    """Custom headers to include in API requests."""

    @field_serializer("api_key", when_used="json")
    def dump_secret(self, v: SecretStr):
        return v.get_secret_value()


class MoonshotFetchConfig(BaseModel):
    """Moonshot Fetch configuration."""

    base_url: str
    """Base URL for Moonshot Fetch service."""
    api_key: SecretStr
    """API key for Moonshot Fetch service."""
    custom_headers: dict[str, str] | None = None
    """Custom headers to include in API requests."""

    @field_serializer("api_key", when_used="json")
    def dump_secret(self, v: SecretStr):
        return v.get_secret_value()


class Services(BaseModel):
    """Services configuration."""

    moonshot_search: MoonshotSearchConfig | None = None
    """Moonshot Search configuration."""
    moonshot_fetch: MoonshotFetchConfig | None = None
    """Moonshot Fetch configuration."""


class Config(BaseModel):
    """Main configuration structure."""

    default_model: str = Field(default="", description="Default model to use")
    models: dict[str, LLMModel] = Field(default_factory=dict, description="List of LLM models")
    providers: dict[str, LLMProvider] = Field(
        default_factory=dict, description="List of LLM providers"
    )
    loop_control: LoopControl = Field(default_factory=LoopControl, description="Agent loop control")
    services: Services = Field(default_factory=Services, description="Services configuration")

    @model_validator(mode="after")
    def validate_model(self) -> Self:
        if self.default_model and self.default_model not in self.models:
            raise ValueError(f"Default model {self.default_model} not found in models")
        for model in self.models.values():
            if model.provider not in self.providers:
                raise ValueError(f"Provider {model.provider} not found in providers")
        return self


def get_config_file() -> Path:
    """Get the configuration file path."""
    return get_share_dir() / "config.toml"


def get_default_config() -> Config:
    """Get the default configuration."""
    return Config(
        default_model="",
        models={},
        providers={},
        services=Services(),
    )


def load_config(config_file: Path | None = None) -> Config:
    """
    Load configuration from config file.
    If the config file does not exist, create it with default configuration.

    Args:
        config_file (Path | None): Path to the configuration file. If None, use default path.

    Returns:
        Validated Config object.

    Raises:
        ConfigError: If the configuration file is invalid.
    """
    if config_file is None:
        config_file = get_config_file()
        is_default_config_file = True
    else:
        is_default_config_file = False
    logger.debug("Loading config from file: {file}", file=config_file)

    # If the user hasn't provided an explicit config path, migrate legacy JSON config once.
    if is_default_config_file and not config_file.exists():
        _migrate_json_config_to_toml()

    if not config_file.exists():
        config = get_default_config()
        logger.debug("No config file found, creating default config: {config}", config=config)
        save_config(config, config_file)
        return config

    try:
        config_text = config_file.read_text(encoding="utf-8")
        if config_file.suffix.lower() == ".json":
            data = json.loads(config_text)
        else:
            data = tomlkit.loads(config_text)
        return Config.model_validate(data)
    except json.JSONDecodeError as e:
        raise ConfigError(f"Invalid JSON in configuration file: {e}") from e
    except TOMLKitError as e:
        raise ConfigError(f"Invalid TOML in configuration file: {e}") from e
    except ValidationError as e:
        raise ConfigError(f"Invalid configuration file: {e}") from e


def save_config(config: Config, config_file: Path | None = None):
    """
    Save configuration to config file.

    Args:
        config (Config): Config object to save.
        config_file (Path | None): Path to the configuration file. If None, use default path.
    """
    config_file = config_file or get_config_file()
    logger.debug("Saving config to file: {file}", file=config_file)
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_data = config.model_dump(mode="json", exclude_none=True)
    with open(config_file, "w", encoding="utf-8") as f:
        if config_file.suffix.lower() == ".json":
            f.write(json.dumps(config_data, ensure_ascii=False, indent=2))
        else:
            f.write(tomlkit.dumps(config_data))  # pyright: ignore[reportUnknownMemberType]


def _migrate_json_config_to_toml() -> None:
    old_json_config_file = get_share_dir() / "config.json"
    new_toml_config_file = get_share_dir() / "config.toml"

    if not old_json_config_file.exists():
        return
    if new_toml_config_file.exists():
        return

    logger.info(
        "Migrating legacy config file from {old} to {new}",
        old=old_json_config_file,
        new=new_toml_config_file,
    )

    try:
        with open(old_json_config_file, encoding="utf-8") as f:
            data = json.load(f)
        config = Config.model_validate(data)
    except json.JSONDecodeError as e:
        raise ConfigError(f"Invalid JSON in legacy configuration file: {e}") from e
    except ValidationError as e:
        raise ConfigError(f"Invalid legacy configuration file: {e}") from e

    # Write new TOML config, then keep a backup of the original JSON file.
    save_config(config, new_toml_config_file)
    backup_path = old_json_config_file.with_name("config.json.bak")
    old_json_config_file.replace(backup_path)
    logger.info("Legacy config backed up to {file}", file=backup_path)
