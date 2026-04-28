"""Verify that on_retryable_error preserves the latest api_key after token refresh.

Bug scenario (now fixed):
1. Kimi() constructed with api_key="token-A" → self._api_key = "token-A"
2. OAuth refresh updates client.api_key = "token-B" (via _apply_access_token)
3. Network error triggers on_retryable_error() → rebuilds client
4. BEFORE FIX: new client used stale "token-A" → 401
5. AFTER FIX: new client uses current "token-B" → works correctly
"""

import httpx
import pytest
import respx

from kosong.chat_provider.kimi import Kimi


def test_on_retryable_error_preserves_refreshed_api_key():
    """on_retryable_error must use the current client.api_key, not stale _api_key."""
    provider = Kimi(model="test-model", api_key="token-A")

    # Simulate OAuth token refresh: _apply_access_token updates client.api_key
    provider.client.api_key = "token-B"

    assert provider.client.api_key == "token-B"

    # Simulate a network error that triggers on_retryable_error
    class FakeConnectionError(Exception):
        pass

    provider.on_retryable_error(FakeConnectionError("connection lost"))

    # FIXED: the rebuilt client must use the latest token-B
    assert provider.client.api_key == "token-B", (
        "on_retryable_error should preserve the refreshed api_key 'token-B'"
    )


def test_api_key_correct_after_construction():
    """Sanity check: client.api_key matches the value passed at construction."""
    provider = Kimi(model="test-model", api_key="initial-token")
    assert provider.client.api_key == "initial-token"


def test_on_retryable_error_idempotent():
    """Multiple on_retryable_error calls should all preserve the current key."""
    provider = Kimi(model="test-model", api_key="token-A")

    provider.client.api_key = "token-B"
    provider.on_retryable_error(Exception("error 1"))
    assert provider.client.api_key == "token-B"

    provider.client.api_key = "token-C"
    provider.on_retryable_error(Exception("error 2"))
    assert provider.client.api_key == "token-C"


@pytest.mark.asyncio
async def test_rebuilt_client_sends_correct_authorization_header():
    """End-to-end: after token refresh + on_retryable_error, the rebuilt client
    must send the refreshed token in the actual HTTP Authorization header.

    This verifies the complete bug chain:
    1. Provider constructed with stale token
    2. Token refreshed externally (simulating _apply_access_token)
    3. on_retryable_error rebuilds the client
    4. The new client's actual HTTP request uses the refreshed token
    """
    captured_headers: dict[str, str] = {}

    def capture_headers(request: httpx.Request) -> httpx.Response:
        captured_headers["Authorization"] = request.headers.get("authorization", "")
        return httpx.Response(
            200,
            json={
                "id": "test",
                "object": "chat.completion",
                "model": "test-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    with respx.mock:
        respx.post("https://api.moonshot.ai/v1/chat/completions").mock(side_effect=capture_headers)

        provider = Kimi(model="test-model", api_key="token-A", stream=False)

        # Step 1: initial request uses token-A
        result = await provider.generate("", [], [])
        async for _ in result:
            pass
        assert captured_headers["Authorization"] == "Bearer token-A"

        # Step 2: simulate OAuth token refresh
        provider.client.api_key = "token-B"

        # Step 3: simulate network error → on_retryable_error rebuilds client
        provider.on_retryable_error(Exception("connection lost"))

        # Step 4: the rebuilt client must send token-B, not token-A
        result = await provider.generate("", [], [])
        async for _ in result:
            pass
        assert captured_headers["Authorization"] == "Bearer token-B", (
            "After token refresh + on_retryable_error, the client must send "
            "the refreshed token-B in the Authorization header, not the stale token-A"
        )
