from __future__ import annotations

from kosong.chat_provider import APIStatusError

from kimi_cli.llm import KeyPoolKimi
from kimi_cli.llm_key_pool import APIKeyPool


class FakeKimi:
    name = "kimi"
    model = "test-model"
    stream = True

    def __init__(self, api_key: str):
        self._api_key = api_key
        self._base_url = "https://test.example/v1"
        self._client_kwargs = {}
        self.client = FakeClient(api_key)
        self._generation_kwargs = {}

    @property
    def model_name(self):
        return self.model

    @property
    def thinking_effort(self):
        return None

    async def generate(self, *args, **kwargs):
        pass

    def with_thinking(self, *args, **kwargs):
        new = FakeKimi(self._api_key)
        return new

    def with_generation_kwargs(self, *args, **kwargs):
        new = FakeKimi(self._api_key)
        return new

    def with_extra_body(self, *args, **kwargs):
        new = FakeKimi(self._api_key)
        return new

    @property
    def model_parameters(self):
        return {}

    @property
    def files(self):
        return None


class FakeClient:
    def __init__(self, api_key: str):
        self.api_key = api_key

    def close(self):
        pass


def test_key_pool_kimi_rotates_key_on_retryable_error(monkeypatch):
    """KeyPoolKimi should swap to the next key from the pool on retryable_error."""
    import kosong.chat_provider.openai_common as oaic

    def fake_create_openai_client(*, api_key, base_url, client_kwargs):
        return FakeClient(api_key)

    monkeypatch.setattr(oaic, "create_openai_client", fake_create_openai_client)
    monkeypatch.setattr(oaic, "close_replaced_openai_client", lambda *args, **kwargs: None)

    pool = APIKeyPool(["sk-key1", "sk-key2", "sk-key3"])
    # Simulate SubagentBuilder: acquire the first key to create the provider
    first_key = pool.acquire()  # "sk-key1"
    fake = FakeKimi(first_key)
    wrapped = KeyPoolKimi(fake, pool)

    # First rotation should get key2
    assert wrapped.on_retryable_error(RuntimeError("test")) is True
    assert wrapped._provider._api_key == "sk-key2"

    # Second rotation should get key3
    assert wrapped.on_retryable_error(RuntimeError("test")) is True
    assert wrapped._provider._api_key == "sk-key3"

    # Third rotation should wrap back to key1
    assert wrapped.on_retryable_error(RuntimeError("test")) is True
    assert wrapped._provider._api_key == "sk-key1"


def test_key_pool_kimi_preserves_attributes():
    pool = APIKeyPool(["sk-a", "sk-b"])
    fake = FakeKimi("sk-a")
    wrapped = KeyPoolKimi(fake, pool)

    assert wrapped.name == "kimi"
    assert wrapped.model_name == "test-model"
    assert wrapped.model == "test-model"
    assert wrapped.stream is True


def test_key_pool_kimi_with_thinking_returns_wrapped():
    pool = APIKeyPool(["sk-a", "sk-b"])
    fake = FakeKimi("sk-a")
    wrapped = KeyPoolKimi(fake, pool)

    new_wrapped = wrapped.with_thinking("high")
    assert isinstance(new_wrapped, KeyPoolKimi)
    assert new_wrapped._key_pool is pool


class FakeKimiStatusError(FakeKimi):
    def __init__(self, api_key: str, status_code: int):
        super().__init__(api_key)
        self._status_code = status_code

    async def generate(self, *args, **kwargs):
        raise APIStatusError(self._status_code, "test error", request_id="req-1")
