from __future__ import annotations

import os

import pytest

from kimi_cli.llm_key_pool import APIKeyPool


class TestAPIKeyPoolFromEnv:
    def _clear_all_kimi_keys(self, monkeypatch):
        """Remove all KIMI_API_KEY* env vars to avoid test pollution."""
        for key in list(os.environ):
            if key.startswith("KIMI_API_KEY"):
                monkeypatch.delenv(key, raising=False)

    def test_returns_none_when_no_keys(self, monkeypatch):
        self._clear_all_kimi_keys(monkeypatch)
        assert APIKeyPool.from_env("KIMI_API_KEY") is None

    def test_returns_none_when_only_one_key(self, monkeypatch):
        self._clear_all_kimi_keys(monkeypatch)
        monkeypatch.setenv("KIMI_API_KEY", "sk-single")
        assert APIKeyPool.from_env("KIMI_API_KEY") is None

    def test_collects_primary_and_numbered_keys(self, monkeypatch):
        self._clear_all_kimi_keys(monkeypatch)
        monkeypatch.setenv("KIMI_API_KEY", "sk-primary")
        monkeypatch.setenv("KIMI_API_KEY_1", "sk-one")
        monkeypatch.setenv("KIMI_API_KEY_2", "sk-two")
        pool = APIKeyPool.from_env("KIMI_API_KEY")
        assert pool is not None
        assert pool.key_count == 3
        assert pool.acquire() == "sk-primary"
        assert pool.acquire() == "sk-one"
        assert pool.acquire() == "sk-two"
        # round-robin wraps back to start
        assert pool.acquire() == "sk-primary"

    def test_collects_only_numbered_keys(self, monkeypatch):
        self._clear_all_kimi_keys(monkeypatch)
        monkeypatch.setenv("KIMI_API_KEY_1", "sk-one")
        monkeypatch.setenv("KIMI_API_KEY_2", "sk-two")
        pool = APIKeyPool.from_env("KIMI_API_KEY")
        assert pool is not None
        assert pool.key_count == 2

    def test_ignores_gaps(self, monkeypatch):
        self._clear_all_kimi_keys(monkeypatch)
        monkeypatch.setenv("KIMI_API_KEY", "sk-primary")
        monkeypatch.setenv("KIMI_API_KEY_5", "sk-five")
        pool = APIKeyPool.from_env("KIMI_API_KEY")
        assert pool is not None
        assert pool.key_count == 2
        assert pool.acquire() == "sk-primary"
        assert pool.acquire() == "sk-five"

    def test_custom_prefix(self, monkeypatch):
        self._clear_all_kimi_keys(monkeypatch)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-o1")
        monkeypatch.setenv("OPENAI_API_KEY_1", "sk-o2")
        pool = APIKeyPool.from_env("OPENAI_API_KEY")
        assert pool is not None
        assert pool.key_count == 2


class TestAPIKeyPoolDirect:
    def test_acquire_round_robin(self):
        pool = APIKeyPool(["a", "b", "c"])
        assert pool.acquire() == "a"
        assert pool.acquire() == "b"
        assert pool.acquire() == "c"
        assert pool.acquire() == "a"

    def test_empty_pool_raises(self):
        with pytest.raises(ValueError, match="cannot be empty"):
            APIKeyPool([])

    def test_acquire_skips_key_in_cooldown(self):
        pool = APIKeyPool(["a", "b", "c"])
        pool.record_failure("a")
        # a is in 30s cooldown, should be skipped
        assert pool.acquire() == "b"
        assert pool.acquire() == "c"
        assert pool.acquire() == "b"

    def test_acquire_fallback_when_all_cooldown(self):
        pool = APIKeyPool(["a", "b"])
        pool.record_failure("a")
        pool.record_failure("b")
        # Both in cooldown — fall back to round-robin across the pool
        first = pool.acquire()
        assert first in ("a", "b")
        second = pool.acquire()
        assert second in ("a", "b")
        assert second != first
        third = pool.acquire()
        assert third == first  # cycles back

    def test_record_failure_exponential_cooldown(self, monkeypatch):
        import time

        pool = APIKeyPool(["a", "b"])
        now = 1000.0
        monkeypatch.setattr(time, "time", lambda: now)

        pool.record_failure("a")
        state = pool._states["a"]
        assert state.consecutive_failures == 1
        assert state.cooldown_until == now + 30.0

        now += 35.0  # cooldown expired
        pool.record_failure("a")
        state = pool._states["a"]
        assert state.consecutive_failures == 2
        assert state.cooldown_until == now + 300.0

        now += 310.0  # cooldown expired
        pool.record_failure("a")
        state = pool._states["a"]
        assert state.consecutive_failures == 3
        assert state.cooldown_until == now + 1800.0

    def test_reset_key_clears_cooldown(self):
        pool = APIKeyPool(["a", "b"])
        pool.record_failure("a")
        pool.reset_key("a")
        state = pool._states["a"]
        assert state.consecutive_failures == 0
        assert state.cooldown_until is None
