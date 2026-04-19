"""Tests for subprocess environment utilities."""

from __future__ import annotations

from kimi_cli.utils.subprocess_env import get_clean_env, get_noninteractive_env

# --- get_clean_env ---


def test_clean_env_does_not_set_git_vars():
    """get_clean_env should NOT inject git/SSH non-interactive flags."""
    env = get_clean_env(base_env={"PATH": "/usr/bin"})
    assert "GIT_TERMINAL_PROMPT" not in env
    assert "GIT_SSH_COMMAND" not in env


# --- get_noninteractive_env ---


def test_noninteractive_disables_git_terminal_prompt():
    env = get_noninteractive_env(base_env={"PATH": "/usr/bin"})
    assert env["GIT_TERMINAL_PROMPT"] == "0"


def test_noninteractive_preserves_existing_git_terminal_prompt():
    """If the user already set GIT_TERMINAL_PROMPT, respect it."""
    env = get_noninteractive_env(base_env={"GIT_TERMINAL_PROMPT": "1"})
    assert env["GIT_TERMINAL_PROMPT"] == "1"


def test_noninteractive_does_not_touch_git_ssh_command():
    """get_noninteractive_env should not inject GIT_SSH_COMMAND to avoid overriding core.sshCommand."""
    env = get_noninteractive_env(base_env={"PATH": "/usr/bin"})
    assert "GIT_SSH_COMMAND" not in env
