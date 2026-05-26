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
