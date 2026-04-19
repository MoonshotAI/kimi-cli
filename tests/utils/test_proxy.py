from __future__ import annotations

import os

import pytest

from kimi_cli.utils.proxy import normalize_proxy_env


class TestNormalizeProxyEnv:
    def test_socks_to_socks5(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "socks://127.0.0.1:10808/")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks5://127.0.0.1:10808/"

    def test_socks_to_socks5_lowercase(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("all_proxy", "socks://127.0.0.1:10808/")
        normalize_proxy_env()
        assert os.environ["all_proxy"] == "socks5://127.0.0.1:10808/"  # noqa: SIM112

    def test_preserves_socks5(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:10808/")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks5://127.0.0.1:10808/"

    def test_preserves_socks4(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "socks4://127.0.0.1:10808/")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks4://127.0.0.1:10808/"

    def test_preserves_http(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:8080/")
        normalize_proxy_env()
        assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:8080/"

    def test_preserves_https(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HTTPS_PROXY", "https://127.0.0.1:8080/")
        normalize_proxy_env()
        assert os.environ["HTTPS_PROXY"] == "https://127.0.0.1:8080/"

    def test_handles_multiple_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "socks://127.0.0.1:10808/")
        monkeypatch.setenv("HTTPS_PROXY", "socks://127.0.0.1:10809/")
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:8080/")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks5://127.0.0.1:10808/"
        assert os.environ["HTTPS_PROXY"] == "socks5://127.0.0.1:10809/"
        assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:8080/"

    def test_unset_vars_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in (
            "ALL_PROXY",
            "all_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
        ):
            monkeypatch.delenv(var, raising=False)
        # Should not raise
        normalize_proxy_env()

    def test_socks_without_trailing_slash(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "socks://127.0.0.1:10808")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks5://127.0.0.1:10808"

    def test_socks_uppercase_scheme(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "SOCKS://127.0.0.1:10808/")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks5://127.0.0.1:10808/"

    def test_socks_mixed_case_scheme(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ALL_PROXY", "Socks://127.0.0.1:10808/")
        normalize_proxy_env()
        assert os.environ["ALL_PROXY"] == "socks5://127.0.0.1:10808/"
