from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import re
import shlex
import time
from collections import deque
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from enum import Enum
from hashlib import md5, sha256
from io import BytesIO
from pathlib import Path
from typing import Any, Literal, Protocol, override

from kaos.path import KaosPath
from PIL import Image
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
from prompt_toolkit.document import Document
from prompt_toolkit.filters import Condition, has_completions
from prompt_toolkit.formatted_text import AnyFormattedText, FormattedText, to_formatted_text
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.styles import Style
from pydantic import BaseModel, ValidationError

from kimi_cli.llm import ModelCapability
from kimi_cli.share import get_share_dir
from kimi_cli.soul import StatusSnapshot, format_context_status
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.clipboard import (
    grab_media_from_clipboard,
    is_clipboard_available,
)
from kimi_cli.utils.logging import logger
from kimi_cli.utils.media_tags import wrap_media_part
from kimi_cli.utils.slashcmd import SlashCommand
from kimi_cli.utils.string import random_string
from kimi_cli.wire.types import ContentPart, ImageURLPart, TextPart

PROMPT_SYMBOL = "✨"
PROMPT_SYMBOL_SHELL = "$"
PROMPT_SYMBOL_THINKING = "💫"
PROMPT_SYMBOL_PLAN = "📋"


class SlashCommandCompleter(Completer):
    """
    A completer that:
    - Shows one line per slash command in the form: "/name (alias1, alias2)"
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

    @override
    def get_completions(
        self, document: Document, complete_event: CompleteEvent
    ) -> Iterable[Completion]:
        text = document.text_before_cursor

        # Only autocomplete when the input buffer has no other content.
        if document.text_after_cursor.strip():
            return

        # Only consider the last token (allowing future arguments after a space)
        last_space = text.rfind(" ")
        token = text[last_space + 1 :]
        prefix = text[: last_space + 1] if last_space != -1 else ""

        if prefix.strip():
            return
        if not token.startswith("/"):
            return

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
                    display=cmd.slash_name(),
                    display_meta=cmd.description,
                )


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


def _build_toolbar_tips(clipboard_available: bool) -> list[str]:
    tips = [
        "ctrl-x: toggle mode",
        "shift-tab: plan mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
    ]
    if clipboard_available:
        tips.append("ctrl-v: paste media")
    tips.append("@: mention files")
    return tips


_TIP_SEPARATOR = " | "


_ATTACHMENT_PLACEHOLDER_RE = re.compile(
    r"\[(?P<type>[a-zA-Z0-9_\-]+):(?P<id>[a-zA-Z0-9_\-\.]+)"
    r"(?:,(?P<width>\d+)x(?P<height>\d+))?\]"
)


def _guess_image_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    if mime:
        return mime
    # fallback to PNG
    return "image/png"


def _build_image_part(image_bytes: bytes, mime_type: str) -> ImageURLPart:
    image_base64 = base64.b64encode(image_bytes).decode("ascii")
    return ImageURLPart(
        image_url=ImageURLPart.ImageURL(
            url=f"data:{mime_type};base64,{image_base64}",
        )
    )


type CachedAttachmentKind = Literal["image"]


@dataclass(slots=True)
class CachedAttachment:
    kind: CachedAttachmentKind
    attachment_id: str
    path: Path


class AttachmentCache:
    def __init__(self, root: Path | None = None) -> None:
        self._root = root or Path("/tmp/kimi")
        self._dir_map: dict[CachedAttachmentKind, str] = {"image": "images"}
        self._payload_map: dict[tuple[CachedAttachmentKind, str, str], CachedAttachment] = {}

    def _dir_for(self, kind: CachedAttachmentKind) -> Path:
        return self._root / self._dir_map[kind]

    def _ensure_dir(self, kind: CachedAttachmentKind) -> Path | None:
        path = self._dir_for(kind)
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning(
                "Failed to create attachment cache dir: {dir} ({error})",
                dir=path,
                error=exc,
            )
            return None
        return path

    def _reserve_id(self, dir_path: Path, suffix: str) -> str:
        for _ in range(5):
            candidate = f"{random_string(8)}{suffix}"
            if not (dir_path / candidate).exists():
                return candidate
        return f"{random_string(12)}{suffix}"

    def store_bytes(
        self, kind: CachedAttachmentKind, suffix: str, payload: bytes
    ) -> CachedAttachment | None:
        dir_path = self._ensure_dir(kind)
        if dir_path is None:
            return None
        payload_hash = sha256(payload).hexdigest()
        cache_key = (kind, suffix, payload_hash)
        cached = self._payload_map.get(cache_key)
        if cached is not None:
            if cached.path.exists():
                return cached
            self._payload_map.pop(cache_key, None)

        attachment_id = self._reserve_id(dir_path, suffix)
        path = dir_path / attachment_id
        try:
            path.write_bytes(payload)
        except OSError as exc:
            logger.warning(
                "Failed to write cached attachment: {file} ({error})",
                file=path,
                error=exc,
            )
            return None
        cached = CachedAttachment(kind=kind, attachment_id=attachment_id, path=path)
        self._payload_map[cache_key] = cached
        return cached

    def store_image(self, image: Image.Image) -> CachedAttachment | None:
        png_bytes = BytesIO()
        image.save(png_bytes, format="PNG")
        return self.store_bytes("image", ".png", png_bytes.getvalue())

    def load_bytes(
        self, kind: CachedAttachmentKind, attachment_id: str
    ) -> tuple[Path, bytes] | None:
        path = self._dir_for(kind) / attachment_id
        if not path.exists():
            return None
        try:
            return path, path.read_bytes()
        except OSError as exc:
            logger.warning(
                "Failed to read cached attachment: {file} ({error})",
                file=path,
                error=exc,
            )
            return None

    def load_content_parts(
        self, kind: CachedAttachmentKind, attachment_id: str
    ) -> list[ContentPart] | None:
        if kind == "image":
            payload = self.load_bytes(kind, attachment_id)
            if payload is None:
                return None
            path, image_bytes = payload
            mime_type = _guess_image_mime(path)
            part = _build_image_part(image_bytes, mime_type)
            return wrap_media_part(part, tag="image", attrs={"path": str(path)})
        return None


def _parse_attachment_kind(raw_kind: str) -> CachedAttachmentKind | None:
    if raw_kind == "image":
        return "image"
    return None


def _sanitize_surrogates(text: str) -> str:
    """Sanitize UTF-16 surrogate characters that cannot be encoded to UTF-8.

    This is particularly common on Windows when copying text from applications
    that use UTF-16 internally and don't properly convert surrogate pairs.
    """
    return text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="replace")


class CustomPromptSession:
    def __init__(
        self,
        *,
        status_provider: Callable[[], StatusSnapshot],
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
        self._editor_command_provider = editor_command_provider
        self._plan_mode_toggle_callback = plan_mode_toggle_callback
        self._model_capabilities = model_capabilities
        self._model_name = model_name
        self._last_history_content: str | None = None
        self._mode: PromptMode = PromptMode.AGENT
        self._thinking = thinking
        self._attachment_cache = AttachmentCache()
        self._tip_rotation_index: int = 0
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

        if clipboard_available:

            @_kb.add("c-v", eager=True)
            def _(event: KeyPressEvent) -> None:
                if self._try_paste_media(event):
                    return
                clipboard_data = event.app.clipboard.get_data()
                if clipboard_data is None:  # type: ignore[reportUnnecessaryComparison]
                    return
                event.current_buffer.paste_clipboard_data(clipboard_data)

            clipboard = PyperclipClipboard()
        else:
            clipboard = None

        self._session = PromptSession[str](
            message=self._render_message,
            # prompt_continuation=FormattedText([("fg:#4d4d4d", "... ")]),
            completer=self._agent_mode_completer,
            complete_while_typing=True,
            key_bindings=_kb,
            clipboard=clipboard,
            history=history,
            bottom_toolbar=self._render_bottom_toolbar,
            style=Style.from_dict(
                {
                    "bottom-toolbar": "noreverse",
                    "running-prompt-placeholder": "fg:#6f7682 italic",
                    "running-prompt-separator": "fg:#667085",
                }
            ),
        )
        self._apply_mode()

        # Allow completion to be triggered when the text is changed,
        # such as when backspace is used to delete text.
        @self._session.default_buffer.on_text_changed.add_handler
        def _(buffer: Buffer) -> None:
            if buffer.complete_while_typing():
                buffer.start_completion()

        self._status_refresh_task: asyncio.Task[None] | None = None

    def _render_message(self) -> FormattedText:
        if self._mode == PromptMode.SHELL:
            return FormattedText([("bold", f"{PROMPT_SYMBOL_SHELL} ")])
        return self._render_agent_prompt_message()

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

        async def _run_editor() -> None:
            result = await run_in_terminal(
                lambda: edit_text_in_editor(original_text, configured), in_executor=True
            )
            if result is not None:
                buff.document = Document(text=result, cursor_position=len(result))

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
            return FormattedText([])
        return to_formatted_text(running_prompt.render_running_prompt_body(columns))

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

    def _try_paste_media(self, event: KeyPressEvent) -> bool:
        """Try to paste media from the clipboard.

        Reads the clipboard once and handles all detected content:
        non-image files (videos, PDFs, etc.) are inserted as paths,
        image files are cached and inserted as placeholders.
        Returns True if any media was detected.
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
                    cached = self._attachment_cache.store_image(image)
                    if cached is None:
                        continue
                    logger.debug(
                        "Pasted image from clipboard: {attachment_id}, {image_size}",
                        attachment_id=cached.attachment_id,
                        image_size=image.size,
                    )
                    parts.append(f"[image:{cached.attachment_id},{image.width}x{image.height}]")

        if parts:
            event.current_buffer.insert_text(" ".join(parts))
        event.app.invalidate()
        return bool(parts)

    async def prompt(self) -> UserInput:
        return await self._prompt_once(append_history=True)

    async def prompt_steer(self, delegate: RunningPromptDelegate) -> UserInput:
        previous_mode = self._mode
        self._running_prompt_delegate = delegate
        self._mode = PromptMode.AGENT
        self._apply_mode()
        self.invalidate()
        try:
            return await self._prompt_once(append_history=False)
        finally:
            self._mode = previous_mode
            self._running_prompt_delegate = None
            self._apply_mode()
            self.invalidate()

    async def _prompt_once(self, *, append_history: bool) -> UserInput:
        placeholder = None
        if self._running_prompt_delegate is not None:
            placeholder = self._running_prompt_delegate.running_prompt_placeholder()
        with patch_stdout(raw=True):
            command = str(await self._session.prompt_async(placeholder=placeholder)).strip()
            command = command.replace("\x00", "")  # just in case null bytes are somehow inserted
            # Sanitize UTF-16 surrogates that may come from Windows clipboard
            command = _sanitize_surrogates(command)
        if append_history:
            self._append_history_entry(command)
        self._tip_rotation_index += 1
        return self._build_user_input(command)

    def _build_user_input(self, command: str) -> UserInput:
        content: list[ContentPart] = []
        remaining_command = command
        while match := _ATTACHMENT_PLACEHOLDER_RE.search(remaining_command):
            start, end = match.span()
            if start > 0:
                content.append(TextPart(text=remaining_command[:start]))
            attachment_id = match.group("id")
            attachment_kind = _parse_attachment_kind(match.group("type"))
            part = None
            if attachment_kind is not None:
                part = self._attachment_cache.load_content_parts(attachment_kind, attachment_id)
            if part is not None:
                content.extend(part)
            else:
                logger.warning(
                    "Attachment placeholder found but no matching attachment part: {placeholder}",
                    placeholder=match.group(0),
                )
                content.append(TextPart(text=match.group(0)))
            remaining_command = remaining_command[end:]

        if remaining_command:
            content.append(TextPart(text=remaining_command))

        return UserInput(
            mode=self._mode,
            content=content,
            command=command,
        )

    def _append_history_entry(self, text: str) -> None:
        entry = _HistoryEntry(content=text.strip())
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

        fragments: list[tuple[str, str]] = []

        fragments.append(("fg:#4d4d4d", "─" * columns))
        fragments.append(("", "\n"))

        mode = str(self._mode).lower()
        if self._mode == PromptMode.AGENT:
            mode_details: list[str] = []
            if self._model_name:
                mode_details.append(self._model_name)
            if self._thinking:
                mode_details.append("thinking")
            if mode_details:
                mode += f" ({', '.join(mode_details)})"
        status = self._status_provider()
        if status.yolo_enabled:
            fragments.extend([("bold fg:#ffff00", "yolo"), ("", " " * 2)])
            columns -= len("yolo") + 2
        if status.plan_mode:
            fragments.extend([("bold fg:#00aaff", "plan"), ("", " " * 2)])
            columns -= len("plan") + 2
        fragments.extend([("", f"{mode}"), ("", " " * 2)])
        columns -= len(mode) + 2
        right_text = self._render_right_span(status)

        current_toast_left = _current_toast("left")
        if current_toast_left is not None:
            fragments.extend([("", current_toast_left.message), ("", " " * 2)])
            columns -= len(current_toast_left.message) + 2
        else:
            # Reserve space for right_text, two trailing spaces after tips, and
            # at least one space of padding before right_text.
            available = columns - len(right_text) - 3
            full_text = _TIP_SEPARATOR.join(self._tips)
            if len(full_text) <= available:
                tip_text: str | None = full_text
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
                fragments.extend([("", tip_text), ("", " " * 2)])
                columns -= len(tip_text) + 2

        padding = max(1, columns - len(right_text))
        fragments.append(("", " " * padding))
        fragments.append(("", right_text))

        return FormattedText(fragments)

    @staticmethod
    def _render_right_span(status: StatusSnapshot) -> str:
        current_toast = _current_toast("right")
        if current_toast is None:
            return format_context_status(
                status.context_usage,
                status.context_tokens,
                status.max_context_tokens,
            )
        return current_toast.message
