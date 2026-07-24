from __future__ import annotations

import shlex
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

from PIL import Image
from prompt_toolkit.key_binding import KeyPressEvent

if TYPE_CHECKING:
    from prompt_toolkit.buffer import Buffer

from kimi_cli.llm import ModelCapability
from kimi_cli.ui.shell import prompt as shell_prompt
from kimi_cli.ui.shell.prompt import PromptMode
from kimi_cli.utils.clipboard import ClipboardResult
from kimi_cli.wire.types import TextPart


class _DummyBuffer:
    def __init__(self) -> None:
        self.inserted: list[str] = []

    def insert_text(self, text: str) -> None:
        self.inserted.append(text)


class _DummyApp:
    def __init__(self) -> None:
        self.invalidated = False

    def invalidate(self) -> None:
        self.invalidated = True


class _FakeAttachmentCache(shell_prompt.AttachmentCache):
    def __init__(self, store_result: shell_prompt.CachedAttachment | None) -> None:
        self.store_result = store_result

    def store_image(self, image: Image.Image) -> shell_prompt.CachedAttachment | None:
        return self.store_result


def _make_prompt_session(
    mode: PromptMode, *, supports_image: bool = True
) -> shell_prompt.CustomPromptSession:
    ps = object.__new__(shell_prompt.CustomPromptSession)
    ps._mode = mode
    ps._model_capabilities = cast(
        set[ModelCapability],
        {"image_in"} if supports_image else set(),
    )
    cached = shell_prompt.CachedAttachment(
        kind="image",
        attachment_id="abc123",
        path=Path("/tmp/abc123.png"),
    )
    ps._attachment_cache = _FakeAttachmentCache(cached)
    return ps


# --- File path tests (videos, PDFs, etc.) ---


def test_paste_video_path_in_shell_mode(monkeypatch) -> None:
    video_path = Path("/tmp/My Clip (final).mp4")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(), file_paths=(video_path,)),
    )

    ps = _make_prompt_session(PromptMode.SHELL)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == [shlex.quote(str(video_path))]
    assert app.invalidated is True


def test_paste_video_path_in_agent_mode(monkeypatch) -> None:
    video_path = Path("/tmp/My Clip (final).mp4")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(), file_paths=(video_path,)),
    )

    ps = _make_prompt_session(PromptMode.AGENT)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == [str(video_path)]


def test_paste_single_pdf_in_agent_mode(monkeypatch) -> None:
    pdf_path = Path("/tmp/document.pdf")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(), file_paths=(pdf_path,)),
    )

    ps = _make_prompt_session(PromptMode.AGENT)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == [str(pdf_path)]


def test_paste_multiple_files(monkeypatch) -> None:
    """Multiple non-image files should all be inserted, space-separated."""
    paths = (Path("/tmp/a.pdf"), Path("/tmp/b.csv"), Path("/tmp/c.mp4"))
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(), file_paths=paths),
    )

    ps = _make_prompt_session(PromptMode.AGENT)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == ["/tmp/a.pdf /tmp/b.csv /tmp/c.mp4"]


def test_paste_multiple_files_quoted_in_shell_mode(monkeypatch) -> None:
    paths = (Path("/tmp/My Doc.pdf"), Path("/tmp/data (1).csv"))
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(), file_paths=paths),
    )

    ps = _make_prompt_session(PromptMode.SHELL)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    expected = " ".join(shlex.quote(str(p)) for p in paths)
    assert buffer.inserted == [expected]


# --- Image tests ---


def test_paste_single_image(monkeypatch) -> None:
    img = Image.new("RGB", (10, 10))
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(img,), file_paths=()),
    )

    ps = _make_prompt_session(PromptMode.AGENT, supports_image=True)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert len(buffer.inserted) == 1
    assert buffer.inserted[0].startswith("[image:")


def test_paste_image_unsupported_model(monkeypatch, capsys) -> None:
    img = Image.new("RGB", (10, 10))
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(img,), file_paths=()),
    )

    ps = _make_prompt_session(PromptMode.AGENT, supports_image=False)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    # No image placeholder inserted, returns False so caller can fall back to text paste
    assert result is False
    assert buffer.inserted == []


# --- Mixed content tests ---


def test_paste_files_and_images_together(monkeypatch) -> None:
    """Both file paths and images should be inserted."""
    img = Image.new("RGB", (5, 5))
    pdf_path = Path("/tmp/doc.pdf")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(img,), file_paths=(pdf_path,)),
    )

    ps = _make_prompt_session(PromptMode.AGENT, supports_image=True)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    # Should have one insert_text call with file path + image placeholder
    joined = "".join(buffer.inserted)
    assert "/tmp/doc.pdf" in joined
    assert "[image:" in joined


def test_paste_returns_false_when_all_images_fail_to_cache(monkeypatch) -> None:
    """When store_image fails for every image, fall back to text paste."""
    img = Image.new("RGB", (10, 10))
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardResult(images=(img,), file_paths=()),
    )

    ps = _make_prompt_session(PromptMode.AGENT, supports_image=True)
    cast(_FakeAttachmentCache, ps._attachment_cache).store_result = None
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is False
    assert buffer.inserted == []


def test_paste_returns_false_when_no_media(monkeypatch) -> None:
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: None,
    )

    ps = _make_prompt_session(PromptMode.AGENT)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = ps._try_paste_media(cast(KeyPressEvent, event))

    assert result is False
    assert buffer.inserted == []


def test_insert_pasted_text_placeholderizes_long_text_in_agent_mode() -> None:
    ps = _make_prompt_session(PromptMode.AGENT)
    buffer = _DummyBuffer()
    long_text = "\n".join([f"line{i}" for i in range(1, 16)])

    ps._insert_pasted_text(cast("Buffer", buffer), long_text)

    assert len(buffer.inserted) == 1
    inserted = buffer.inserted[0]
    assert inserted == "[Pasted text #1 +15 lines]"

    user_input = ps._build_user_input(inserted)
    assert user_input.command == inserted
    assert user_input.resolved_command == long_text
    assert user_input.content == [TextPart(text=long_text)]


def test_insert_pasted_text_keeps_raw_text_in_shell_mode() -> None:
    ps = _make_prompt_session(PromptMode.SHELL)
    buffer = _DummyBuffer()
    long_text = "alpha\nbeta\ngamma"

    ps._insert_pasted_text(cast("Buffer", buffer), long_text)

    assert buffer.inserted == [long_text]


def test_build_user_input_expands_text_placeholders_for_slash_parsing() -> None:
    ps = _make_prompt_session(PromptMode.AGENT)
    long_text = "\n".join([f"line{i}" for i in range(1, 16)])
    token = ps._get_placeholder_manager().maybe_placeholderize_pasted_text(long_text)

    user_input = ps._build_user_input(f"/echo {token}")

    assert user_input.command == f"/echo {token}"
    assert user_input.resolved_command == f"/echo {long_text}"


def test_handle_bracketed_paste_placeholderizes_long_text_in_agent_mode() -> None:
    ps = _make_prompt_session(PromptMode.AGENT)
    buffer = _DummyBuffer()
    app = _DummyApp()
    data_lines = "\r\n".join([f"line{i}" for i in range(1, 16)])
    event = SimpleNamespace(
        current_buffer=buffer,
        app=app,
        data=data_lines,
    )

    ps._handle_bracketed_paste(cast(KeyPressEvent, event))

    assert buffer.inserted == ["[Pasted text #1 +15 lines]"]
    assert app.invalidated is True
    resolved_text = "\n".join([f"line{i}" for i in range(1, 16)])
    user_input = ps._build_user_input(buffer.inserted[0])
    assert user_input.resolved_command == resolved_text


def test_handle_bracketed_paste_keeps_normalized_text_in_shell_mode() -> None:
    ps = _make_prompt_session(PromptMode.SHELL)
    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(
        current_buffer=buffer,
        app=app,
        data="line1\r\nline2\r\nline3",
    )

    ps._handle_bracketed_paste(cast(KeyPressEvent, event))

    assert buffer.inserted == ["line1\nline2\nline3"]
    assert app.invalidated is True


async def test_question_delegate_expands_placeholders_on_submit() -> None:
    """When submitting 'other' input in a question panel, pasted text
    placeholders should be expanded to full text via text_expander."""
    from unittest.mock import patch

    from kimi_cli.ui.shell.visualize import QuestionPromptDelegate, QuestionRequestPanel
    from kimi_cli.wire.types import QuestionItem, QuestionRequest

    full_text = "\n".join([f"line{i}" for i in range(1, 20)])
    expand_calls: list[str] = []

    def fake_expander(text: str) -> str:
        expand_calls.append(text)
        return text.replace("[Pasted text #1 +19 lines]", full_text)

    question = QuestionItem(question="Review?", options=[], other_label="Revise")
    request = QuestionRequest(id="q1", tool_call_id="tc1", questions=[question])
    panel = QuestionRequestPanel(request)

    delegate = QuestionPromptDelegate(
        panel,
        on_advance=lambda: None,
        on_invalidate=lambda: None,
        text_expander=fake_expander,
    )
    # Select the "Other" option
    panel.select_index(len(panel._options) - 1)

    # Simulate submitting placeholder text via submit_other
    submitted_texts: list[str] = []
    original_submit_other = panel.submit_other

    def capture_submit_other(text: str) -> bool:
        submitted_texts.append(text)
        return original_submit_other(text)

    buffer = _DummyBuffer()
    buffer.text = "prefix [Pasted text #1 +19 lines]"  # type: ignore[attr-defined]
    buffer.set_document = lambda *a, **kw: None  # type: ignore[attr-defined]

    with patch.object(panel, "submit_other", capture_submit_other):
        delegate._submit_other_input(cast("Buffer", buffer))

    assert len(expand_calls) == 1
    assert expand_calls[0] == "prefix [Pasted text #1 +19 lines]"
    assert len(submitted_texts) == 1
    assert full_text in submitted_texts[0]
