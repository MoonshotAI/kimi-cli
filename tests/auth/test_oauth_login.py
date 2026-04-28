from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from kimi_cli.auth.oauth import DeviceAuthorization, login_kimi_code
from kimi_cli.config import Config


def _make_device_authorization(*, interval: int = 60) -> DeviceAuthorization:
    return DeviceAuthorization(
        user_code="TEST-CODE",
        device_code="device-code",
        verification_uri="https://example.com/verify",
        verification_uri_complete="https://example.com/verify?user_code=TEST-CODE",
        expires_in=600,
        interval=interval,
    )


@pytest.mark.asyncio
async def test_login_kimi_code_cancel_event_interrupts_wait_loop() -> None:
    config = Config(is_from_default_location=True)
    cancel_event = asyncio.Event()

    with (
        patch(
            "kimi_cli.auth.oauth.get_platform_by_id",
            return_value=SimpleNamespace(id="kimi-code"),
        ),
        patch(
            "kimi_cli.auth.oauth.request_device_authorization",
            AsyncMock(return_value=_make_device_authorization()),
        ),
        patch(
            "kimi_cli.auth.oauth._request_device_token",
            AsyncMock(
                return_value=(
                    400,
                    {
                        "error": "authorization_pending",
                        "error_description": "waiting for approval",
                    },
                )
            ),
        ),
    ):
        flow = login_kimi_code(config, open_browser=False, cancel_event=cancel_event)

        assert (await anext(flow)).type == "info"
        assert (await anext(flow)).type == "verification_url"
        assert (await anext(flow)).type == "waiting"

        cancel_event.set()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(anext(flow), timeout=0.2)
