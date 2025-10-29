import asyncio
import base64
import contextlib
import getpass
import json
import os
import re
import sys
import time
from collections.abc import Callable
from datetime import datetime
from enum import Enum
from hashlib import md5
from io import BytesIO
from pathlib import Path
from typing import override

from kosong.base.message import ContentPart, ImageURLPart, TextPart
from PIL import Image, ImageGrab
from prompt_toolkit import PromptSession
from prompt_toolkit.application.current import get_app_or_none
from prompt_toolkit.completion import (
    Completer,
    Completion,
    DummyCompleter,
    FuzzyCompleter,
    WordCompleter,
    merge_completers,
)
from prompt_toolkit.document import Document
from prompt_toolkit.filters import Always, Never, has_completions
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.patch_stdout import patch_stdout
from pydantic import BaseModel, ValidationError

from kimi_cli.share import get_share_dir
from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell.metacmd import get_meta_commands
from kimi_cli.utils.logging import logger
from kimi_cli.utils.string import random_string


class MetaCommandCompleter(Completer):
    """A completer that:
    - Shows one line per meta command in the form: "/name (alias1, alias2)"
    - Matches by primary name or any alias while inserting the canonical "/name"
    - Only activates when the current token starts with '/'
    """

    @override
    def get_completions(self, document, complete_event):
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
        typed_lower = typed.lower()

        for cmd in sorted(get_meta_commands(), key=lambda c: c.name):
            names = [cmd.name] + list(cmd.aliases)
            if typed == "" or any(n.lower().startswith(typed_lower) for n in names):
                yield Completion(
                    text=f"/{cmd.name}",
                    start_position=-len(token),
                    display=cmd.slash_name(),
                    display_meta=cmd.description,
                )


class FileMentionCompleter(Completer):
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
            if prev.isalnum() or prev in FileMentionCompleter._TRIGGER_GUARDS:
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
    def get_completions(self, document, complete_event):
        fragment = self._extract_fragment(document.text_before_cursor)
        if fragment is None:
            return
        if self._is_completed_file(fragment):
            return

        mention_doc = Document(text=fragment, cursor_position=len(fragment))
        self._fragment_hint = fragment
        try:
            yield from self._fuzzy.get_completions(mention_doc, complete_event)
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

    def toggle(self) -> "PromptMode":
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


_REFRESH_INTERVAL = 1.0
_toast_queue: asyncio.Queue[tuple[str, float]] = asyncio.Queue()


def toast(message: str, duration: float = 5.0) -> None:
    duration = max(duration, _REFRESH_INTERVAL)
    _toast_queue.put_nowait((message, duration))


_ATTACHMENT_PLACEHOLDER_RE = re.compile(
    r"\[(?P<type>image):(?P<id>[a-zA-Z0-9_\-\.]+)(?:,(?P<width>\d+)x(?P<height>\d+))?\]"
)


class CustomPromptSession:
    def __init__(self, status_provider: Callable[[], StatusSnapshot]):
        history_dir = get_share_dir() / "user-history"
        history_dir.mkdir(parents=True, exist_ok=True)
        work_dir_id = md5(str(Path.cwd()).encode()).hexdigest()
        self._history_file = (history_dir / work_dir_id).with_suffix(".jsonl")
        self._status_provider = status_provider
        self._last_history_content: str | None = None
        self._mode: PromptMode = PromptMode.AGENT
        self._attachment_parts: dict[str, ContentPart] = {}
        """Mapping from attachment id to ContentPart."""

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
                MetaCommandCompleter(),
                FileMentionCompleter(Path.cwd()),
            ],
            deduplicate=True,
        )

        # Build key bindings
        _kb = KeyBindings()

        @_kb.add("enter", filter=has_completions)
        def _accept_completion(event: KeyPressEvent) -> None:
            """Accept the first completion when Enter is pressed and completions are shown."""
            buff = event.current_buffer
            if buff.complete_state and buff.complete_state.completions:
                # Get the current completion, or use the first one if none is selected
                completion = buff.complete_state.current_completion
                if not completion:
                    completion = buff.complete_state.completions[0]
                buff.apply_completion(completion)

        @_kb.add("escape", "enter", eager=True)
        @_kb.add("c-j", eager=True)
        def _insert_newline(event: KeyPressEvent) -> None:
            """Insert a newline when Alt-Enter or Ctrl-J is pressed."""
            event.current_buffer.insert_text("\n")

        @_kb.add("c-x", eager=True)
        def _switch_mode(event: KeyPressEvent) -> None:
            self._mode = self._mode.toggle()
            # Apply mode-specific settings
            self._apply_mode(event)
            # Redraw UI
            event.app.invalidate()

        @_kb.add("c-v", eager=True)
        def _paste(event: KeyPressEvent) -> None:
            if self._try_paste_image(event):
                return
            event.current_buffer.paste_clipboard_data(event.app.clipboard.get_data())

        self._session = PromptSession(
            message=self._render_message,
            prompt_continuation=FormattedText([("fg:#4d4d4d", "... ")]),
            completer=self._agent_mode_completer,
            complete_while_typing=True,
            key_bindings=_kb,
            history=history,
            bottom_toolbar=self._render_bottom_toolbar,
        )

        self._status_refresh_task: asyncio.Task | None = None
        self._current_toast: str | None = None
        self._current_toast_duration: float = 0.0

    def _render_message(self) -> FormattedText:
        symbol = "✨" if self._mode == PromptMode.AGENT else "$"
        return FormattedText([("bold", f"{getpass.getuser()}{symbol} ")])

    def _apply_mode(self, event: KeyPressEvent | None = None) -> None:
        # Apply mode to the active buffer (not the PromptSession itself)
        try:
            buff = event.current_buffer if event is not None else self._session.default_buffer
        except Exception:
            buff = None

        if self._mode == PromptMode.SHELL:
            # Cancel any active completion menu
            with contextlib.suppress(Exception):
                if buff is not None:
                    buff.cancel_completion()
            if buff is not None:
                buff.completer = DummyCompleter()
                buff.complete_while_typing = Never()
        else:
            if buff is not None:
                buff.completer = self._agent_mode_completer
                buff.complete_while_typing = Always()

    def __enter__(self) -> "CustomPromptSession":
        if self._status_refresh_task is not None and not self._status_refresh_task.done():
            return self

        async def _refresh(interval: float) -> None:
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

                    await asyncio.sleep(interval)
            except asyncio.CancelledError:
                # graceful exit
                pass

        self._status_refresh_task = asyncio.create_task(_refresh(_REFRESH_INTERVAL))
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self._status_refresh_task is not None and not self._status_refresh_task.done():
            self._status_refresh_task.cancel()
        self._status_refresh_task = None
        self._attachment_parts.clear()

    def _try_paste_image(self, event: KeyPressEvent) -> bool:
        """Try to paste an image from the clipboard. Return True if successful."""
        # Try get image from clipboard
        image = ImageGrab.grabclipboard()
        if isinstance(image, list):
            for item in image:
                try:
                    with Image.open(item) as img:
                        image = img.copy()
                    break
                except Exception:
                    continue
            else:
                image = None

        if image is None:
            return False

        attachment_id = f"{random_string(8)}.png"
        png_bytes = BytesIO()
        image.save(png_bytes, format="PNG")
        png_base64 = base64.b64encode(png_bytes.getvalue()).decode("ascii")
        image_part = ImageURLPart(
            image_url=ImageURLPart.ImageURL(
                url=f"data:image/png;base64,{png_base64}", id=attachment_id
            )
        )
        self._attachment_parts[attachment_id] = image_part
        logger.debug(
            "Pasted image from clipboard: {attachment_id}, {image_size}",
            attachment_id=attachment_id,
            image_size=image.size,
        )

        placeholder = f"[image:{attachment_id},{image.width}x{image.height}]"
        event.current_buffer.insert_text(placeholder)
        event.app.invalidate()
        return True

    async def prompt(self) -> UserInput:
        with patch_stdout():
            command = str(await self._session.prompt_async()).strip()
        self._append_history_entry(command)

        # Parse rich content parts
        content: list[ContentPart] = []
        remaining_command = command
        while match := _ATTACHMENT_PLACEHOLDER_RE.search(remaining_command):
            start, end = match.span()
            if start > 0:
                content.append(TextPart(text=remaining_command[:start]))
            attachment_id = match.group("id")
            part = self._attachment_parts.get(attachment_id)
            if part is not None:
                content.append(part)
            else:
                logger.warning(
                    "Attachment placeholder found but no matching attachment part: {placeholder}",
                    placeholder=match.group(0),
                )
                content.append(TextPart(text=match.group(0)))
            remaining_command = remaining_command[end:]

        if remaining_command.strip():
            content.append(TextPart(text=remaining_command.strip()))

        return UserInput(mode=self._mode, content=content, command=command)

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

        now_text = datetime.now().strftime("%H:%M")
        fragments.extend([("", now_text), ("", " " * 2)])
        columns -= len(now_text) + 2

        mode = str(self._mode).lower()
        fragments.extend([("", f"{mode}"), ("", " " * 2)])
        columns -= len(mode) + 2

        status = self._status_provider()
        status_text = self._format_status(status)

        if self._current_toast is not None:
            fragments.extend([("", self._current_toast), ("", " " * 2)])
            columns -= len(self._current_toast) + 2
            self._current_toast_duration -= _REFRESH_INTERVAL
            if self._current_toast_duration <= 0.0:
                self._current_toast = None
        else:
            shortcuts = [
                "ctrl-x: switch mode",
                "ctrl-j: newline",
                "ctrl-v: paste",
                "ctrl-d: exit",
            ]
            for shortcut in shortcuts:
                if columns - len(status_text) > len(shortcut) + 2:
                    fragments.extend([("", shortcut), ("", " " * 2)])
                    columns -= len(shortcut) + 2
                else:
                    break

        if self._current_toast is None and not _toast_queue.empty():
            self._current_toast, self._current_toast_duration = _toast_queue.get_nowait()

        padding = max(1, columns - len(status_text))
        fragments.append(("", " " * padding))
        fragments.append(("", status_text))

        return FormattedText(fragments)

    @staticmethod
    def _format_status(status: StatusSnapshot) -> str:
        bounded = max(0.0, min(status.context_usage, 1.0))
        return f"context: {bounded:.1%}"


def ensure_new_line() -> None:
    """Ensure the next prompt starts at column 0 regardless of prior command output."""

    if not sys.stdout.isatty() or not sys.stdin.isatty():
        return

    needs_break = True
    if sys.platform == "win32":
        column = _cursor_column_windows()
        needs_break = column not in (None, 0)
    else:
        column = _cursor_column_unix()
        needs_break = column not in (None, 1)

    if needs_break:
        _write_newline()


def _cursor_column_unix() -> int | None:
    assert sys.platform != "win32"

    import select
    import termios
    import tty

    _CURSOR_QUERY = "\x1b[6n"
    _CURSOR_POSITION_RE = re.compile(r"\x1b\[(\d+);(\d+)R")

    fd = sys.stdin.fileno()
    oldterm = termios.tcgetattr(fd)

    try:
        tty.setcbreak(fd)
        sys.stdout.write(_CURSOR_QUERY)
        sys.stdout.flush()

        response = ""
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline:
            timeout = max(0.01, deadline - time.monotonic())
            ready, _, _ = select.select([sys.stdin], [], [], timeout)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 32)
            except OSError:
                break
            if not chunk:
                break
            response += chunk.decode(errors="ignore")
            match = _CURSOR_POSITION_RE.search(response)
            if match:
                return int(match.group(2))
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, oldterm)

    return None


def _cursor_column_windows() -> int | None:
    assert sys.platform == "win32"

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    _STD_OUTPUT_HANDLE = -11  # Windows API constant for standard output handle
    handle = kernel32.GetStdHandle(_STD_OUTPUT_HANDLE)
    invalid_handle_value = ctypes.c_void_p(-1).value
    if handle in (0, invalid_handle_value):
        return None

    class COORD(ctypes.Structure):
        _fields_ = [("X", wintypes.SHORT), ("Y", wintypes.SHORT)]

    class SMALL_RECT(ctypes.Structure):
        _fields_ = [
            ("Left", wintypes.SHORT),
            ("Top", wintypes.SHORT),
            ("Right", wintypes.SHORT),
            ("Bottom", wintypes.SHORT),
        ]

    class CONSOLE_SCREEN_BUFFER_INFO(ctypes.Structure):
        _fields_ = [
            ("dwSize", COORD),
            ("dwCursorPosition", COORD),
            ("wAttributes", wintypes.WORD),
            ("srWindow", SMALL_RECT),
            ("dwMaximumWindowSize", COORD),
        ]

    csbi = CONSOLE_SCREEN_BUFFER_INFO()
    if not kernel32.GetConsoleScreenBufferInfo(handle, ctypes.byref(csbi)):
        return None

    return int(csbi.dwCursorPosition.X)


def _write_newline() -> None:
    sys.stdout.write("\n")
    sys.stdout.flush()
