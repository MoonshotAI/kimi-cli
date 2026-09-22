from __future__ import annotations

import asyncio

import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput

from kimi_cli.ui.shell.prompt import CustomPromptSession, StatusSnapshot


@pytest.mark.asyncio
async def test_numeric_keypad_sequences_insert_digits() -> None:
    with (
        create_pipe_input() as pipe_input,
        create_app_session(input=pipe_input, output=DummyOutput()),
    ):
        prompt = CustomPromptSession(
            status_provider=lambda: StatusSnapshot(context_usage=0.0),
            model_capabilities=set(),
            model_name=None,
            thinking=False,
            agent_mode_slash_commands=[],
            shell_mode_slash_commands=[],
        )

        result_task = asyncio.create_task(prompt._session.prompt_async())
        pipe_input.send_text("".join(f"\x1bO{suffix}" for suffix in "pqrstuvwxy") + "\r")

        assert await asyncio.wait_for(result_task, timeout=1) == "0123456789"
