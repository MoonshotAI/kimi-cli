import asyncio
import difflib
import re

from pygments.lexers import get_lexer_for_filename

from kimi_cli.wire.message import PreviewChange


def parse_diff_header(diff_line: str) -> tuple[int, int, int, int]:
    pattern = r"@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@"
    match = re.match(pattern, diff_line)

    if not match:
        return (0, 0, 0, 0)

    old_start, old_lines, new_start, new_lines = match.groups()

    old_lines = int(old_lines) if old_lines else 1
    new_lines = int(new_lines) if new_lines else 1

    return (int(old_start), old_lines, int(new_start), new_lines)


class Preview:
    def __init__(self):
        self._preview_queue = asyncio.Queue[PreviewChange]()

    async def get_lexer(self, file_path: str):
        try:
            lexer = get_lexer_for_filename(file_path)
            return lexer.name.lower()
        except Exception:
            return "text"

    async def preview_text(self, file_path: str, content: str, content_type: str = ""):
        title = file_path
        if not content_type:
            content_type = await self.get_lexer(file_path)

        self._preview_queue.put_nowait(PreviewChange(title, content, content_type))

    async def preview_diff(self, file_path: str, before: str, after: str):
        diff = difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True), fromfile=file_path
        )

        # ignore --- +++
        next(diff)
        next(diff)

        content = "".join(diff)
        content_type = await self.get_lexer(file_path)
        self._preview_queue.put_nowait(PreviewChange(file_path, content, content_type, "diff"))

    async def fetch_request(self) -> PreviewChange:
        """
        Fetch an approval request from the queue. Intended to be called by the soul.
        """
        return await self._preview_queue.get()
