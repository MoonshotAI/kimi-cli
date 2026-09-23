from __future__ import annotations

import pytest
from PIL import Image

from kimi_cli.ui.shell import placeholders
from kimi_cli.ui.shell.placeholders import (
    AttachmentCache,
    ImagePathResolutionError,
    PromptPlaceholderManager,
    should_placeholderize_pasted_text,
)
from kimi_cli.wire.types import ImageURLPart, TextPart


def _write_png(path) -> None:
    Image.new("RGB", (4, 4), color=(10, 20, 30)).save(path, format="PNG")


def _image_parts(content):
    return [part for part in content if isinstance(part, ImageURLPart)]


def test_placeholder_manager_serializes_text_tokens_for_history(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path))
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    history_text = manager.serialize_for_history(f"before {text_token} {image_token} after")

    assert history_text == f"before alpha\nbeta\ngamma {image_token} after"


def test_placeholder_manager_refolds_editor_text_for_known_text_tokens() -> None:
    manager = PromptPlaceholderManager()
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    original_command = f"before {text_token} after"

    refolded = manager.refold_after_editor(
        "before alpha\nbeta\ngamma after\nnotes", original_command
    )

    assert refolded == f"before {text_token} after\nnotes"


def test_placeholder_manager_refolds_original_placeholder_span_not_first_duplicate() -> None:
    manager = PromptPlaceholderManager()
    pasted_text = "alpha\nbeta\ngamma"
    text_token = manager.maybe_placeholderize_pasted_text(pasted_text)
    original_command = f"{pasted_text}\n---\n{text_token}"

    refolded = manager.refold_after_editor(f"{pasted_text}\n---\n{pasted_text}", original_command)

    assert refolded == f"{pasted_text}\n---\n{text_token}"


def test_placeholder_manager_does_not_refold_moved_pasted_text() -> None:
    manager = PromptPlaceholderManager()
    pasted_text = "alpha\nbeta\ngamma"
    text_token = manager.maybe_placeholderize_pasted_text(pasted_text)
    original_command = f"{pasted_text}\n---\n{text_token}"
    edited_text = f"{pasted_text}\n{pasted_text}\n---\n"

    refolded = manager.refold_after_editor(edited_text, original_command)

    assert refolded == edited_text


def test_placeholder_manager_refolds_multiple_unedited_placeholders() -> None:
    manager = PromptPlaceholderManager()
    first = "alpha\nbeta\ngamma"
    second = "one\ntwo\nthree"
    first_token = manager.maybe_placeholderize_pasted_text(first)
    second_token = manager.maybe_placeholderize_pasted_text(second)
    original_command = f"{first_token}\n---\n{second_token}"

    refolded = manager.refold_after_editor(f"{first}\n---\n{second}", original_command)

    assert refolded == original_command


def test_placeholder_manager_only_refolds_unedited_placeholder_when_multiple_exist() -> None:
    manager = PromptPlaceholderManager()
    first = "alpha\nbeta\ngamma"
    second = "one\ntwo\nthree"
    first_token = manager.maybe_placeholderize_pasted_text(first)
    second_token = manager.maybe_placeholderize_pasted_text(second)
    original_command = f"{first_token}\n---\n{second_token}"

    refolded = manager.refold_after_editor(
        f"{first}\n---\none\ntwo changed\nthree", original_command
    )

    assert refolded == f"{first_token}\n---\none\ntwo changed\nthree"


def test_placeholder_manager_leaves_unknown_text_token_literal() -> None:
    manager = PromptPlaceholderManager()

    resolved = manager.resolve_command("[Pasted text #999 +3 lines]")

    assert resolved.resolved_text == "[Pasted text #999 +3 lines]"
    assert resolved.content == [TextPart(text="[Pasted text #999 +3 lines]")]


def test_placeholder_manager_resolves_mixed_text_and_image_tokens(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path))
    pasted_text = "\n".join([f"line{i}" for i in range(1, 16)])
    text_token = manager.maybe_placeholderize_pasted_text(pasted_text)
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    resolved = manager.resolve_command(f"look {text_token} {image_token}")

    assert resolved.resolved_text == f"look {pasted_text} {image_token}"
    assert resolved.content[0] == TextPart(text="look ")
    assert resolved.content[1] == TextPart(text=pasted_text)
    assert resolved.content[2] == TextPart(text=" ")
    assert resolved.content[3].type == "text"
    assert resolved.content[4].type == "image_url"
    assert isinstance(resolved.content[4], ImageURLPart)
    assert resolved.content[5] == TextPart(text="</image>")


def test_placeholder_manager_expands_text_but_not_image_for_editor(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path))
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    editor_text = manager.expand_for_editor(f"before {text_token} {image_token} after")

    assert editor_text == f"before alpha\nbeta\ngamma {image_token} after"


def test_placeholder_manager_leaves_unknown_image_placeholder_literal() -> None:
    manager = PromptPlaceholderManager()

    resolved = manager.resolve_command("[image:missing.png,10x10]")

    assert resolved.resolved_text == "[image:missing.png,10x10]"
    assert resolved.content == [TextPart(text="[image:missing.png,10x10]")]


def test_placeholder_manager_attaches_absolute_image_path(tmp_path) -> None:
    image_path = tmp_path / "Screenshot 2026-05-07 at 5.47.51 PM.png"
    _write_png(image_path)
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    resolved = manager.resolve_command(f"look {image_path} please")

    assert resolved.resolved_text == f"look {image_path} please"
    image_parts = _image_parts(resolved.content)
    assert len(image_parts) == 1
    assert image_parts[0].image_url.url.startswith("data:image/png;base64,")


def test_placeholder_manager_attaches_parenthesized_image_path(tmp_path) -> None:
    image_path = tmp_path / "thumbnail.png"
    _write_png(image_path)
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    resolved = manager.resolve_command(f"look ({image_path})")

    assert len(_image_parts(resolved.content)) == 1
    assert resolved.content[0] == TextPart(text="look (")
    assert resolved.content[-1] == TextPart(text=")")


def test_placeholder_manager_attaches_markdown_relative_image_path(tmp_path, monkeypatch) -> None:
    image_path = tmp_path / "thumbnail.png"
    _write_png(image_path)
    monkeypatch.chdir(tmp_path)
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    resolved = manager.resolve_command("look ![alt](./thumbnail.png)")

    assert len(_image_parts(resolved.content)) == 1
    assert resolved.content[0] == TextPart(text="look ![alt](")
    assert resolved.content[-1] == TextPart(text=")")


def test_placeholder_manager_keeps_duplicate_image_path_as_text(tmp_path) -> None:
    image_path = tmp_path / "thumbnail.png"
    _write_png(image_path)
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    resolved = manager.resolve_command(f"compare {image_path} with {image_path}")

    assert len(_image_parts(resolved.content)) == 1
    assert resolved.content[-1] == TextPart(text=str(image_path))


def test_placeholder_manager_attaches_file_url_image_path(tmp_path) -> None:
    image_path = tmp_path / "thumbnail.png"
    _write_png(image_path)
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    resolved = manager.resolve_command(f"inspect {image_path.as_uri()}")

    assert len(_image_parts(resolved.content)) == 1


def test_placeholder_manager_skips_image_paths_without_image_capability(tmp_path) -> None:
    image_path = tmp_path / "thumbnail.png"
    _write_png(image_path)
    command = f"look {image_path}"
    manager = PromptPlaceholderManager(model_capabilities=set())

    resolved = manager.resolve_command(command)

    assert resolved.content == [TextPart(text=command)]


def test_placeholder_manager_reports_missing_explicit_image_path(tmp_path) -> None:
    image_path = tmp_path / "TemporaryItems" / "NSIRD_screencaptureui_x" / "Screenshot.png"
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    with pytest.raises(ImagePathResolutionError, match="no longer accessible"):
        manager.resolve_command(f"look {image_path}")


def test_placeholder_manager_leaves_simple_missing_image_filename_as_text() -> None:
    manager = PromptPlaceholderManager(model_capabilities={"image_in"})

    resolved = manager.resolve_command("create missing.png")

    assert resolved.content == [TextPart(text="create missing.png")]


def test_placeholder_manager_sanitizes_surrogates_in_pasted_text() -> None:
    manager = PromptPlaceholderManager()
    # Lone surrogate \ud83d (half of an emoji pair) must not survive into the entry.
    text_with_surrogate = "A" * 1000 + "\ud83d"
    token = manager.maybe_placeholderize_pasted_text(text_with_surrogate)

    resolved = manager.resolve_command(token)

    # The surrogate must not survive; it is replaced with U+FFFD characters.
    assert "\ud83d" not in resolved.resolved_text
    assert resolved.resolved_text.startswith("A" * 1000)
    assert "\ufffd" in resolved.resolved_text

    # Serialization for history must not raise.
    history = manager.serialize_for_history(token)
    assert "\ud83d" not in history


def test_placeholderize_thresholds_cover_char_and_line_boundaries() -> None:
    assert should_placeholderize_pasted_text("A" * 999) is False
    assert should_placeholderize_pasted_text("A" * 1000) is True
    assert should_placeholderize_pasted_text("line1\nline2") is False
    assert should_placeholderize_pasted_text("\n".join([f"line{i}" for i in range(1, 15)])) is False
    assert should_placeholderize_pasted_text("\n".join([f"line{i}" for i in range(1, 16)])) is True


def test_placeholder_manager_normalizes_crlf_before_threshold_and_resolution() -> None:
    manager = PromptPlaceholderManager()
    lines = "\r\n".join([f"line{i}" for i in range(1, 16)])
    token = manager.maybe_placeholderize_pasted_text(lines)

    assert token == "[Pasted text #1 +15 lines]"

    resolved = manager.resolve_command(token)
    assert resolved.resolved_text == "\n".join([f"line{i}" for i in range(1, 16)])


def test_placeholderize_thresholds_are_configurable(monkeypatch) -> None:
    monkeypatch.setattr(placeholders, "_TEXT_PASTE_CHAR_THRESHOLD", 50)
    monkeypatch.setattr(placeholders, "_TEXT_PASTE_LINE_THRESHOLD", 3)

    assert should_placeholderize_pasted_text("A" * 49) is False
    assert should_placeholderize_pasted_text("A" * 50) is True
    assert should_placeholderize_pasted_text("a\nb") is False
    assert should_placeholderize_pasted_text("a\nb\nc") is True


def test_get_env_int_parses_valid_values(monkeypatch) -> None:
    from kimi_cli.utils.envvar import get_env_int

    monkeypatch.setenv("_TEST_INT_VAR", "42")
    assert get_env_int("_TEST_INT_VAR", 0) == 42


def test_get_env_int_falls_back_on_invalid_values(monkeypatch) -> None:
    from kimi_cli.utils.envvar import get_env_int

    monkeypatch.setenv("_TEST_INT_VAR", "not_a_number")
    assert get_env_int("_TEST_INT_VAR", 99) == 99


def test_get_env_int_returns_default_when_unset() -> None:
    from kimi_cli.utils.envvar import get_env_int

    assert get_env_int("_TEST_NONEXISTENT_VAR_12345", 77) == 77


def test_attachment_cache_loads_legacy_root(tmp_path) -> None:
    legacy_root = tmp_path / "legacy"
    legacy_image_dir = legacy_root / "images"
    legacy_image_dir.mkdir(parents=True)
    attachment_id = "legacy.png"
    payload = b"\x89PNG\r\n\x1a\nlegacy"
    (legacy_image_dir / attachment_id).write_bytes(payload)

    cache = AttachmentCache(root=tmp_path / "new-root", legacy_roots=(legacy_root,))
    loaded = cache.load_bytes("image", attachment_id)

    assert loaded is not None
    path, image_bytes = loaded
    assert path == legacy_image_dir / attachment_id
    assert image_bytes == payload
