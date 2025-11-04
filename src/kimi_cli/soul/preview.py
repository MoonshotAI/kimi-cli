import asyncio
import difflib

from pygments.lexers import get_lexer_for_filename

from kimi_cli.wire.message import PreviewChange


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

        breaker = ""
        # ignore redundant lines
        while not breaker.startswith("@@"):
            breaker = next(diff)

        code = ""
        delta = ["+", "-"]
        for line in diff:
            line = f"{line[0]} {line[1:]}" if line[0] in delta else f" {line}"
            code += line

        title = f"Edit {file_path}"
        self._preview_queue.put_nowait(PreviewChange(title, code, "diff"))

    async def fetch_request(self) -> PreviewChange:
        """
        Fetch an approval request from the queue. Intended to be called by the soul.
        """
        return await self._preview_queue.get()
