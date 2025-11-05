import asyncio
import difflib

from pygments.lexers import get_lexer_for_filename

from kimi_cli.wire.message import PreviewChange


class Preview:
    def __init__(self, yolo: bool = False):
        self._preview_queue = asyncio.Queue[PreviewChange]()
        self._yolo = yolo

    async def get_lexer(self, file_path: str):
        try:
            lexer = get_lexer_for_filename(file_path)
            return lexer.name.lower()
        except Exception:
            return "text"

    async def preview_text(
        self, file_path: str, content: str, content_type: str = "", style: str = ""
    ):
        if self._yolo:
            return

        title = file_path
        if not content_type:
            content_type = await self.get_lexer(file_path)

        msg = PreviewChange(title, content, content_type, style)
        self._preview_queue.put_nowait(msg)
        await msg.wait()

    async def preview_diff(self, file_path: str, before: str, after: str):
        if self._yolo:
            return

        diff = difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True)
        )

        content = "".join(diff)
        content_type = await self.get_lexer(file_path)
        msg = PreviewChange(file_path, content, content_type, "diff")
        self._preview_queue.put_nowait(msg)
        await msg.wait()

    async def fetch_request(self) -> PreviewChange:
        return await self._preview_queue.get()
