from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import time
from collections import deque
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from enum import Enum
from hashlib import md5
from pathlib import Path
from typing import Any, Literal, Protocol, cast, override

from kaos.path import KaosPath
from kosong.chat_provider import TokenUsage
from prompt_toolkit import PromptSession
from prompt_toolkit.application.current import get_app_or_none
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.clipboard.pyperclip import PyperclipClipboard
from prompt_toolkit.completion import (
    CompleteEvent,
    Completer,
    Completion,
    FuzzyCompleter,
    WordCompleter,
    merge_completers,
)
from prompt_toolkit.data_structures import Point
from prompt_toolkit.document import Document
from prompt_toolkit.filters import Condition, has_completions, has_focus, is_done
from prompt_toolkit.formatted_text import AnyFormattedText, FormattedText, to_formatted_text
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.keys import Keys
from prompt_toolkit.layout.containers import (
    ConditionalContainer,
    Float,
    FloatContainer,
    HSplit,
    Window,
)
from prompt_toolkit.layout.controls import UIContent, UIControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.styles import Style
from prompt_toolkit.utils import get_cwidth
from pydantic import BaseModel, ValidationError

from kimi_cli.llm import ModelCapability
from kimi_cli.share import get_share_dir
from kimi_cli.soul import StatusSnapshot, format_context_status, format_token_count
from kimi_cli.ui.shell import placeholders as prompt_placeholders
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.placeholders import (
    PromptPlaceholderManager,
    normalize_pasted_text,
    sanitize_surrogates,
)
from kimi_cli.utils.clipboard import (
    grab_media_from_clipboard,
    is_clipboard_available,
)
from kimi_cli.utils.logging import logger
from kimi_cli.utils.slashcmd import SlashCommand
from kimi_cli.wire.types import ContentPart

AttachmentCache = prompt_placeholders.AttachmentCache
CachedAttachment = prompt_placeholders.CachedAttachment
_parse_attachment_kind = prompt_placeholders.parse_attachment_kind

PROMPT_SYMBOL = "✨"
PROMPT_SYMBOL_SHELL = "$"
PROMPT_SYMBOL_THINKING = "💫"
PROMPT_SYMBOL_PLAN = "📋"


class SlashCommandCompleter(Completer):
    """
    A completer that:
    - Shows one line per slash command using the canonical "/name"
    - Fuzzy-matches by primary name or any alias while inserting the canonical "/name"
    - Only activates when the current token starts with '/'
    """

    def __init__(self, available_commands: Sequence[SlashCommand[Any]]) -> None:
        super().__init__()
        self._available_commands = list(available_commands)
        self._command_lookup: dict[str, list[SlashCommand[Any]]] = {}
        words: list[str] = []

        for cmd in sorted(self._available_commands, key=lambda c: c.name):
            if cmd.name not in self._command_lookup:
                self._command_lookup[cmd.name] = []
                words.append(cmd.name)
            self._command_lookup[cmd.name].append(cmd)
            for alias in cmd.aliases:
                if alias in self._command_lookup:
                    self._command_lookup[alias].append(cmd)
                else:
                    self._command_lookup[alias] = [cmd]
                    words.append(alias)

        self._word_pattern = re.compile(r"[^\s]+")
        self._fuzzy_pattern = r"^[^\s]*"
        self._word_completer = WordCompleter(words, WORD=False, pattern=self._word_pattern)
        self._fuzzy = FuzzyCompleter(self._word_completer, WORD=False, pattern=self._fuzzy_pattern)

    @staticmethod
    def should_complete(document: Document) -> bool:
        """Return whether slash command completion should be active for the current buffer."""
        text = document.text_before_cursor

        if document.text_after_cursor.strip():
            return False

        last_space = text.rfind(" ")
        token = text[last_space + 1 :]
        prefix = text[: last_space + 1] if last_space != -1 else ""

        return not prefix.strip() and token.startswith("/")

    @override
    def get_completions(
        self, document: Document, complete_event: CompleteEvent
    ) -> Iterable[Completion]:
        if not self.should_complete(document):
            return
        text = document.text_before_cursor
        last_space = text.rfind(" ")
        token = text[last_space + 1 :]

        typed = token[1:]
        if typed and typed in self._command_lookup:
            return
        mention_doc = Document(text=typed, cursor_position=len(typed))
        candidates = list(self._fuzzy.get_completions(mention_doc, complete_event))

        seen: set[str] = set()

        for candidate in candidates:
            commands = self._command_lookup.get(candidate.text)
            if not commands:
                continue
            for cmd in commands:
                if cmd.name in seen:
                    continue
                seen.add(cmd.name)
                yield Completion(
                    text=f"/{cmd.name}",
                    start_position=-len(token),
                    display=f"/{cmd.name}",
                    display_meta=cmd.description,
                )


def _truncate_to_width(text: str, width: int) -> str:
    if width <= 0:
        return ""

    total = 0
    chars: list[str] = []
    for ch in text:
        ch_width = get_cwidth(ch)
        if total + ch_width > width:
            break
        chars.append(ch)
        total += ch_width

    if total == get_cwidth(text):
        return text + (" " * max(0, width - total))

    ellipsis = "..."
    ellipsis_width = get_cwidth(ellipsis)
    if width <= ellipsis_width:
        return "." * width

    available = width - ellipsis_width
    total = 0
    chars = []
    for ch in text:
        ch_width = get_cwidth(ch)
        if total + ch_width > available:
            break
        chars.append(ch)
        total += ch_width
    return "".join(chars) + ellipsis + (" " * max(0, width - total - ellipsis_width))


def _wrap_to_width(text: str, width: int, *, max_lines: int | None = None) -> list[str]:
    if width <= 0:
        return []

    words = text.split()
    if not words:
        return [""]

    lines: list[str] = []
    current_words: list[str] = []
    current_width = 0
    index = 0

    while index < len(words):
        word = words[index]
        word_width = get_cwidth(word)
        separator_width = 1 if current_words else 0

        if current_words and current_width + separator_width + word_width <= width:
            current_words.append(word)
            current_width += separator_width + word_width
            index += 1
            continue

        if not current_words and word_width <= width:
            current_words.append(word)
            current_width = word_width
            index += 1
            continue

        if not current_words and word_width > width:
            current_words.append(_truncate_to_width(word, width).rstrip())
            current_width = get_cwidth(current_words[0])
            index += 1

        lines.append(" ".join(current_words))
        current_words = []
        current_width = 0

        if max_lines is not None and len(lines) == max_lines:
            remaining = " ".join(words[index:])
            if remaining:
                prefix = f"{lines[-1]} " if lines[-1] else ""
                lines[-1] = _truncate_to_width(prefix + remaining, width).rstrip()
            return lines

    if current_words:
        line = " ".join(current_words)
        if max_lines is not None and len(lines) + 1 > max_lines:
            if lines:
                lines[-1] = _truncate_to_width(f"{lines[-1]} {line}", width).rstrip()
            else:
                lines.append(_truncate_to_width(line, width).rstrip())
        else:
            lines.append(line)

    return lines


def _find_prompt_float_container(layout_container: object) -> FloatContainer | None:
    if not isinstance(layout_container, HSplit):
        return None

    for child in cast(Sequence[object], layout_container.children):
        float_container = _extract_float_container(child)
        if float_container is not None:
            return float_container
    return None


def _extract_float_container(container: object) -> FloatContainer | None:
    if isinstance(container, FloatContainer):
        return container
    if isinstance(container, ConditionalContainer):
        if isinstance(container.content, FloatContainer):
            return container.content
        if isinstance(container.alternative_content, FloatContainer):
            return container.alternative_content
    return None


class SlashCommandMenuControl(UIControl):
    """Render slash command completions as a full-width menu that matches the shell UI."""

    _MAX_EXPANDED_META_LINES = 3

    def __init__(
        self,
        *,
        left_padding: Callable[[], int],
        scroll_offset: int = 1,
    ) -> None:
        self._left_padding = left_padding
        self._scroll_offset = scroll_offset

    def has_focus(self) -> bool:
        return False

    def preferred_width(self, max_available_width: int) -> int | None:
        return max_available_width

    def preferred_height(
        self,
        width: int,
        max_available_height: int,
        wrap_lines: bool,
        get_line_prefix: Callable[..., AnyFormattedText] | None,
    ) -> int | None:
        app = get_app_or_none()
        complete_state = (
            getattr(app.current_buffer, "complete_state", None) if app is not None else None
        )
        if complete_state is None:
            return 0
        completions = complete_state.completions
        selected_index = complete_state.complete_index
        if selected_index is None:
            return min(max_available_height, len(completions) + 1)
        menu_width = max(0, width - self._left_padding())
        marker_width = 2
        command_width = self._command_column_width(completions, menu_width, marker_width)
        gap_width = 3 if menu_width > command_width + 6 else 1
        meta_width = max(0, menu_width - marker_width - command_width - gap_width)
        selected_meta_lines = self._selected_meta_lines(
            completions[selected_index].display_meta_text,
            meta_width,
        )
        return min(max_available_height, len(completions) + len(selected_meta_lines))

    def create_content(self, width: int, height: int) -> UIContent:
        app = get_app_or_none()
        complete_state = (
            getattr(app.current_buffer, "complete_state", None) if app is not None else None
        )
        if complete_state is None or not complete_state.completions:
            return UIContent()

        completions = complete_state.completions
        selected_index = complete_state.complete_index
        available_rows = max(1, height - 1)

        menu_width = max(0, width - self._left_padding())
        marker_width = 2
        command_width = self._command_column_width(completions, menu_width, marker_width)
        gap_width = 3 if menu_width > command_width + 6 else 1
        meta_width = max(0, menu_width - marker_width - command_width - gap_width)

        rendered_lines: list[FormattedText] = [
            FormattedText([("class:slash-completion-menu.separator", "─" * max(0, width))])
        ]
        selected_line_index = 0

        if selected_index is None:
            end = min(len(completions) - 1, available_rows - 1)
            for index in range(0, end + 1):
                rendered_lines.append(
                    self._render_single_line_item(
                        width=width,
                        completion=completions[index],
                        marker_width=marker_width,
                        command_width=command_width,
                        meta_width=meta_width,
                        gap_width=gap_width,
                        is_current=False,
                    )
                )

            return UIContent(
                get_line=lambda i: rendered_lines[i],
                line_count=len(rendered_lines),
                cursor_position=Point(x=0, y=selected_line_index),
            )

        selected_meta_lines = self._selected_meta_lines(
            completions[selected_index].display_meta_text,
            meta_width,
        )
        start, end = self._visible_window_bounds(
            completion_count=len(completions),
            selected_index=selected_index,
            available_rows=available_rows,
            selected_item_height=len(selected_meta_lines),
        )
        selected_line_index = 1

        for index in range(start, end + 1):
            completion = completions[index]
            if index == selected_index:
                selected_line_index = len(rendered_lines)
                rendered_lines.extend(
                    self._render_selected_item_lines(
                        width=width,
                        completion=completion,
                        marker_width=marker_width,
                        command_width=command_width,
                        meta_width=meta_width,
                        gap_width=gap_width,
                        meta_lines=selected_meta_lines,
                    )
                )
                continue

            rendered_lines.append(
                self._render_single_line_item(
                    width=width,
                    completion=completion,
                    marker_width=marker_width,
                    command_width=command_width,
                    meta_width=meta_width,
                    gap_width=gap_width,
                    is_current=False,
                )
            )

        return UIContent(
            get_line=lambda i: rendered_lines[i],
            line_count=len(rendered_lines),
            cursor_position=Point(x=0, y=selected_line_index),
        )

    def _selected_meta_lines(self, text: str, meta_width: int) -> list[str]:
        lines = _wrap_to_width(
            text,
            meta_width,
            max_lines=self._MAX_EXPANDED_META_LINES,
        )
        return lines or [""]

    def _visible_window_bounds(
        self,
        *,
        completion_count: int,
        selected_index: int,
        available_rows: int,
        selected_item_height: int,
    ) -> tuple[int, int]:
        selected_item_height = min(selected_item_height, available_rows)
        remaining_rows = max(0, available_rows - selected_item_height)

        before = min(self._scroll_offset, selected_index, remaining_rows)
        remaining_rows -= before
        after = min(completion_count - selected_index - 1, remaining_rows)
        remaining_rows -= after

        extra_before = min(selected_index - before, remaining_rows)
        before += extra_before
        remaining_rows -= extra_before

        extra_after = min(completion_count - selected_index - 1 - after, remaining_rows)
        after += extra_after

        return selected_index - before, selected_index + after

    def _command_column_width(
        self,
        completions: Sequence[Completion],
        menu_width: int,
        marker_width: int,
    ) -> int:
        if menu_width <= 0:
            return 0
        longest = max((get_cwidth(c.display_text) for c in completions), default=0)
        preferred = longest + 2
        usable_width = max(0, menu_width - marker_width)
        minimum = min(usable_width, 18)
        maximum = max(minimum, min(28, usable_width // 2))
        return max(minimum, min(preferred, maximum))

    def _render_single_line_item(
        self,
        *,
        width: int,
        completion: Completion,
        marker_width: int,
        command_width: int,
        meta_width: int,
        gap_width: int,
        is_current: bool,
    ) -> FormattedText:
        padding_width = max(0, width - marker_width - command_width - meta_width - gap_width)
        left_padding = min(self._left_padding(), padding_width)
        trailing_width = max(
            0,
            width - left_padding - marker_width - command_width - gap_width - meta_width,
        )

        command_style = (
            "class:slash-completion-menu.command.current"
            if is_current
            else "class:slash-completion-menu.command"
        )
        meta_style = (
            "class:slash-completion-menu.meta.current"
            if is_current
            else "class:slash-completion-menu.meta"
        )
        marker_style = (
            "class:slash-completion-menu.marker.current"
            if is_current
            else "class:slash-completion-menu.marker"
        )
        marker = "› " if is_current else "  "

        fragments: FormattedText = FormattedText()
        fragments.append(("class:slash-completion-menu", " " * left_padding))
        fragments.append((marker_style, marker.ljust(marker_width)))
        fragments.append(
            (command_style, _truncate_to_width(completion.display_text, command_width))
        )
        fragments.append(("class:slash-completion-menu", " " * gap_width))
        fragments.append((meta_style, _truncate_to_width(completion.display_meta_text, meta_width)))
        fragments.append(("class:slash-completion-menu", " " * trailing_width))
        return fragments

    def _render_selected_item_lines(
        self,
        *,
        width: int,
        completion: Completion,
        marker_width: int,
        command_width: int,
        meta_width: int,
        gap_width: int,
        meta_lines: Sequence[str],
    ) -> list[FormattedText]:
        lines = [
            self._render_single_line_item(
                width=width,
                completion=Completion(
                    text=completion.text,
                    start_position=completion.start_position,
                    display=completion.display,
                    display_meta=meta_lines[0],
                ),
                marker_width=marker_width,
                command_width=command_width,
                meta_width=meta_width,
                gap_width=gap_width,
                is_current=True,
            )
        ]

        continuation_prefix = (
            " " * self._left_padding() + " " * marker_width + " " * command_width + " " * gap_width
        )
        continuation_trailing = max(
            0,
            width - get_cwidth(continuation_prefix) - meta_width,
        )
        for meta_line in meta_lines[1:]:
            fragments: FormattedText = FormattedText()
            fragments.append(("class:slash-completion-menu", continuation_prefix))
            fragments.append(
                (
                    "class:slash-completion-menu.meta.current",
                    _truncate_to_width(meta_line, meta_width),
                )
            )
            fragments.append(("class:slash-completion-menu", " " * continuation_trailing))
            lines.append(fragments)

        return lines


class LocalFileMentionCompleter(Completer):
    """Offer fuzzy `@` path completion by indexing workspace files."""

    _FRAGMENT_PATTERN = re.compile(r"[^\s@]+")
    _TRIGGER_GUARDS = frozenset((".", "-", "_", "`", "'", '"', ":", "@", "#", "~"))
    _IGNORED_NAME_GROUPS: dict[str, tuple[str, ...]] = {
        "vcs_metadata": (".DS_Store", ".bzr", ".git", ".hg", ".svn"),
        "tooling_caches": (
            ".build",
            ".cache",
            ".coverage",
            ".fleet",
            ".gradle",
            ".idea",
            ".ipynb_checkpoints",
            ".pnpm-store",
            ".pytest_cache",
            ".pub-cache",
            ".ruff_cache",
            ".swiftpm",
            ".tox",
            ".venv",
            ".vs",
            ".vscode",
            ".yarn",
            ".yarn-cache",
        ),
        "js_frontend": (
            ".next",
            ".nuxt",
            ".parcel-cache",
            ".svelte-kit",
            ".turbo",
            ".vercel",
            "node_modules",
        ),
        "python_packaging": (
            "__pycache__",
            "build",
            "coverage",
            "dist",
            "htmlcov",
            "pip-wheel-metadata",
            "venv",
        ),
        "java_jvm": (".mvn", "out", "target"),
        "dotnet_native": ("bin", "cmake-build-debug", "cmake-build-release", "obj"),
        "bazel_buck": ("bazel-bin", "bazel-out", "bazel-testlogs", "buck-out"),
        "misc_artifacts": (
            ".dart_tool",
            ".serverless",
            ".stack-work",
            ".terraform",
            ".terragrunt-cache",
            "DerivedData",
            "Pods",
            "deps",
            "tmp",
            "vendor",
        ),
    }
    _IGNORED_NAMES = frozenset(name for group in _IGNORED_NAME_GROUPS.values() for name in group)
    _IGNORED_PATTERN_PARTS: tuple[str, ...] = (
        r".*_cache$",
        r".*-cache$",
        r".*\.egg-info$",
        r".*\.dist-info$",
        r".*\.py[co]$",
        r".*\.class$",
        r".*\.sw[po]$",
        r".*~$",
        r".*\.(?:tmp|bak)$",
    )
    _IGNORED_PATTERNS = re.compile(
        "|".join(f"(?:{part})" for part in _IGNORED_PATTERN_PARTS),
        re.IGNORECASE,
    )

    def __init__(
        self,
        root: Path,
        *,
        refresh_interval: float = 2.0,
        limit: int = 1000,
    ) -> None:
        self._root = root
        self._refresh_interval = refresh_interval
        self._limit = limit
        self._cache_time: float = 0.0
        self._cached_paths: list[str] = []
        self._top_cache_time: float = 0.0
        self._top_cached_paths: list[str] = []
        self._fragment_hint: str | None = None

        self._word_completer = WordCompleter(
            self._get_paths,
            WORD=False,
            pattern=self._FRAGMENT_PATTERN,
        )

        self._fuzzy = FuzzyCompleter(
            self._word_completer,
            WORD=False,
            pattern=r"^[^\s@]*",
        )

    @classmethod
    def _is_ignored(cls, name: str) -> bool:
        if not name:
            return True
        if name in cls._IGNORED_NAMES:
            return True
        return bool(cls._IGNORED_PATTERNS.fullmatch(name))

    def _get_paths(self) -> list[str]:
        fragment = self._fragment_hint or ""
        if "/" not in fragment and len(fragment) < 3:
            return self._get_top_level_paths()
        return self._get_deep_paths()

    def _get_top_level_paths(self) -> list[str]:
        now = time.monotonic()
        if now - self._top_cache_time <= self._refresh_interval:
            return self._top_cached_paths

        entries: list[str] = []
        try:
            for entry in sorted(self._root.iterdir(), key=lambda p: p.name):
                name = entry.name
                if self._is_ignored(name):
                    continue
                entries.append(f"{name}/" if entry.is_dir() else name)
                if len(entries) >= self._limit:
                    break
        except OSError:
            return self._top_cached_paths

        self._top_cached_paths = entries
        self._top_cache_time = now
        return self._top_cached_paths

    def _get_deep_paths(self) -> list[str]:
        now = time.monotonic()
        if now - self._cache_time <= self._refresh_interval:
            return self._cached_paths

        paths: list[str] = []
        try:
            for current_root, dirs, files in os.walk(self._root):
                relative_root = Path(current_root).relative_to(self._root)

                # Prevent descending into ignored directories.
                dirs[:] = sorted(d for d in dirs if not self._is_ignored(d))

                if relative_root.parts and any(
                    self._is_ignored(part) for part in relative_root.parts
                ):
                    dirs[:] = []
                    continue

                if relative_root.parts:
                    paths.append(relative_root.as_posix() + "/")
                    if len(paths) >= self._limit:
                        break

                for file_name in sorted(files):
                    if self._is_ignored(file_name):
                        continue
                    relative = (relative_root / file_name).as_posix()
                    if not relative:
                        continue
                    paths.append(relative)
                    if len(paths) >= self._limit:
                        break

                if len(paths) >= self._limit:
                    break
        except OSError:
            return self._cached_paths

        self._cached_paths = paths
        self._cache_time = now
        return self._cached_paths

    @staticmethod
    def _extract_fragment(text: str) -> str | None:
        index = text.rfind("@")
        if index == -1:
            return None

        if index > 0:
            prev = text[index - 1]
            if prev.isalnum() or prev in LocalFileMentionCompleter._TRIGGER_GUARDS:
                return None

        fragment = text[index + 1 :]
        if not fragment:
            return ""

        if any(ch.isspace() for ch in fragment):
            return None

        return fragment

    def _is_completed_file(self, fragment: str) -> bool:
        candidate = fragment.rstrip("/")
        if not candidate:
            return False
        try:
            return (self._root / candidate).is_file()
        except OSError:
            return False

    @override
    def get_completions(
        self, document: Document, complete_event: CompleteEvent
    ) -> Iterable[Completion]:
        fragment = self._extract_fragment(document.text_before_cursor)
        if fragment is None:
            return
        if self._is_completed_file(fragment):
            return

        mention_doc = Document(text=fragment, cursor_position=len(fragment))
        self._fragment_hint = fragment
        try:
            # First, ask the fuzzy completer for candidates.
            candidates = list(self._fuzzy.get_completions(mention_doc, complete_event))

            # re-rank: prefer basename matches
            frag_lower = fragment.lower()

            def _rank(c: Completion) -> tuple[int, ...]:
                path = c.text
                base = path.rstrip("/").split("/")[-1].lower()
                if base.startswith(frag_lower):
                    cat = 0
                elif frag_lower in base:
                    cat = 1
                else:
                    cat = 2
                # preserve original FuzzyCompleter's order in the same category
                return (cat,)

            candidates.sort(key=_rank)
            yield from candidates
        finally:
            self._fragment_hint = None


class _HistoryEntry(BaseModel):
    content: str


def _load_history_entries(history_file: Path) -> list[_HistoryEntry]:
    entries: list[_HistoryEntry] = []
    if not history_file.exists():
        return entries

    try:
        with history_file.open(encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(
                        "Failed to parse user history line; skipping: {line}",
                        line=line,
                    )
                    continue
                try:
                    entry = _HistoryEntry.model_validate(record)
                    entries.append(entry)
                except ValidationError:
                    logger.warning(
                        "Failed to validate user history entry; skipping: {line}",
                        line=line,
                    )
                    continue
    except OSError as exc:
        logger.warning(
            "Failed to load user history file: {file} ({error})",
            file=history_file,
            error=exc,
        )

    return entries


class PromptMode(Enum):
    AGENT = "agent"
    SHELL = "shell"

    def toggle(self) -> PromptMode:
        return PromptMode.SHELL if self == PromptMode.AGENT else PromptMode.AGENT

    def __str__(self) -> str:
        return self.value


class UserInput(BaseModel):
    mode: PromptMode
    command: str
    """The plain text representation of the user input."""
    resolved_command: str
    """The text command after UI-only placeholders are expanded."""
    content: list[ContentPart]
    """The rich content parts."""

    def __str__(self) -> str:
        return self.command

    def __bool__(self) -> bool:
        return bool(self.command)


_IDLE_REFRESH_INTERVAL = 1.0
_RUNNING_REFRESH_INTERVAL = 0.1


@dataclass(slots=True)
class _ToastEntry:
    topic: str | None
    """There can be only one toast of each non-None topic in the queue."""
    message: str
    expires_at: float


class RunningPromptDelegate(Protocol):
    def render_running_prompt_body(self, columns: int) -> AnyFormattedText: ...

    def running_prompt_placeholder(self) -> AnyFormattedText | None: ...

    def should_handle_running_prompt_key(self, key: str) -> bool: ...

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None: ...


_toast_queues: dict[Literal["left", "right"], deque[_ToastEntry]] = {
    "left": deque(),
    "right": deque(),
}
"""The queue of toasts to show, including the one currently being shown (the first one)."""


def toast(
    message: str,
    duration: float = 5.0,
    topic: str | None = None,
    immediate: bool = False,
    position: Literal["left", "right"] = "left",
) -> None:
    queue = _toast_queues[position]
    duration = max(duration, _IDLE_REFRESH_INTERVAL)
    entry = _ToastEntry(topic=topic, message=message, expires_at=time.monotonic() + duration)
    if topic is not None:
        # Remove existing toasts with the same topic
        for existing in list(queue):
            if existing.topic == topic:
                queue.remove(existing)
    if immediate:
        queue.appendleft(entry)
    else:
        queue.append(entry)


def _current_toast(position: Literal["left", "right"] = "left") -> _ToastEntry | None:
    queue = _toast_queues[position]
    now = time.monotonic()
    while queue and queue[0].expires_at <= now:
        queue.popleft()
    if not queue:
        return None
    return queue[0]


def _pct_color(pct: int) -> str:
    """Return a prompt_toolkit style color string based on usage percentage."""
    if pct >= 90:
        return "fg:#ff5555"
    if pct >= 70:
        return "fg:#ffaa00"
    if pct >= 50:
        return "fg:#e6c800"
    return "fg:#00af5f"


def _build_context_bar(pct: int, width: int = 10) -> list[tuple[str, str]]:
    """Build a colored block-character progress bar as FormattedText fragments."""
    pct = max(0, min(100, pct))
    filled = pct * width // 100
    empty = width - filled
    result: list[tuple[str, str]] = []
    if filled:
        result.append((_pct_color(pct), "█" * filled))
    if empty:
        result.append(("fg:#4d4d4d", "░" * empty))
    return result


def _format_elapsed(seconds: float) -> str:
    """Format elapsed seconds as compact duration string."""
    if seconds < 60:
        return "<1m"
    minutes = int(seconds / 60)
    if minutes < 60:
        return f"{minutes}m"
    hours, mins = divmod(minutes, 60)
    return f"{hours}h {mins}m" if mins else f"{hours}h"


def _build_toolbar_tips(clipboard_available: bool) -> list[str]:
    tips = [
        "ctrl-x: toggle mode",
        "shift-tab: plan mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
    ]
    if clipboard_available:
        tips.append("ctrl-v: paste clipboard")
    tips.append("@: mention files")
    return tips


_TIP_SEPARATOR = " | "


class CustomPromptSession:
    def __init__(
        self,
        *,
        status_provider: Callable[[], StatusSnapshot],
        status_block_provider: Callable[[int], AnyFormattedText | None] | None = None,
        fast_refresh_provider: Callable[[], bool] | None = None,
        model_capabilities: set[ModelCapability],
        model_name: str | None,
        thinking: bool,
        agent_mode_slash_commands: Sequence[SlashCommand[Any]],
        shell_mode_slash_commands: Sequence[SlashCommand[Any]],
        editor_command_provider: Callable[[], str] = lambda: "",
        plan_mode_toggle_callback: Callable[[], Awaitable[bool]] | None = None,
    ) -> None:
        history_dir = get_share_dir() / "user-history"
        history_dir.mkdir(parents=True, exist_ok=True)
        work_dir_id = md5(str(KaosPath.cwd()).encode(encoding="utf-8")).hexdigest()
        self._history_file = (history_dir / work_dir_id).with_suffix(".jsonl")
        self._status_provider = status_provider
        self._status_block_provider = status_block_provider
        self._fast_refresh_provider = fast_refresh_provider
        self._editor_command_provider = editor_command_provider
        self._plan_mode_toggle_callback = plan_mode_toggle_callback
        self._model_capabilities = model_capabilities
        self._model_name = model_name
        self._last_history_content: str | None = None
        self._mode: PromptMode = PromptMode.AGENT
        self._thinking = thinking
        self._placeholder_manager = PromptPlaceholderManager()
        # Keep the old attribute for test compatibility and for any external imports.
        self._attachment_cache = self._placeholder_manager.attachment_cache
        self._tip_rotation_index: int = 0
        self._session_start_time: float = time.monotonic()
        self._last_submission_was_running = False
        self._running_prompt_previous_mode: PromptMode | None = None
        self._running_prompt_delegate: RunningPromptDelegate | None = None
        clipboard_available = is_clipboard_available()
        self._tips = _build_toolbar_tips(clipboard_available)

        history_entries = _load_history_entries(self._history_file)
        history = InMemoryHistory()
        for entry in history_entries:
            history.append_string(entry.content)

        if history_entries:
            # for consecutive deduplication
            self._last_history_content = history_entries[-1].content

        # Build completers
        self._agent_mode_completer = merge_completers(
            [
                SlashCommandCompleter(agent_mode_slash_commands),
                # TODO(kaos): we need an async KaosFileMentionCompleter
                LocalFileMentionCompleter(KaosPath.cwd().unsafe_to_local_path()),
            ],
            deduplicate=True,
        )
        self._shell_mode_completer = SlashCommandCompleter(shell_mode_slash_commands)

        # Build key bindings
        _kb = KeyBindings()

        @_kb.add("enter", filter=has_completions)
        def _(event: KeyPressEvent) -> None:
            """Accept the first completion when Enter is pressed and completions are shown."""
            buff = event.current_buffer
            if buff.complete_state and buff.complete_state.completions:
                # Get the current completion, or use the first one if none is selected
                completion = buff.complete_state.current_completion
                if not completion:
                    completion = buff.complete_state.completions[0]
                buff.apply_completion(completion)

        @_kb.add("c-x", eager=True)
        def _(event: KeyPressEvent) -> None:
            if self._running_prompt_delegate is not None:
                return
            self._mode = self._mode.toggle()
            # Apply mode-specific settings
            self._apply_mode(event)
            # Redraw UI
            event.app.invalidate()

        @_kb.add("s-tab", eager=True)
        def _(event: KeyPressEvent) -> None:
            """Toggle plan mode with Shift+Tab."""
            if self._running_prompt_delegate is not None:
                return
            if self._plan_mode_toggle_callback is not None:

                async def _toggle() -> None:
                    assert self._plan_mode_toggle_callback is not None
                    new_state = await self._plan_mode_toggle_callback()
                    if new_state:
                        toast("plan mode ON", topic="plan_mode", duration=3.0, immediate=True)
                    else:
                        toast("plan mode OFF", topic="plan_mode", duration=3.0, immediate=True)
                    event.app.invalidate()

                event.app.create_background_task(_toggle())
            event.app.invalidate()

        @_kb.add("escape", "enter", eager=True)
        @_kb.add("c-j", eager=True)
        def _(event: KeyPressEvent) -> None:
            """Insert a newline when Alt-Enter or Ctrl-J is pressed."""
            event.current_buffer.insert_text("\n")

        @_kb.add("c-o", eager=True)
        def _(event: KeyPressEvent) -> None:
            """Open current buffer in external editor."""
            self._open_in_external_editor(event)

        @_kb.add(
            "up",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("up")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("up", event)

        @_kb.add(
            "down",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("down")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("down", event)

        @_kb.add(
            "left",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("left")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("left", event)

        @_kb.add(
            "right",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("right")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("right", event)

        @_kb.add(
            "tab",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("tab")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("tab", event)

        @_kb.add(
            "enter",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("enter")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("enter", event)

        @_kb.add(
            "space",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("space")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("space", event)

        @_kb.add(
            "c-e",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("c-e")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("c-e", event)

        @_kb.add(
            "escape",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("escape")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("escape", event)

        @_kb.add(
            "1",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("1")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("1", event)

        @_kb.add(
            "2",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("2")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("2", event)

        @_kb.add(
            "3",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("3")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("3", event)

        @_kb.add(
            "4",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("4")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("4", event)

        @_kb.add(
            "5",
            eager=True,
            filter=Condition(lambda: self._should_handle_running_prompt_key("5")),
        )
        def _(event: KeyPressEvent) -> None:
            self._handle_running_prompt_key("5", event)

        @_kb.add(Keys.BracketedPaste, eager=True)
        def _(event: KeyPressEvent) -> None:
            self._handle_bracketed_paste(event)

        if clipboard_available:

            @_kb.add("c-v", eager=True)
            def _(event: KeyPressEvent) -> None:
                if self._try_paste_media(event):
                    return
                clipboard_data = event.app.clipboard.get_data()
                if clipboard_data is None:  # type: ignore[reportUnnecessaryComparison]
                    return
                self._insert_pasted_text(event.current_buffer, clipboard_data.text)
                event.app.invalidate()

            clipboard = PyperclipClipboard()
        else:
            clipboard = None

        self._session = PromptSession[str](
            message=self._render_message,
            # prompt_continuation=FormattedText([("fg:#4d4d4d", "... ")]),
            completer=self._agent_mode_completer,
            complete_while_typing=True,
            reserve_space_for_menu=10,
            key_bindings=_kb,
            clipboard=clipboard,
            history=history,
            bottom_toolbar=self._render_bottom_toolbar,
            style=Style.from_dict(
                {
                    "bottom-toolbar": "noreverse",
                    "running-prompt-placeholder": "fg:#7c8594 italic",
                    "running-prompt-separator": "fg:#4a5568",
                    "slash-completion-menu": "",
                    "slash-completion-menu.separator": "fg:#4a5568",
                    "slash-completion-menu.marker": "fg:#4a5568",
                    "slash-completion-menu.marker.current": "fg:#4f9fff",
                    "slash-completion-menu.command": "fg:#a6adba",
                    "slash-completion-menu.meta": "fg:#7c8594",
                    "slash-completion-menu.command.current": "fg:#6fb7ff bold",
                    "slash-completion-menu.meta.current": "fg:#56a4ff",
                }
            ),
        )
        self._install_slash_completion_menu()
        self._apply_mode()

        # Allow completion to be triggered when the text is changed,
        # such as when backspace is used to delete text.
        @self._session.default_buffer.on_text_changed.add_handler
        def _(buffer: Buffer) -> None:
            if buffer.complete_while_typing():
                buffer.start_completion()

        self._status_refresh_task: asyncio.Task[None] | None = None

    def _install_slash_completion_menu(self) -> None:
        float_container = _find_prompt_float_container(self._session.layout.container)
        if not isinstance(float_container, FloatContainer):
            return

        slash_menu_filter = (
            has_focus(self._session.default_buffer)
            & has_completions
            & ~is_done
            & Condition(self._should_show_slash_completion_menu)
        )
        slash_menu = ConditionalContainer(
            Window(
                content=SlashCommandMenuControl(left_padding=self._slash_menu_left_padding),
                dont_extend_height=True,
                height=Dimension(max=10),
                style="class:slash-completion-menu",
            ),
            filter=slash_menu_filter,
        )
        float_container.floats.insert(
            0,
            Float(
                left=0,
                right=0,
                ycursor=True,
                content=slash_menu,
                z_index=10**8,
            ),
        )

        original_float = next(
            (
                float_
                for float_ in float_container.floats[1:]
                if isinstance(float_.content, CompletionsMenu)
            ),
            None,
        )
        if original_float is None:
            return
        original_float.content = ConditionalContainer(
            original_float.content,
            filter=~Condition(self._should_show_slash_completion_menu),
        )

    def _should_show_slash_completion_menu(self) -> bool:
        document = self._session.default_buffer.document
        return SlashCommandCompleter.should_complete(document)

    def _slash_menu_left_padding(self) -> int:
        if self._mode == PromptMode.SHELL:
            return max(1, get_cwidth(f"{PROMPT_SYMBOL_SHELL} ") - 2)
        if self._status_provider().plan_mode:
            return max(1, get_cwidth(f"{PROMPT_SYMBOL_PLAN} ") - 2)
        symbol = PROMPT_SYMBOL_THINKING if self._thinking else PROMPT_SYMBOL
        return max(1, get_cwidth(f"{symbol} ") - 2)

    def _render_message(self) -> FormattedText:
        if self._mode == PromptMode.SHELL:
            return self._render_shell_prompt_message()
        return self._render_agent_prompt_message()

    def _render_shell_prompt_message(self) -> FormattedText:
        app = get_app_or_none()
        columns = app.output.get_size().columns if app is not None else 80
        fragments: FormattedText = FormattedText()
        body = self._render_status_block(columns)
        if body:
            fragments.extend(body)
            if not body[-1][1].endswith("\n"):
                fragments.append(("", "\n"))
            fragments.append(("", "\n"))
            fragments.append(("class:running-prompt-separator", "─" * max(0, columns)))
            fragments.append(("", "\n"))
        fragments.append(("bold", f"{PROMPT_SYMBOL_SHELL} "))
        return fragments

    def _open_in_external_editor(self, event: KeyPressEvent) -> None:
        """Open the current buffer content in an external editor."""
        from prompt_toolkit.application.run_in_terminal import run_in_terminal

        from kimi_cli.utils.editor import edit_text_in_editor, get_editor_command

        configured = self._editor_command_provider()

        if get_editor_command(configured) is None:
            toast("No editor found. Set $VISUAL/$EDITOR or run /editor.")
            return

        buff = event.current_buffer
        original_text = buff.text
        editor_text = self._get_placeholder_manager().expand_for_editor(original_text)

        async def _run_editor() -> None:
            result = await run_in_terminal(
                lambda: edit_text_in_editor(editor_text, configured), in_executor=True
            )
            if result is not None:
                refolded = self._get_placeholder_manager().refold_after_editor(
                    result, original_text
                )
                buff.document = Document(text=refolded, cursor_position=len(refolded))

        event.app.create_background_task(_run_editor())

    def _apply_mode(self, event: KeyPressEvent | None = None) -> None:
        # Apply mode to the active buffer (not the PromptSession itself)
        try:
            buff = event.current_buffer if event is not None else self._session.default_buffer
        except Exception:
            buff = None

        if self._mode == PromptMode.SHELL:
            if buff is not None:
                buff.completer = self._shell_mode_completer
        else:
            if buff is not None:
                buff.completer = self._agent_mode_completer
        self._sync_erase_when_done()

    def _sync_erase_when_done(self) -> None:
        app = getattr(self._session, "app", None)
        if app is not None:
            app.erase_when_done = self._mode == PromptMode.AGENT

    def _should_handle_running_prompt_key(self, key: str) -> bool:
        running_prompt = getattr(self, "_running_prompt_delegate", None)
        return running_prompt is not None and running_prompt.should_handle_running_prompt_key(key)

    def _handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        running_prompt = self._running_prompt_delegate
        if running_prompt is None:
            return
        running_prompt.handle_running_prompt_key(key, event)
        event.app.invalidate()

    def invalidate(self) -> None:
        app = get_app_or_none()
        if app is not None:
            app.invalidate()

    def _render_agent_prompt_message(self) -> FormattedText:
        app = get_app_or_none()
        columns = app.output.get_size().columns if app is not None else 80
        fragments: FormattedText = FormattedText()
        body = self._render_agent_prompt_body(columns)
        if body:
            fragments.extend(body)
            if not body[-1][1].endswith("\n"):
                fragments.append(("", "\n"))
        fragments.append(("", "\n"))
        fragments.append(("class:running-prompt-separator", "─" * max(0, columns)))
        fragments.append(("", "\n"))
        fragments.extend(self._render_agent_prompt_label())
        return fragments

    def _render_agent_prompt_body(self, columns: int) -> FormattedText:
        running_prompt = self._running_prompt_delegate
        if running_prompt is None:
            return self._render_status_block(columns)
        return to_formatted_text(running_prompt.render_running_prompt_body(columns))

    def _render_status_block(self, columns: int) -> FormattedText:
        status_block_provider = getattr(self, "_status_block_provider", None)
        if status_block_provider is None:
            return FormattedText([])
        block = status_block_provider(columns)
        if block is None:
            return FormattedText([])
        return to_formatted_text(block)

    def _render_agent_prompt_label(self) -> FormattedText:
        status = self._status_provider()
        if status.plan_mode:
            return FormattedText([("fg:#00aaff", f"{PROMPT_SYMBOL_PLAN} ")])
        symbol = PROMPT_SYMBOL_THINKING if self._thinking else PROMPT_SYMBOL
        return FormattedText([("", f"{symbol} ")])

    def __enter__(self) -> CustomPromptSession:
        if self._status_refresh_task is not None and not self._status_refresh_task.done():
            return self

        async def _refresh() -> None:
            try:
                while True:
                    app = get_app_or_none()
                    if app is not None:
                        app.invalidate()

                    try:
                        asyncio.get_running_loop()
                    except RuntimeError:
                        logger.warning("No running loop found, exiting status refresh task")
                        self._status_refresh_task = None
                        break

                    interval = (
                        _RUNNING_REFRESH_INTERVAL
                        if self._running_prompt_delegate is not None
                        or (
                            self._fast_refresh_provider is not None
                            and self._fast_refresh_provider()
                        )
                        else _IDLE_REFRESH_INTERVAL
                    )
                    await asyncio.sleep(interval)
            except asyncio.CancelledError:
                # graceful exit
                pass

        self._status_refresh_task = asyncio.create_task(_refresh())
        return self

    def __exit__(self, *_) -> None:
        if self._status_refresh_task is not None and not self._status_refresh_task.done():
            self._status_refresh_task.cancel()
        self._status_refresh_task = None

    def _get_placeholder_manager(self) -> PromptPlaceholderManager:
        manager = getattr(self, "_placeholder_manager", None)
        if manager is None:
            attachment_cache = getattr(self, "_attachment_cache", None)
            manager = PromptPlaceholderManager(attachment_cache=attachment_cache)
            self._placeholder_manager = manager
            self._attachment_cache = manager.attachment_cache
        return manager

    def _insert_pasted_text(self, buffer: Buffer, text: str) -> None:
        normalized = normalize_pasted_text(text)
        if self._mode != PromptMode.AGENT:
            buffer.insert_text(normalized)
            return
        token_or_text = self._get_placeholder_manager().maybe_placeholderize_pasted_text(normalized)
        buffer.insert_text(token_or_text)

    def _handle_bracketed_paste(self, event: KeyPressEvent) -> None:
        self._insert_pasted_text(event.current_buffer, event.data)
        event.app.invalidate()

    def _try_paste_media(self, event: KeyPressEvent) -> bool:
        """Try to paste media from the clipboard.

        Reads the clipboard once and handles all detected content:
        non-image files (videos, PDFs, etc.) are inserted as paths,
        image files are cached and inserted as placeholders.
        Returns True if any media content was inserted.
        """
        result = grab_media_from_clipboard()
        if result is None:
            return False

        parts: list[str] = []

        # 1. Insert file paths (videos, PDFs, etc.)
        if result.file_paths:
            logger.debug("Pasted {count} file path(s) from clipboard", count=len(result.file_paths))
            for p in result.file_paths:
                text = str(p)
                if self._mode == PromptMode.SHELL:
                    text = shlex.quote(text)
                parts.append(text)

        # 2. Insert images via cache.
        if result.images:
            if "image_in" not in self._model_capabilities:
                console.print(
                    "[yellow]Image input is not supported by the selected LLM model[/yellow]"
                )
            else:
                for image in result.images:
                    token = self._get_placeholder_manager().create_image_placeholder(image)
                    if token is None:
                        continue
                    logger.debug(
                        "Pasted image from clipboard placeholder: {token}, {image_size}",
                        token=token,
                        image_size=image.size,
                    )
                    parts.append(token)

        if parts:
            event.current_buffer.insert_text(" ".join(parts))
        event.app.invalidate()
        return bool(parts)

    async def prompt_next(self) -> UserInput:
        return await self._prompt_once(append_history=None)

    @property
    def last_submission_was_running(self) -> bool:
        return getattr(self, "_last_submission_was_running", False)

    def attach_running_prompt(self, delegate: RunningPromptDelegate) -> None:
        current = getattr(self, "_running_prompt_delegate", None)
        if current is delegate:
            return
        if current is None:
            self._running_prompt_previous_mode = self._mode
        self._running_prompt_delegate = delegate
        self._mode = PromptMode.AGENT
        self._apply_mode()
        self.invalidate()

    def detach_running_prompt(self, delegate: RunningPromptDelegate) -> None:
        if getattr(self, "_running_prompt_delegate", None) is not delegate:
            return
        previous_mode = getattr(self, "_running_prompt_previous_mode", None)
        self._running_prompt_delegate = None
        self._running_prompt_previous_mode = None
        if previous_mode is not None:
            self._mode = previous_mode
        self._apply_mode()
        self.invalidate()

    async def _prompt_once(self, *, append_history: bool | None) -> UserInput:
        placeholder = None
        if self._running_prompt_delegate is not None:
            placeholder = self._running_prompt_delegate.running_prompt_placeholder()
        with patch_stdout(raw=True):
            command = str(await self._session.prompt_async(placeholder=placeholder)).strip()
            command = command.replace("\x00", "")  # just in case null bytes are somehow inserted
            # Sanitize UTF-16 surrogates that may come from Windows clipboard
            command = sanitize_surrogates(command)
        was_running = self._running_prompt_delegate is not None
        self._last_submission_was_running = was_running
        if append_history is None:
            append_history = not was_running
        if append_history:
            self._append_history_entry(command)
        self._tip_rotation_index += 1
        return self._build_user_input(command)

    def _build_user_input(self, command: str) -> UserInput:
        resolved = self._get_placeholder_manager().resolve_command(command)

        return UserInput(
            mode=self._mode,
            command=resolved.display_command,
            resolved_command=resolved.resolved_text,
            content=resolved.content,
        )

    def _append_history_entry(self, text: str) -> None:
        safe_history_text = self._get_placeholder_manager().serialize_for_history(text).strip()
        entry = _HistoryEntry(content=safe_history_text)
        if not entry.content:
            return

        # skip if same as last entry
        if entry.content == self._last_history_content:
            return

        try:
            self._history_file.parent.mkdir(parents=True, exist_ok=True)
            with self._history_file.open("a", encoding="utf-8") as f:
                f.write(entry.model_dump_json(ensure_ascii=False) + "\n")
            self._last_history_content = entry.content
        except OSError as exc:
            logger.warning(
                "Failed to append user history entry: {file} ({error})",
                file=self._history_file,
                error=exc,
            )

    def _render_bottom_toolbar(self) -> FormattedText:
        app = get_app_or_none()
        assert app is not None
        columns = app.output.get_size().columns
        status = self._status_provider()

        fragments: list[tuple[str, str]] = []

        # ── Line 1: divider ─────────────────────────────────────────────
        fragments.append(("fg:#4d4d4d", "─" * columns))
        fragments.append(("", "\n"))

        # ── Line 2: main status ─────────────────────────────────────────
        # [model · thinking] or [shell]
        if self._mode == PromptMode.SHELL:
            model_label = "shell"
        else:
            model_label = self._model_name or "kimi"
            if self._thinking:
                model_label += " · thinking"

        fragments.extend(
            [
                ("fg:#4d9de0", "["),
                ("bold fg:#4d9de0", model_label),
                ("fg:#4d9de0", "] "),
            ]
        )
        used = len(model_label) + 3  # "[" + label + "] "

        # Context bar + percentage + token count
        pct_int = int(max(0.0, min(status.context_usage, 1.0)) * 100)
        fragments.extend(_build_context_bar(pct_int))
        pct_str = f" {pct_int}%"
        fragments.append((_pct_color(pct_int) + " bold", pct_str))
        used += 10 + len(pct_str)  # bar chars + " X%"
        if status.context_tokens > 0 and status.max_context_tokens > 0:
            ctx_detail = (
                f" ({format_token_count(status.context_tokens)}"
                f"/{format_token_count(status.max_context_tokens)})"
            )
            fragments.append(("fg:#666666", ctx_detail))
            used += len(ctx_detail)

        _SEP = ("fg:#4d4d4d", " │")
        _SEP_LEN = 2

        # Token stats (cumulative)
        if status.total_token_usage is not None and status.total_token_usage.total > 0:
            tu = status.total_token_usage
            tok_str = f" in:{format_token_count(tu.input)} out:{format_token_count(tu.output)}"
            fragments.extend([_SEP, ("fg:#aaaaaa", tok_str)])
            used += _SEP_LEN + len(tok_str)

        # Session timer
        session_start = getattr(self, "_session_start_time", time.monotonic())
        elapsed_str = _format_elapsed(time.monotonic() - session_start)
        timer_str = f" {elapsed_str}"
        fragments.extend([_SEP, ("fg:#666666", timer_str)])
        used += _SEP_LEN + len(timer_str)

        # Tips — fill remaining space
        available = columns - used - 2
        if available > 6:
            current_toast_left = _current_toast("left")
            if current_toast_left is not None:
                tip_text: str | None = current_toast_left.message[:available]
            else:
                n = len(self._tips)
                offset = self._tip_rotation_index % n
                rotated = self._tips[offset:] + self._tips[:offset]
                selected: list[str] = []
                total_len = 0
                for tip in rotated:
                    needed = len(tip) + (len(_TIP_SEPARATOR) if selected else 0)
                    if total_len + needed <= available:
                        selected.append(tip)
                        total_len += needed
                tip_text = _TIP_SEPARATOR.join(selected) if selected else None
            if tip_text:
                fragments.extend([("", "  "), ("fg:#555555", tip_text)])

        # Right-position toasts (e.g., MCP status messages)
        current_toast_right = _current_toast("right")
        if current_toast_right is not None:
            right_msg = f" {current_toast_right.message}"
            fragments.extend([_SEP, ("fg:#aaaaaa", right_msg)])

        # ── Line 3: yolo / plan mode indicator ──────────────────────────
        if status.yolo_enabled:
            fragments.append(("", "\n"))
            fragments.extend(
                [
                    ("fg:#ff4444", "►► "),
                    ("bold fg:#ff4444", "bypass permissions on"),
                    ("fg:#666666", " (shift+tab to cycle)"),
                ]
            )
        elif status.plan_mode:
            fragments.append(("", "\n"))
            fragments.extend(
                [
                    ("fg:#4d9de0", "►► "),
                    ("bold fg:#4d9de0", "plan mode"),
                    ("fg:#666666", " (shift+tab to exit)"),
                ]
            )

        # ── Line 4+: daily / weekly token stats ─────────────────────────
        def _ledger_line(label: str, usage: TokenUsage) -> list[tuple[str, str]]:
            total = format_token_count(usage.total)
            in_fmt = format_token_count(usage.input)
            out_fmt = format_token_count(usage.output)
            return [
                ("fg:#555555", f"  {label:<6}"),
                ("fg:#aaaaaa", f" {total:>6}"),
                ("fg:#666666", f"  in:{in_fmt} out:{out_fmt}"),
            ]

        if status.daily_token_usage is not None:
            fragments.append(("", "\n"))
            fragments.extend(_ledger_line("today", status.daily_token_usage))
        if status.weekly_token_usage is not None:
            fragments.append(("", "\n"))
            fragments.extend(_ledger_line("week", status.weekly_token_usage))

        return FormattedText(fragments)

    @staticmethod
    def _render_right_span(status: StatusSnapshot) -> str:
        # Retained for backward compatibility; toolbar no longer calls this directly.
        current_toast = _current_toast("right")
        if current_toast is None:
            return format_context_status(
                status.context_usage,
                status.context_tokens,
                status.max_context_tokens,
                status.total_token_usage,
            )
        return current_toast.message
