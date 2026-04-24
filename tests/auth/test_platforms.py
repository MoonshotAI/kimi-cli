"""Tests for managed-platform model listing and syncing."""

from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
from pydantic import SecretStr

from kimi_cli.auth.platforms import (
    ModelInfo,
    _apply_models,
    _list_models,
    refresh_managed_models,
)
from kimi_cli.config import Config, LLMModel, LLMProvider, OAuthRef, Services
from kimi_cli.llm import model_display_name


def _make_config_with_model(
    *,
    display_name: str | None = None,
    api_key: str = "",
) -> Config:
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr(api_key),
        oauth=OAuthRef(storage="file", key="oauth/kimi-code"),
    )
    model = LLMModel(
        provider="managed:kimi-code",
        model="kimi-for-coding",
        max_context_size=100_000,
        display_name=display_name,
    )
    return Config(
        default_model="kimi-code/kimi-for-coding",
        providers={"managed:kimi-code": provider},
        models={"kimi-code/kimi-for-coding": model},
        services=Services(),
    )


# ── ModelInfo / _list_models: display_name parsing ─────────────────


@pytest.mark.asyncio
async def test_list_models_parses_display_name():
    """_list_models should capture display_name from the API response."""
    api_payload = {
        "data": [
            {
                "id": "kimi-for-coding",
                "context_length": 262_144,
                "supports_reasoning": True,
                "supports_image_in": True,
                "supports_video_in": True,
                "display_name": "k2.6-code-preview",
            }
        ]
    }

    mock_response = MagicMock()
    mock_response.json = AsyncMock(return_value=api_payload)

    class FakeCM:
        async def __aenter__(self):
            return mock_response

        async def __aexit__(self, *args):
            pass

    session = MagicMock()
    session.get = MagicMock(return_value=FakeCM())

    models = await _list_models(session, base_url="https://api.test/v1", api_key="k")
    assert len(models) == 1
    assert models[0].display_name == "k2.6-code-preview"


@pytest.mark.asyncio
async def test_list_models_display_name_absent_is_none():
    """Missing display_name should become None on the ModelInfo."""
    api_payload = {
        "data": [
            {
                "id": "kimi-for-coding",
                "context_length": 262_144,
                "supports_reasoning": False,
                "supports_image_in": False,
                "supports_video_in": False,
            }
        ]
    }

    mock_response = MagicMock()
    mock_response.json = AsyncMock(return_value=api_payload)

    class FakeCM:
        async def __aenter__(self):
            return mock_response

        async def __aexit__(self, *args):
            pass

    session = MagicMock()
    session.get = MagicMock(return_value=FakeCM())

    models = await _list_models(session, base_url="https://api.test/v1", api_key="k")
    assert models[0].display_name is None


# ── _apply_models: display_name sync ──────────────────────────────


def test_apply_models_writes_display_name_on_insert():
    """New model entries should carry display_name from the API."""
    config = Config(services=Services())
    models = [
        ModelInfo(
            id="kimi-for-coding",
            context_length=262_144,
            supports_reasoning=True,
            supports_image_in=True,
            supports_video_in=True,
            display_name="k2.6-code-preview",
        )
    ]

    changed = _apply_models(config, "managed:kimi-code", "kimi-code", models)

    assert changed is True
    entry = config.models["kimi-code/kimi-for-coding"]
    assert entry.display_name == "k2.6-code-preview"


def test_apply_models_updates_display_name_on_change():
    """Existing model entries should have display_name updated to the latest API value."""
    config = _make_config_with_model(display_name="old-name")
    models = [
        ModelInfo(
            id="kimi-for-coding",
            context_length=100_000,
            supports_reasoning=False,
            supports_image_in=False,
            supports_video_in=False,
            display_name="k2.6-code-preview",
        )
    ]

    changed = _apply_models(config, "managed:kimi-code", "kimi-code", models)

    assert changed is True
    assert config.models["kimi-code/kimi-for-coding"].display_name == "k2.6-code-preview"


def test_apply_models_clears_display_name_when_api_drops_it():
    """If API stops returning display_name, local entry should be cleared."""
    config = _make_config_with_model(display_name="old-name")
    models = [
        ModelInfo(
            id="kimi-for-coding",
            context_length=100_000,
            supports_reasoning=False,
            supports_image_in=False,
            supports_video_in=False,
            display_name=None,
        )
    ]

    changed = _apply_models(config, "managed:kimi-code", "kimi-code", models)

    assert changed is True
    assert config.models["kimi-code/kimi-for-coding"].display_name is None


# ── model_display_name: prefers LLMModel.display_name ────────────


def test_model_display_name_prefers_config_display_name():
    """When LLMModel has a display_name, use it instead of hard-coded mapping."""
    model = LLMModel(
        provider="managed:kimi-code",
        model="kimi-for-coding",
        max_context_size=100_000,
        display_name="k2.6-code-preview",
    )
    assert model_display_name("kimi-for-coding", model) == "k2.6-code-preview"


def test_model_display_name_falls_back_to_hardcoded_when_missing():
    """Without display_name, fall back to the legacy hard-coded mapping."""
    model = LLMModel(
        provider="managed:kimi-code",
        model="kimi-for-coding",
        max_context_size=100_000,
    )
    assert model_display_name("kimi-for-coding", model) == "kimi-for-coding"


def test_model_display_name_no_model_uses_raw_name():
    """When no LLMModel is provided, use the raw model name."""
    assert model_display_name("kimi-k2-turbo-preview") == "kimi-k2-turbo-preview"


def test_model_display_name_empty_returns_empty():
    assert model_display_name(None) == ""
    assert model_display_name("") == ""


@pytest.mark.asyncio
async def test_refresh_managed_models_retries_after_oauth_401():
    config = _make_config_with_model()
    config.is_from_default_location = True

    models = [
        ModelInfo(
            id="kimi-for-coding",
            context_length=100_000,
            supports_reasoning=False,
            supports_image_in=False,
            supports_video_in=False,
            display_name=None,
        )
    ]
    unauthorized = aiohttp.ClientResponseError(
        request_info=MagicMock(real_url="https://api.test/v1/models"),
        history=(),
        status=401,
        message="Unauthorized",
    )

    with (
        patch(
            "kimi_cli.auth.platforms.list_models",
            AsyncMock(side_effect=[unauthorized, models]),
        ) as list_models_mock,
        patch(
            "kimi_cli.auth.oauth.OAuthManager.ensure_fresh",
            new=AsyncMock(),
        ) as ensure_fresh_mock,
        patch(
            "kimi_cli.auth.oauth.OAuthManager.resolve_api_key",
            side_effect=["stale-access-token", "fresh-access-token"],
        ),
    ):
        changed = await refresh_managed_models(config)

    assert changed is False
    assert list_models_mock.await_count == 2
    assert len(ensure_fresh_mock.await_args_list) == 2
    assert ensure_fresh_mock.await_args_list[0].kwargs == {}
    assert ensure_fresh_mock.await_args_list[1].kwargs == {"force": True}


@pytest.mark.asyncio
async def test_refresh_managed_models_401_falls_back_to_static_api_key_when_refresh_fails():
    config = _make_config_with_model(api_key="static-api-key")
    config.is_from_default_location = True

    models = [
        ModelInfo(
            id="kimi-for-coding",
            context_length=100_000,
            supports_reasoning=False,
            supports_image_in=False,
            supports_video_in=False,
            display_name=None,
        )
    ]
    unauthorized = aiohttp.ClientResponseError(
        request_info=MagicMock(real_url="https://api.test/v1/models"),
        history=(),
        status=401,
        message="Unauthorized",
    )

    with (
        patch(
            "kimi_cli.auth.platforms.list_models",
            AsyncMock(side_effect=[unauthorized, models]),
        ) as list_models_mock,
        patch(
            "kimi_cli.auth.oauth.OAuthManager.ensure_fresh",
            new=AsyncMock(side_effect=[None, RuntimeError("refresh failed")]),
        ) as ensure_fresh_mock,
        patch(
            "kimi_cli.auth.oauth.OAuthManager.resolve_api_key",
            side_effect=["oauth-access-token", "oauth-access-token"],
        ),
    ):
        changed = await refresh_managed_models(config)

    assert changed is False
    assert list_models_mock.await_count == 2
    assert list_models_mock.await_args_list[0].args[1] == "oauth-access-token"
    assert list_models_mock.await_args_list[1].args[1] == "static-api-key"
    assert len(ensure_fresh_mock.await_args_list) == 2
    assert ensure_fresh_mock.await_args_list[0].kwargs == {}
    assert ensure_fresh_mock.await_args_list[1].kwargs == {"force": True}


@pytest.mark.asyncio
async def test_refresh_managed_models_401_tries_static_api_key_after_refreshed_oauth_still_fails():
    config = _make_config_with_model(api_key="static-api-key")
    config.is_from_default_location = True

    models = [
        ModelInfo(
            id="kimi-for-coding",
            context_length=100_000,
            supports_reasoning=False,
            supports_image_in=False,
            supports_video_in=False,
            display_name=None,
        )
    ]
    unauthorized = aiohttp.ClientResponseError(
        request_info=MagicMock(real_url="https://api.test/v1/models"),
        history=(),
        status=401,
        message="Unauthorized",
    )

    with (
        patch(
            "kimi_cli.auth.platforms.list_models",
            AsyncMock(side_effect=[unauthorized, unauthorized, models]),
        ) as list_models_mock,
        patch(
            "kimi_cli.auth.oauth.OAuthManager.ensure_fresh",
            new=AsyncMock(side_effect=[None, None]),
        ) as ensure_fresh_mock,
        patch(
            "kimi_cli.auth.oauth.OAuthManager.resolve_api_key",
            side_effect=["stale-oauth-token", "fresh-oauth-token"],
        ),
    ):
        changed = await refresh_managed_models(config)

    assert changed is False
    assert list_models_mock.await_count == 3
    assert list_models_mock.await_args_list[0].args[1] == "stale-oauth-token"
    assert list_models_mock.await_args_list[1].args[1] == "fresh-oauth-token"
    assert list_models_mock.await_args_list[2].args[1] == "static-api-key"
    assert len(ensure_fresh_mock.await_args_list) == 2
    assert ensure_fresh_mock.await_args_list[0].kwargs == {}
    assert ensure_fresh_mock.await_args_list[1].kwargs == {"force": True}
