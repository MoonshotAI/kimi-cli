from __future__ import annotations

import json
from collections import deque
from types import SimpleNamespace
from typing import cast

from PIL import Image
from prompt_toolkit.buffer import Buffer

from kimi_cli.ui.shell import prompt as shell_prompt
from kimi_cli.ui.shell.placeholders import AttachmentCache, PromptPlaceholderManager


def _make_prompt_session(
    tmp_path, manager: PromptPlaceholderManager
) -> shell_prompt.CustomPromptSession:
    prompt_session = object.__new__(shell_prompt.CustomPromptSession)
    prompt_session._history_file = tmp_path / "history.jsonl"
    prompt_session._last_history_content = None
    prompt_session._placeholder_manager = manager
    prompt_session._attachment_cache = manager.attachment_cache
    return prompt_session


def _read_history_lines(path) -> list[dict[str, str]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _fake_history_buffer(*, working_index: int) -> Buffer:
    return cast(
        Buffer,
        SimpleNamespace(
            working_index=working_index,
            _working_lines=deque(["previous prompt", "/help", ""]),
        ),
    )


def test_append_history_entry_expands_text_placeholders_but_preserves_images(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path / "cache"))
    pasted_text = "\n".join([f"line{i}" for i in range(1, 16)])
    text_token = manager.maybe_placeholderize_pasted_text(pasted_text)
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    prompt_session = _make_prompt_session(tmp_path, manager)
    prompt_session._append_history_entry(f"before {text_token} {image_token} after")

    assert _read_history_lines(prompt_session._history_file) == [
        {"content": f"before {pasted_text} {image_token} after"}
    ]


def test_append_history_entry_deduplicates_consecutive_tokens_with_same_expanded_text(
    tmp_path,
) -> None:
    manager = PromptPlaceholderManager()
    prompt_session = _make_prompt_session(tmp_path, manager)
    token_one = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    token_two = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")

    prompt_session._append_history_entry(token_one)
    prompt_session._append_history_entry(token_two)

    assert _read_history_lines(prompt_session._history_file) == [{"content": "alpha\nbeta\ngamma"}]


def test_append_history_entry_writes_sanitized_surrogate_text(tmp_path) -> None:
    manager = PromptPlaceholderManager()
    prompt_session = _make_prompt_session(tmp_path, manager)
    token = manager.maybe_placeholderize_pasted_text("A" * 1000 + "\ud83d")

    prompt_session._append_history_entry(token)

    lines = _read_history_lines(prompt_session._history_file)
    assert len(lines) == 1
    assert "\ud83d" not in lines[0]["content"]
    assert "\ufffd" in lines[0]["content"]
    assert lines[0]["content"].startswith("A" * 1000)


def test_current_history_working_line_allows_auto_completion() -> None:
    assert not shell_prompt._is_browsing_history_entry(_fake_history_buffer(working_index=2))


def test_recalled_history_entry_suppresses_auto_completion() -> None:
    assert shell_prompt._is_browsing_history_entry(_fake_history_buffer(working_index=1))
