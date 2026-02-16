from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from kimi_cli.ui.shell.prompt import prompt_choice


@pytest.mark.asyncio
async def test_prompt_choice_numeric_shortcuts() -> None:
    choices = ["Option A", "Option B", "Option C"]
    header = "Select one:"

    # We want to check the message passed to ChoiceInput
    with patch("kimi_cli.ui.shell.prompt.ChoiceInput") as mock_choice_input:
        # Configure the mock to return a result when prompted
        mock_instance = mock_choice_input.return_value
        # MUST return an awaitable for 'await choice_input.prompt_async()'
        mock_instance.prompt_async = AsyncMock(return_value="Option B")
        mock_instance.options = [
            ("Option A", "Option A"),
            ("Option B", "Option B"),
            ("Option C", "Option C"),
        ]

        result = await prompt_choice(message=header, choices=choices)

        assert result == "Option B"

        # Verify the message had the shortcuts
        args, kwargs = mock_choice_input.call_args
        message = kwargs["message"]
        assert "Select one:" in message
        assert "[1] Option A" in message
        assert "[2] Option B" in message
        assert "[3] Option C" in message


@pytest.mark.asyncio
async def test_prompt_choice_tuple_choices() -> None:
    choices = [("a", "Label A"), ("b", "Label B")]
    header = "Choose:"

    with patch("kimi_cli.ui.shell.prompt.ChoiceInput") as mock_choice_input:
        mock_instance = mock_choice_input.return_value
        mock_instance.prompt_async = AsyncMock(return_value="a")
        mock_instance.options = choices

        result = await prompt_choice(message=header, choices=choices)

        assert result == "a"

        args, kwargs = mock_choice_input.call_args
        message = kwargs["message"]
        assert "Choose:" in message
        assert "[1] Label A" in message
        assert "[2] Label B" in message
