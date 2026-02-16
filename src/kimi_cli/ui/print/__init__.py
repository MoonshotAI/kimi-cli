from __future__ import annotations

import asyncio
import json
import re
import sys
from functools import partial
from pathlib import Path

from kosong.chat_provider import ChatProviderError
from kosong.message import ContentPart, Message, TextPart
from rich import print

from kimi_cli.cli import InputFormat, OutputFormat
from kimi_cli.soul import (
    LLMNotSet,
    LLMNotSupported,
    MaxStepsReached,
    RunCancelled,
    Soul,
    run_soul,
)
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.tools.file.utils import VIDEO_EXTENSIONS
from kimi_cli.ui.print.visualize import visualize
from kimi_cli.utils.logging import logger
from kimi_cli.utils.signals import install_sigint_handler

def _extract_video_paths(text: str) -> list[tuple[int, int, Path]]:
    """Extract video file paths from text.
    
    Returns list of (start, end, path) tuples for each video file found.
    Only includes paths that actually exist as files.
    Handles paths with spaces and special characters in filenames by trying
    progressively longer paths from the extension backwards.
    """
    results: list[tuple[int, int, Path]] = []
    video_exts = "|".join(ext.lstrip(".") for ext in VIDEO_EXTENSIONS.keys())
    
    # Find all video extension occurrences (not using \b to avoid issues with [ or other chars)
    # Match extensions followed by space, punctuation, or end of string
    for match in re.finditer(rf"\.({video_exts})(?=\s|$|[.,;!?])", text, re.IGNORECASE):
        ext_end = match.end()
        
        # Try progressively longer paths from the extension backwards
        # Start from the beginning of the text and expand until we find a valid file
        best_match: tuple[int, Path] | None = None
        
        # Try each possible start position, preferring longer paths
        for start_candidate in range(0, ext_end):
            # Must start at word boundary or with @ or /
            if start_candidate > 0 and text[start_candidate - 1] not in " \t\n":
                continue
                
            path_str = text[start_candidate:ext_end]
            
            # Remove @ prefix for validation
            check_path_str = path_str[1:] if path_str.startswith("@") else path_str
            path = Path(check_path_str)
            
            # Check if this is a valid video file
            if path.suffix.lower() in VIDEO_EXTENSIONS and path.is_file():
                # Found a valid file - update best match (preferring longer paths)
                best_match = (start_candidate, path)
        
        if best_match is not None:
            start_pos, path = best_match
            results.append((start_pos, ext_end, path))
    
    return results


def _build_content_parts(command: str) -> list[ContentPart]:
    """Build content parts from command, detecting video files.
    
    Similar to the web UI, video files are wrapped in <video> tags
    so the agent can use ReadMediaFile tool to read them.
    """
    video_paths = _extract_video_paths(command)
    if not video_paths:
        # No videos found, return simple text
        return [TextPart(text=command)]
    
    parts: list[ContentPart] = []
    last_end: int = 0
    
    for start, end, path in video_paths:
        # Add text before this video
        if start > last_end:
            text_before = command[last_end:start]
            if text_before:
                parts.append(TextPart(text=text_before))
        
        # Add video reference
        file_path = str(path)
        # Try to get mime type from extension
        suffix = path.suffix.lower()
        mime_type = VIDEO_EXTENSIONS.get(suffix, "video/mp4")
        
        parts.append(TextPart(text=f'<video path="{file_path}" content_type="{mime_type}">'))
        parts.append(TextPart(text="</video>\n\n"))
        
        last_end = end
    
    # Add any remaining text after the last video
    if last_end < len(command):
        text_after = command[last_end:]
        if text_after:
            parts.append(TextPart(text=text_after))
    
    return parts


class Print:
    """
    An app implementation that prints the agent behavior to the console.

    Args:
        soul (Soul): The soul to run.
        input_format (InputFormat): The input format to use.
        output_format (OutputFormat): The output format to use.
        context_file (Path): The file to store the context.
        final_only (bool): Whether to only print the final assistant message.
    """

    def __init__(
        self,
        soul: Soul,
        input_format: InputFormat,
        output_format: OutputFormat,
        context_file: Path,
        *,
        final_only: bool = False,
    ):
        self.soul = soul
        self.input_format: InputFormat = input_format
        self.output_format: OutputFormat = output_format
        self.context_file = context_file
        self.final_only = final_only

    async def run(self, command: str | None = None) -> bool:
        cancel_event = asyncio.Event()

        def _handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, _handler)

        if command is None and not sys.stdin.isatty() and self.input_format == "text":
            command = sys.stdin.read().strip()
            logger.info("Read command from stdin: {command}", command=command)

        try:
            while True:
                if command is None:
                    if self.input_format == "text":
                        return True
                    else:
                        assert self.input_format == "stream-json"
                        command = self._read_next_command()
                        if command is None:
                            return True

                if command:
                    logger.info("Running agent with command: {command}", command=command)
                    
                    # Build content parts, detecting video files
                    content_parts = _build_content_parts(command)
                    
                    if self.output_format == "text" and not self.final_only:
                        print(command)
                    await run_soul(
                        self.soul,
                        content_parts,
                        partial(visualize, self.output_format, self.final_only),
                        cancel_event,
                        self.soul.wire_file if isinstance(self.soul, KimiSoul) else None,
                    )
                else:
                    logger.info("Empty command, skipping")

                command = None
        except LLMNotSet as e:
            logger.exception("LLM not set:")
            print(str(e))
        except LLMNotSupported as e:
            logger.exception("LLM not supported:")
            print(str(e))
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            print(str(e))
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            print(str(e))
        except RunCancelled:
            logger.error("Interrupted by user")
            print("Interrupted by user")
        except BaseException as e:
            logger.exception("Unknown error:")
            print(f"Unknown error: {e}")
            raise
        finally:
            remove_sigint()
        return False

    def _read_next_command(self) -> str | None:
        while True:
            json_line = sys.stdin.readline()
            if not json_line:
                # EOF
                return None

            json_line = json_line.strip()
            if not json_line:
                # for empty line, read next line
                continue

            try:
                data = json.loads(json_line)
                message = Message.model_validate(data)
                if message.role == "user":
                    return message.extract_text(sep="\n")
                logger.warning(
                    "Ignoring message with role `{role}`: {json_line}",
                    role=message.role,
                    json_line=json_line,
                )
            except Exception:
                logger.warning("Ignoring invalid user message: {json_line}", json_line=json_line)
