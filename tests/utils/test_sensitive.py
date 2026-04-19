"""Tests for the sensitive file detection module."""

from __future__ import annotations

import pytest

from kimi_cli.utils.sensitive import is_sensitive_file, sensitive_file_warning


@pytest.mark.parametrize(
    "path",
    [
        ".env",
        "/app/.env",
        "project/.env",
    ],
)
def test_is_sensitive_env_files(path: str):
    assert is_sensitive_file(path)


@pytest.mark.parametrize(
    "path",
    [
        ".env.local",
        ".env.production",
        "/app/.env.staging",
    ],
)
def test_is_sensitive_env_variants(path: str):
    assert is_sensitive_file(path)


@pytest.mark.parametrize(
    "path",
    [
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "/home/user/.ssh/id_rsa",
        "/home/user/.ssh/id_ed25519",
    ],
)
def test_is_sensitive_ssh_keys(path: str):
    assert is_sensitive_file(path)


@pytest.mark.parametrize(
    "path",
    [
        "/home/user/.aws/credentials",
        "/home/user/.gcp/credentials",
        ".aws/credentials",
        ".gcp/credentials",
        "credentials",
    ],
)
def test_is_sensitive_cloud_credentials(path: str):
    assert is_sensitive_file(path)


@pytest.mark.parametrize(
    "path",
    [
        "app.py",
        "config.yml",
        "README.md",
        "package.json",
        "server.key.example",
        "id_rsa.pub",
        "credentials.json",
        ".envrc",
        "environment.py",
        ".env_example",
        ".env.example",
        ".env.sample",
        ".env.template",
        "/app/.env.example",
    ],
)
def test_not_sensitive_normal_files(path: str):
    assert not is_sensitive_file(path)


def test_sensitive_file_warning_single():
    warning = sensitive_file_warning([".env"])
    assert "1 sensitive file(s)" in warning
    assert ".env" in warning
    assert "protect secrets" in warning


def test_sensitive_file_warning_multiple():
    warning = sensitive_file_warning([".env", ".env.local", "id_rsa"])
    assert "3 sensitive file(s)" in warning
    assert ".env" in warning
    assert "id_rsa" in warning
