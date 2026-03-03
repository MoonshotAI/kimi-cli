from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from textwrap import shorten
from typing import TYPE_CHECKING, cast

import aiofiles
from kaos.path import KaosPath
from kosong.message import Message

from kimi_cli.soul.message import system
from kimi_cli.utils.message import message_stringify
from kimi_cli.utils.path import sanitize_cli_path
from kimi_cli.wire.types import (
    AudioURLPart,
    ContentPart,
    ImageURLPart,
    TextPart,
    ThinkPart,
    ToolCall,
    VideoURLPart,
)

if TYPE_CHECKING:
    from kimi_cli.soul.context import Context

# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

_HINT_KEYS = ("path", "file_path", "command", "query", "url", "name", "pattern")
"""Common tool-call argument keys whose values make good one-line hints."""


def _is_checkpoint_message(msg: Message) -> bool:
    """Check if a message is an internal checkpoint marker."""
    if msg.role != "user" or len(msg.content) != 1:
        return False
    part = msg.content[0]
    return isinstance(part, TextPart) and part.text.strip().startswith("<system>CHECKPOINT")


def _extract_tool_call_hint(args_json: str) -> str:
    """Extract a brief human-readable hint from tool-call arguments.

    Looks for well-known keys (path, command, …) and falls back to the first
    short string value.  Returns ``""`` when nothing useful is found.
    """
    try:
        parsed: object = json.loads(args_json)
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(parsed, dict):
        return ""
    args = cast(dict[str, object], parsed)

    # Prefer well-known keys
    for key in _HINT_KEYS:
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return shorten(val, width=60, placeholder="…")

    # Fallback: first short string value
    for val in args.values():
        if isinstance(val, str) and 0 < len(val) <= 80:
            return shorten(val, width=60, placeholder="…")

    return ""


def _format_content_part_md(part: ContentPart) -> str:
    """Convert a single ContentPart to markdown text."""
    match part:
        case TextPart(text=text):
            return text
        case ThinkPart(think=think):
            if not think.strip():
                return ""
            return f"<details><summary>Thinking</summary>\n\n{think}\n\n</details>"
        case ImageURLPart():
            return "[image]"
        case AudioURLPart():
            return "[audio]"
        case VideoURLPart():
            return "[video]"
        case _:
            return f"[{part.type}]"


def _format_tool_call_md(tool_call: ToolCall) -> str:
    """Convert a ToolCall to a markdown sub-section with a readable title."""
    args_raw = tool_call.function.arguments or "{}"
    hint = _extract_tool_call_hint(args_raw)
    title = f"#### Tool Call: {tool_call.function.name}"
    if hint:
        title += f" (`{hint}`)"

    try:
        args_formatted = json.dumps(json.loads(args_raw), indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        args_formatted = args_raw

    return f"{title}\n<!-- call_id: {tool_call.id} -->\n```json\n{args_formatted}\n```"


def _format_tool_result_md(msg: Message, tool_name: str, hint: str) -> str:
    """Format a tool result message as a collapsible markdown block."""
    call_id = msg.tool_call_id or "unknown"

    # Use _format_content_part_md for consistency with the rest of the module
    # (message_stringify loses ThinkPart and leaks <system> tags)
    result_parts: list[str] = []
    for part in msg.content:
        text = _format_content_part_md(part)
        if text.strip():
            result_parts.append(text)
    result_text = "\n".join(result_parts)

    summary = f"Tool Result: {tool_name}"
    if hint:
        summary += f" (`{hint}`)"

    return (
        f"<details><summary>{summary}</summary>\n\n"
        f"<!-- call_id: {call_id} -->\n"
        f"{result_text}\n\n"
        "</details>"
    )


def _group_into_turns(history: Sequence[Message]) -> list[list[Message]]:
    """Group messages into logical turns, each starting at a real user message."""
    turns: list[list[Message]] = []
    current: list[Message] = []

    for msg in history:
        if _is_checkpoint_message(msg):
            continue
        if msg.role == "user" and current:
            turns.append(current)
            current = []
        current.append(msg)

    if current:
        turns.append(current)
    return turns


def _format_turn_md(messages: list[Message], turn_number: int) -> str:
    """Format a logical turn as a markdown section.

    A turn typically contains:
      user message -> assistant (thinking + text + tool_calls) -> tool results
      -> assistant (more text + tool_calls) -> tool results -> assistant (final)
    All assistant/tool messages are grouped under a single ``### Assistant`` heading.
    """
    lines: list[str] = [f"## Turn {turn_number}", ""]

    # tool_call_id -> (function_name, hint)
    tool_call_info: dict[str, tuple[str, str]] = {}
    assistant_header_written = False

    for msg in messages:
        if _is_checkpoint_message(msg):
            continue

        if msg.role == "user":
            lines.append("### User")
            lines.append("")
            for part in msg.content:
                text = _format_content_part_md(part)
                if text.strip():
                    lines.append(text)
                    lines.append("")

        elif msg.role == "assistant":
            if not assistant_header_written:
                lines.append("### Assistant")
                lines.append("")
                assistant_header_written = True

            # Content parts (thinking, text, media)
            for part in msg.content:
                text = _format_content_part_md(part)
                if text.strip():
                    lines.append(text)
                    lines.append("")

            # Tool calls
            if msg.tool_calls:
                for tc in msg.tool_calls:
                    hint = _extract_tool_call_hint(tc.function.arguments or "{}")
                    tool_call_info[tc.id] = (tc.function.name, hint)
                    lines.append(_format_tool_call_md(tc))
                    lines.append("")

        elif msg.role == "tool":
            tc_id = msg.tool_call_id or ""
            name, hint = tool_call_info.get(tc_id, ("unknown", ""))
            lines.append(_format_tool_result_md(msg, name, hint))
            lines.append("")

        elif msg.role in ("system", "developer"):
            lines.append(f"### {msg.role.capitalize()}")
            lines.append("")
            for part in msg.content:
                text = _format_content_part_md(part)
                if text.strip():
                    lines.append(text)
                    lines.append("")

    return "\n".join(lines)


def _build_overview(
    history: Sequence[Message],
    turns: list[list[Message]],
    token_count: int,
) -> str:
    """Build the Overview section from existing data (no LLM call)."""
    # Topic: first real user message text, truncated
    topic = ""
    for msg in history:
        if msg.role == "user" and not _is_checkpoint_message(msg):
            topic = shorten(message_stringify(msg), width=80, placeholder="…")
            break

    # Count tool calls across all messages
    n_tool_calls = sum(len(msg.tool_calls) for msg in history if msg.tool_calls)

    lines = [
        "## Overview",
        "",
        f"- **Topic**: {topic}" if topic else "- **Topic**: (empty)",
        f"- **Conversation**: {len(turns)} turns | "
        f"{n_tool_calls} tool calls | {token_count:,} tokens",
        "",
        "---",
    ]
    return "\n".join(lines)


def build_export_markdown(
    session_id: str,
    work_dir: str,
    history: Sequence[Message],
    token_count: int,
    now: datetime,
) -> str:
    """Build the full export markdown string."""
    lines: list[str] = [
        "---",
        f"session_id: {session_id}",
        f"exported_at: {now.isoformat(timespec='seconds')}",
        f"work_dir: {work_dir}",
        f"message_count: {len(history)}",
        f"token_count: {token_count}",
        "---",
        "",
        "# Kimi Session Export",
        "",
    ]

    turns = _group_into_turns(history)
    lines.append(_build_overview(history, turns, token_count))
    lines.append("")

    for idx, turn_messages in enumerate(turns):
        lines.append(_format_turn_md(turn_messages, idx + 1))

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Import helpers
# ---------------------------------------------------------------------------

_IMPORTABLE_EXTENSIONS: frozenset[str] = frozenset(
    {
        # Markdown / plain text
        ".md",
        ".markdown",
        ".txt",
        ".text",
        ".rst",
        # Data / config
        ".json",
        ".jsonl",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".cfg",
        ".conf",
        ".csv",
        ".tsv",
        ".xml",
        ".env",
        ".properties",
        # Source code
        ".py",
        ".js",
        ".ts",
        ".jsx",
        ".tsx",
        ".java",
        ".kt",
        ".go",
        ".rs",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".rb",
        ".php",
        ".swift",
        ".scala",
        ".sh",
        ".bash",
        ".zsh",
        ".fish",
        ".ps1",
        ".bat",
        ".cmd",
        ".r",
        ".R",
        ".lua",
        ".pl",
        ".pm",
        ".ex",
        ".exs",
        ".erl",
        ".hs",
        ".ml",
        ".sql",
        ".graphql",
        ".proto",
        # Web
        ".html",
        ".htm",
        ".css",
        ".scss",
        ".sass",
        ".less",
        ".svg",
        # Logs
        ".log",
        # Documentation
        ".tex",
        ".bib",
        ".org",
        ".adoc",
        ".wiki",
    }
)
"""File extensions accepted by ``/import``.  Only text-based formats are
supported — importing binary files (images, PDFs, archives, …) is rejected
with a friendly message."""


def is_importable_file(path_str: str) -> bool:
    """Return True if *path_str* has an extension in the importable whitelist.

    Files with no extension are also accepted (could be READMEs, Makefiles, …).
    """
    suffix = Path(path_str).suffix.lower()
    return suffix == "" or suffix in _IMPORTABLE_EXTENSIONS


def _stringify_content_parts(parts: Sequence[ContentPart]) -> str:
    """Serialize a list of ContentParts to readable text, preserving ThinkPart."""
    segments: list[str] = []
    for part in parts:
        match part:
            case TextPart(text=text):
                if text.strip():
                    segments.append(text)
            case ThinkPart(think=think):
                if think.strip():
                    segments.append(f"<thinking>\n{think}\n</thinking>")
            case ImageURLPart():
                segments.append("[image]")
            case AudioURLPart():
                segments.append("[audio]")
            case VideoURLPart():
                segments.append("[video]")
            case _:
                segments.append(f"[{part.type}]")
    return "\n".join(segments)


def _stringify_tool_calls(tool_calls: Sequence[ToolCall]) -> str:
    """Serialize tool calls to readable text."""
    lines: list[str] = []
    for tc in tool_calls:
        args_raw = tc.function.arguments or "{}"
        try:
            args = json.loads(args_raw)
            args_str = json.dumps(args, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            args_str = args_raw
        lines.append(f"Tool Call: {tc.function.name}({args_str})")
    return "\n".join(lines)


def stringify_context_history(history: Sequence[Message]) -> str:
    """Convert a sequence of Messages to a readable text transcript.

    Preserves ThinkPart content, tool call information, and tool results
    so that an AI receiving the imported context has a complete picture.
    """
    parts: list[str] = []
    for msg in history:
        if _is_checkpoint_message(msg):
            continue

        role_label = msg.role.upper()
        segments: list[str] = []

        # Content parts (text, thinking, media)
        content_text = _stringify_content_parts(msg.content)
        if content_text.strip():
            segments.append(content_text)

        # Tool calls (only on assistant messages)
        if msg.tool_calls:
            segments.append(_stringify_tool_calls(msg.tool_calls))

        if not segments:
            continue

        header = f"[{role_label}]"
        if msg.role == "tool" and msg.tool_call_id:
            header = f"[{role_label}] (call_id: {msg.tool_call_id})"

        parts.append(f"{header}\n" + "\n".join(segments))
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Shared command logic
# ---------------------------------------------------------------------------


async def perform_export(
    history: Sequence[Message],
    session_id: str,
    work_dir: str,
    token_count: int,
    args: str,
    default_dir: Path,
) -> tuple[Path, int] | str:
    """Perform the full export operation.

    Returns ``(output_path, message_count)`` on success, or an error message
    string on failure.
    """
    if not history:
        return "No messages to export."

    now = datetime.now().astimezone()
    short_id = session_id[:8]
    default_name = f"kimi-export-{short_id}-{now.strftime('%Y%m%d-%H%M%S')}.md"

    cleaned = sanitize_cli_path(args)
    if cleaned:
        # sanitize_cli_path only strips quotes; it preserves trailing separators.
        directory_hint = cleaned.endswith(("/", "\\"))
        output = Path(cleaned).expanduser()
        if not output.is_absolute():
            output = default_dir / output
        # Keep explicit "directory intent" even when the directory does not exist yet.
        if directory_hint or output.is_dir():
            output = output / default_name
    else:
        output = default_dir / default_name

    content = build_export_markdown(
        session_id=session_id,
        work_dir=work_dir,
        history=history,
        token_count=token_count,
        now=now,
    )

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(output, "w", encoding="utf-8") as f:
            await f.write(content)
    except OSError as e:
        return f"Failed to write export file: {e}"

    return (output, len(history))


MAX_IMPORT_SIZE = 10 * 1024 * 1024  # 10 MB
"""Maximum size (in bytes) of a file that can be imported via ``/import``."""

_SENSITIVE_FILE_PATTERNS: tuple[str, ...] = (
    ".env",
    "credentials",
    "secrets",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".keystore",
)
"""File-name substrings that indicate potentially sensitive content."""


def is_sensitive_file(filename: str) -> bool:
    """Return True if *filename* looks like it may contain secrets."""
    name = filename.lower()
    return any(pat in name for pat in _SENSITIVE_FILE_PATTERNS)


def _validate_import_token_budget(
    estimated_tokens: int,
    current_token_count: int,
    max_context_size: int | None,
) -> str | None:
    """Return an error if importing would push the session over the context budget.

    *estimated_tokens* is the pre-computed token estimate for the import
    message.  The check is ``current_token_count + estimated_tokens <=
    max_context_size``.
    """
    if max_context_size is None or max_context_size <= 0:
        return None

    total_after_import = current_token_count + estimated_tokens
    if total_after_import <= max_context_size:
        return None

    return (
        "Imported content is too large for the current model context "
        f"(~{estimated_tokens:,} import tokens + {current_token_count:,} existing "
        f"= ~{total_after_import:,} total > {max_context_size:,} token limit). "
        "Please import a smaller file or session."
    )


async def resolve_import_source(
    target: str,
    current_session_id: str,
    work_dir: KaosPath,
) -> tuple[str, str] | str:
    """Resolve the import source to ``(content, source_desc)`` or an error message.

    This function handles I/O and source-level validation (file type, encoding,
    byte-size cap).  Session-level concerns like token budget are checked by
    :func:`perform_import`.
    """
    from kimi_cli.session import Session
    from kimi_cli.soul.context import Context

    target_path = Path(target).expanduser()
    if not target_path.is_absolute():
        target_path = Path(str(work_dir)) / target_path

    if target_path.exists() and target_path.is_dir():
        return "The specified path is a directory; please provide a file to import."

    if target_path.exists() and target_path.is_file():
        if not is_importable_file(target_path.name):
            return (
                f"Unsupported file type '{target_path.suffix}'. "
                "/import only supports text-based files "
                "(e.g. .md, .txt, .json, .py, .log, …)."
            )

        try:
            file_size = target_path.stat().st_size
        except OSError as e:
            return f"Failed to read file: {e}"
        if file_size > MAX_IMPORT_SIZE:
            limit_mb = MAX_IMPORT_SIZE // (1024 * 1024)
            return (
                f"File is too large ({file_size / 1024 / 1024:.1f} MB). "
                f"Maximum import size is {limit_mb} MB."
            )

        try:
            async with aiofiles.open(target_path, encoding="utf-8") as f:
                content = await f.read()
        except UnicodeDecodeError:
            return (
                f"Cannot import '{target_path.name}': "
                "the file does not appear to be valid UTF-8 text."
            )
        except OSError as e:
            return f"Failed to read file: {e}"

        if not content.strip():
            return "The file is empty, nothing to import."

        return (content, f"file '{target_path.name}'")

    # Not a file on disk — try as session ID
    if target == current_session_id:
        return "Cannot import the current session into itself."

    source_session = await Session.find(work_dir, target)
    if source_session is None:
        return f"'{target}' is not a valid file path or session ID."

    source_context = Context(source_session.context_file)
    try:
        restored = await source_context.restore()
    except Exception as e:
        return f"Failed to load source session: {e}"
    if not restored or not source_context.history:
        return "The source session has no messages."

    content = stringify_context_history(source_context.history)
    content_bytes = len(content.encode("utf-8"))
    if content_bytes > MAX_IMPORT_SIZE:
        limit_mb = MAX_IMPORT_SIZE // (1024 * 1024)
        actual_mb = content_bytes / 1024 / 1024
        return (
            f"Session content is too large ({actual_mb:.1f} MB). "
            f"Maximum import size is {limit_mb} MB."
        )
    return (content, f"session '{target}'")


def build_import_message(content: str, source_desc: str) -> Message:
    """Build the ``Message`` to append to context for an import operation."""
    import_text = f'<imported_context source="{source_desc}">\n{content}\n</imported_context>'
    return Message(
        role="user",
        content=[
            system(
                f"The user has imported context from {source_desc}. "
                "This is a prior conversation history that may be relevant "
                "to the current session. "
                "Please review this context and use it to inform your responses."
            ),
            TextPart(text=import_text),
        ],
    )


async def perform_import(
    target: str,
    current_session_id: str,
    work_dir: KaosPath,
    context: Context,
    max_context_size: int | None = None,
) -> tuple[str, int] | str:
    """High-level import operation: resolve source, validate, build message, update context.

    Returns ``(source_desc, content_len)`` on success, or an error message
    string.  *content_len* is the raw imported content length in characters
    (excluding wrapper markup), suitable for user-facing display.
    The caller is responsible for any additional side-effects (wire file writes,
    UI output, etc.).
    """
    from kimi_cli.soul.compaction import estimate_text_tokens

    result = await resolve_import_source(
        target=target,
        current_session_id=current_session_id,
        work_dir=work_dir,
    )
    if isinstance(result, str):
        return result

    content, source_desc = result
    message = build_import_message(content, source_desc)

    # Token budget check — reject before mutating context.
    estimated = estimate_text_tokens([message])
    if error := _validate_import_token_budget(estimated, context.token_count, max_context_size):
        return error

    await context.append_message(message)
    await context.update_token_count(context.token_count + estimated)

    return (source_desc, len(content))
