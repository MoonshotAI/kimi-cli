"""Tests for src/kimi_cli.constant.py."""

from __future__ import annotations

import pytest

from kimi_cli.constant import _normalize_remote, get_build_sha


class TestNormalizeRemote:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("git@github.com:user/repo.git", "github.com/user/repo"),
            ("https://github.com/user/repo.git", "github.com/user/repo"),
            ("https://github.com/user/repo", "github.com/user/repo"),
            ("http://github.com/user/repo.git", "github.com/user/repo"),
            ("https://user:token@github.com/org/repo.git", "github.com/org/repo"),
            ("http://user@github.com/org/repo.git", "github.com/org/repo"),
            ("https://user:pass:word@github.com/repo.git", "github.com/repo"),
            ("git@host.com:path/to/repo.git", "host.com/path/to/repo"),
            ("git@host.com:path/to/repo", "host.com/path/to/repo"),
            ("https://github.com/org/team/repo.git", "github.com/org/team/repo"),
            ("github.com/user/repo", "github.com/user/repo"),
            ("user@host.com:path/repo.git", "host.com/path/repo"),
            ("", ""),
            ("   ", ""),
            ("https://host.com:8443/path/repo.git", "host.com/8443/path/repo"),
        ],
    )
    def test_normalize(self, url: str, expected: str) -> None:
        assert _normalize_remote(url) == expected


class TestGetBuildSha:
    def test_env_var_takes_priority(self, monkeypatch) -> None:
        monkeypatch.setenv("KIMI_BUILD_SHA", "env_override")
        get_build_sha.cache_clear()
        try:
            assert get_build_sha() == "env_override"
        finally:
            get_build_sha.cache_clear()

    def test_env_var_empty_falls_through(self, monkeypatch) -> None:
        monkeypatch.setenv("KIMI_BUILD_SHA", "")
        get_build_sha.cache_clear()
        try:
            result = get_build_sha()
            assert isinstance(result, str)
        finally:
            get_build_sha.cache_clear()
