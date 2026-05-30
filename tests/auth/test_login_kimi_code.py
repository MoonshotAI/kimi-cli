"""Tests for the login_kimi_code flow ordering.

Regression guard for: token was previously persisted to disk before list_models
was called, leaving credentials valid but `default_model` unset when list_models
failed (banner stuck on "Model: not set").
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import SecretStr

from kimi_cli.auth.oauth import DeviceAuthorization, login_kimi_code
from kimi_cli.config import Config, Services


def _empty_config() -> Config:
    cfg = Config(
        default_model="",
        providers={},
        models={},
        services=Services(),
    )
    cfg.is_from_default_location = True
    return cfg


def _device_auth() -> DeviceAuthorization:
    return DeviceAuthorization(
        user_code="ABCD-1234",
        device_code="dev-code",
        verification_uri="https://kimi.test/verify",
        verification_uri_complete="https://kimi.test/verify?user_code=ABCD-1234",
        expires_in=600,
        interval=1,
    )


def _token_payload() -> dict[str, object]:
    return {
        "access_token": "acc",
        "refresh_token": "ref",
        "expires_in": 900,
        "scope": "kimi-code",
        "token_type": "Bearer",
    }


@pytest.mark.asyncio
async def test_list_models_failure_does_not_persist_token():
    """If list_models raises, save_tokens MUST NOT be called.

    Otherwise we leave a valid token on disk while config.default_model stays
    empty → banner permanently shows "Model: not set, send /login to login".
    """
    config = _empty_config()
    save_tokens_mock = MagicMock()
    save_config_mock = MagicMock()
    delete_tokens_mock = MagicMock()
    apply_config_mock = MagicMock()
    platform = MagicMock(id="kimi-code", base_url="https://api.test")

    with (
        patch("kimi_cli.auth.oauth.request_device_authorization", AsyncMock(return_value=_device_auth())),
        patch("kimi_cli.auth.oauth._request_device_token", AsyncMock(return_value=(200, _token_payload()))),
        patch("kimi_cli.auth.oauth.get_platform_by_id", return_value=platform),
        patch("kimi_cli.auth.oauth.list_models", AsyncMock(side_effect=RuntimeError("boom"))),
        patch("kimi_cli.auth.oauth.save_tokens", save_tokens_mock),
        patch("kimi_cli.auth.oauth.save_config", save_config_mock),
        patch("kimi_cli.auth.oauth.delete_tokens", delete_tokens_mock),
        patch("kimi_cli.auth.oauth._apply_kimi_code_config", apply_config_mock),
        patch("kimi_cli.auth.oauth.webbrowser.open", MagicMock()),
    ):
        events = [e async for e in login_kimi_code(config, open_browser=False)]

    error_events = [e for e in events if e.type == "error"]
    assert error_events, f"expected error event, got: {[e.type for e in events]}"
    assert "boom" in error_events[-1].message or "models" in error_events[-1].message.lower()
    save_tokens_mock.assert_not_called()
    save_config_mock.assert_not_called()
    apply_config_mock.assert_not_called()
    assert config.default_model == ""


@pytest.mark.asyncio
async def test_empty_model_list_does_not_persist_token():
    """An empty model list must emit an error event AND not persist the token."""
    config = _empty_config()
    save_tokens_mock = MagicMock()
    save_config_mock = MagicMock()
    platform = MagicMock(id="kimi-code", base_url="https://api.test")

    with (
        patch("kimi_cli.auth.oauth.request_device_authorization", AsyncMock(return_value=_device_auth())),
        patch("kimi_cli.auth.oauth._request_device_token", AsyncMock(return_value=(200, _token_payload()))),
        patch("kimi_cli.auth.oauth.get_platform_by_id", return_value=platform),
        patch("kimi_cli.auth.oauth.list_models", AsyncMock(return_value=[])),
        patch("kimi_cli.auth.oauth.save_tokens", save_tokens_mock),
        patch("kimi_cli.auth.oauth.save_config", save_config_mock),
        patch("kimi_cli.auth.oauth.webbrowser.open", MagicMock()),
    ):
        events = [e async for e in login_kimi_code(config, open_browser=False)]

    assert any(e.type == "error" for e in events)
    save_tokens_mock.assert_not_called()
    save_config_mock.assert_not_called()


@pytest.mark.asyncio
async def test_save_config_failure_rolls_back_credentials():
    """If save_config raises after save_tokens succeeded, the credentials must
    be deleted to avoid the zombie state (token on disk, no default_model)."""
    config = _empty_config()
    save_tokens_mock = MagicMock(side_effect=lambda ref, _token: ref)
    save_config_mock = MagicMock(side_effect=OSError("disk full"))
    delete_tokens_mock = MagicMock()
    platform = MagicMock(id="kimi-code", base_url="https://api.test")
    model_info = MagicMock(
        id="kimi-k2",
        context_length=200_000,
        capabilities=set(),
        display_name="Kimi K2",
    )

    with (
        patch("kimi_cli.auth.oauth.request_device_authorization", AsyncMock(return_value=_device_auth())),
        patch("kimi_cli.auth.oauth._request_device_token", AsyncMock(return_value=(200, _token_payload()))),
        patch("kimi_cli.auth.oauth.get_platform_by_id", return_value=platform),
        patch("kimi_cli.auth.oauth.list_models", AsyncMock(return_value=[model_info])),
        patch("kimi_cli.auth.oauth.save_tokens", save_tokens_mock),
        patch("kimi_cli.auth.oauth.save_config", save_config_mock),
        patch("kimi_cli.auth.oauth.delete_tokens", delete_tokens_mock),
        patch("kimi_cli.auth.oauth._apply_kimi_code_config", MagicMock()),
        patch("kimi_cli.auth.oauth.webbrowser.open", MagicMock()),
    ):
        events = [e async for e in login_kimi_code(config, open_browser=False)]

    save_tokens_mock.assert_called_once()
    delete_tokens_mock.assert_called_once()  # rollback
    assert any(e.type == "error" for e in events)
    assert not any(e.type == "success" for e in events)


@pytest.mark.asyncio
async def test_happy_path_persists_token_and_config():
    config = _empty_config()
    save_tokens_mock = MagicMock(side_effect=lambda ref, _token: ref)
    save_config_mock = MagicMock()
    apply_config_mock = MagicMock(
        side_effect=lambda config, **_kw: setattr(config, "default_model", "managed:kimi-code/kimi-k2")
    )
    platform = MagicMock(id="kimi-code", base_url="https://api.test")
    model_info = MagicMock(
        id="kimi-k2",
        context_length=200_000,
        capabilities=set(),
        display_name="Kimi K2",
    )

    with (
        patch("kimi_cli.auth.oauth.request_device_authorization", AsyncMock(return_value=_device_auth())),
        patch("kimi_cli.auth.oauth._request_device_token", AsyncMock(return_value=(200, _token_payload()))),
        patch("kimi_cli.auth.oauth.get_platform_by_id", return_value=platform),
        patch("kimi_cli.auth.oauth.list_models", AsyncMock(return_value=[model_info])),
        patch("kimi_cli.auth.oauth.save_tokens", save_tokens_mock),
        patch("kimi_cli.auth.oauth.save_config", save_config_mock),
        patch("kimi_cli.auth.oauth._apply_kimi_code_config", apply_config_mock),
        patch("kimi_cli.auth.oauth.webbrowser.open", MagicMock()),
    ):
        events = [e async for e in login_kimi_code(config, open_browser=False)]

    save_tokens_mock.assert_called_once()
    apply_config_mock.assert_called_once()
    save_config_mock.assert_called_once()
    assert any(e.type == "success" for e in events)
    assert config.default_model == "managed:kimi-code/kimi-k2"
