"""Tests for Kimi default and user-supplied timeout configuration."""

import httpx

from kosong.chat_provider.kimi import Kimi

# The default read timeout is 1800s (30 min) for long-thinking LLM responses.
_EXPECTED_DEFAULT_READ_TIMEOUT = 1800.0


class TestKimiTimeout:
    def test_default_timeout_uses_constant(self):
        """Kimi() without explicit timeout should use 1800s read timeout."""
        kimi = Kimi(model="test-model", api_key="sk-test")
        timeout = kimi.client.timeout
        assert isinstance(timeout, httpx.Timeout)
        assert timeout.read == _EXPECTED_DEFAULT_READ_TIMEOUT
        assert timeout.connect == 5.0

    def test_user_supplied_timeout_not_overridden(self):
        """Kimi() with explicit timeout should preserve the user's value."""
        custom = httpx.Timeout(10.0)
        kimi = Kimi(model="test-model", api_key="sk-test", timeout=custom)
        timeout = kimi.client.timeout
        assert isinstance(timeout, httpx.Timeout)
        assert timeout.read == 10.0
        assert timeout.connect == 10.0

    def test_timeout_preserved_after_retryable_error(self):
        """on_retryable_error() rebuilds the client but preserves the timeout."""
        kimi = Kimi(model="test-model", api_key="sk-test")
        timeout = kimi.client.timeout
        assert isinstance(timeout, httpx.Timeout)
        assert timeout.read == _EXPECTED_DEFAULT_READ_TIMEOUT

        kimi.on_retryable_error(RuntimeError("boom"))

        # The new client should have the same timeout as the original
        new_timeout = kimi.client.timeout
        assert isinstance(new_timeout, httpx.Timeout)
        assert new_timeout.read == _EXPECTED_DEFAULT_READ_TIMEOUT
        assert new_timeout.connect == 5.0
