"""Config API routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from loguru import logger
from pydantic import BaseModel, Field

from kimi_cli.config import LLMModel, get_config_file, load_config, save_config
from kimi_cli.llm import ProviderType, derive_model_capabilities

router = APIRouter(prefix="/api/config", tags=["config"])


class ConfigModel(LLMModel):
    """Model configuration for frontend."""

    name: str = Field(description="Model key in kimi-cli config (Config.models)")
    provider_type: ProviderType = Field(description="Provider type (LLMProvider.type)")


class GlobalConfig(BaseModel):
    """Global configuration snapshot for frontend."""

    default_model: str = Field(description="Current default model key")
    default_thinking: bool = Field(description="Current default thinking mode")
    models: list[ConfigModel] = Field(description="All configured models")


class UpdateGlobalConfigRequest(BaseModel):
    """Request to update global config."""

    default_model: str | None = Field(default=None, description="New default model key")
    default_thinking: bool | None = Field(default=None, description="New default thinking mode")
    restart_running_sessions: bool | None = Field(
        default=None, description="Whether to restart running sessions"
    )
    force_restart_busy_sessions: bool | None = Field(
        default=None, description="Whether to force restart busy sessions"
    )


class UpdateGlobalConfigResponse(BaseModel):
    """Response after updating global config."""

    config: GlobalConfig = Field(description="Updated config snapshot")
    restarted_session_ids: list[str] | None = Field(
        default=None, description="IDs of restarted sessions"
    )
    skipped_busy_session_ids: list[str] | None = Field(
        default=None, description="IDs of busy sessions that were skipped"
    )


class ConfigToml(BaseModel):
    """Raw config.toml content."""

    content: str = Field(description="Raw TOML content")
    path: str = Field(description="Path to config file")


class UpdateConfigTomlRequest(BaseModel):
    """Request to update config.toml."""

    content: str = Field(description="New TOML content")


class UpdateConfigTomlResponse(BaseModel):
    """Response after updating config.toml."""

    success: bool = Field(description="Whether the update was successful")
    error: str | None = Field(default=None, description="Error message if failed")


def _build_global_config() -> GlobalConfig:
    """Build GlobalConfig from kimi-cli config."""
    config = load_config()

    models: list[ConfigModel] = []
    for model_name, model in config.models.items():
        provider = config.providers.get(model.provider)
        if provider is None:
            continue

        # Derive capabilities
        derived_caps = derive_model_capabilities(model)
        capabilities = derived_caps or None

        models.append(
            ConfigModel(
                name=model_name,
                model=model.model,
                provider=model.provider,
                provider_type=provider.type,
                max_context_size=model.max_context_size,
                capabilities=capabilities,
            )
        )

    return GlobalConfig(
        default_model=config.default_model,
        default_thinking=config.default_thinking,
        models=models,
    )


@router.get("/", summary="Get global (kimi-cli) config snapshot")
async def get_global_config() -> GlobalConfig:
    """Get global (kimi-cli) config snapshot."""
    return _build_global_config()


@router.patch("/", summary="Update global (kimi-cli) default model/thinking")
async def update_global_config(request: UpdateGlobalConfigRequest) -> UpdateGlobalConfigResponse:
    """Update global (kimi-cli) default model/thinking."""
    config = load_config()

    # Validate and update default_model
    if request.default_model is not None:
        if request.default_model not in config.models:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Model '{request.default_model}' not found in config",
            )
        config.default_model = request.default_model

    # Update default_thinking
    if request.default_thinking is not None:
        config.default_thinking = request.default_thinking

    # Save config
    save_config(config)

    # Note: Session restart is not implemented in the open-source version
    # as it requires coordination with the runner
    return UpdateGlobalConfigResponse(
        config=_build_global_config(),
        restarted_session_ids=None,
        skipped_busy_session_ids=None,
    )


@router.get("/toml", summary="Get kimi-cli config.toml", deprecated=True)
async def get_config_toml() -> ConfigToml:
    """Get kimi-cli config.toml.
    
    DEPRECATED: This endpoint exposes sensitive configuration data including API keys.
    Use GET /api/config/ instead for safe access to configuration settings.
    This endpoint will be removed in a future version.
    """
    # Endpoint disabled for security - config.toml contains API keys and credentials
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Access to raw config.toml is disabled for security reasons. "
               "API keys and credentials should not be exposed through web APIs. "
               "Use GET /api/config/ to access specific configuration settings safely.",
    )


@router.put("/toml", summary="Update kimi-cli config.toml", deprecated=True)
async def update_config_toml(request: UpdateConfigTomlRequest) -> UpdateConfigTomlResponse:
    """Update kimi-cli config.toml.
    
    DEPRECATED: This endpoint allows modification of sensitive configuration including API keys.
    Use PATCH /api/config/ instead for safe updates to configuration settings.
    This endpoint will be removed in a future version.
    """
    # Endpoint disabled for security - config.toml contains API keys and credentials
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Direct modification of config.toml is disabled for security reasons. "
               "Use PATCH /api/config/ to update specific configuration settings safely.",
    )
