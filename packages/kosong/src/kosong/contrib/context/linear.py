import asyncio
import json
from pathlib import Path
from typing import IO, Protocol, runtime_checkable

from kosong.message import Message


class LinearContext:
    """
    A context that contains a linear history of messages.
    """

    def __init__(self, storage: "LinearStorage"):
        self._storage = storage

    @property
    def history(self) -> list[Message]:
        return self._storage.messages

    @property
    def token_count(self) -> int:
        return self._storage.token_count

    async def add_message(self, message: Message):
        await self._storage.append_message(message)

    async def mark_token_count(self, token_count: int):
        await self._storage.mark_token_count(token_count)


@runtime_checkable
class LinearStorage(Protocol):
    @property
    def messages(self) -> list[Message]:
        """
        All messages in the storage.
        """
        ...

    @property
    def token_count(self) -> int:
        """
        The total token count of the messages in the storage.
        This may not be the precise token count, depending on the caller of `mark_token_count`.
        """
        ...

    async def append_message(self, message: Message) -> None: ...
    async def mark_token_count(self, token_count: int) -> None: ...


class MemoryLinearStorage:
    """
    A linear storage that stores messages in memory, only for testing.
    """

    def __init__(self):
        self._messages: list[Message] = []
        self._token_count: int | None = None

    @property
    def messages(self) -> list[Message]:
        return self._messages

    @property
    def token_count(self) -> int:
        return self._token_count or 0

    async def append_message(self, message: Message):
        self._messages.append(message)

    async def mark_token_count(self, token_count: int):
        self._token_count = token_count


class JsonlLinearStorage(MemoryLinearStorage):
    """
    A linear storage that stores messages in a JSONL file.
    """

    def __init__(self, path: Path | str):
        super().__init__()
        self._path = path if isinstance(path, Path) else Path(path)
        self._file: IO[str] | None = None

    async def restore(self):
        """Restore all messages from the JSONL file."""
        if self._messages:
            raise RuntimeError("The storage is already modified")
        if not self._path.exists():
            return

        def _restore():
            with open(self._path, encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    line_json = json.loads(line)
                    if "token_count" in line_json:
                        self._token_count = line_json["token_count"]
                        continue
                    message = Message.model_validate(line_json)
                    self._messages.append(message)

        await asyncio.to_thread(_restore)

    def _get_file(self) -> IO[str]:
        if self._file is None:
            self._file = open(self._path, "a", encoding="utf-8")  # noqa: SIM115
        return self._file

    def __del__(self):
        if self._file:
            self._file.close()

    async def append_message(self, message: Message):
        await super().append_message(message)

        def _write():
            file = self._get_file()
            json.dump(
                message.model_dump(exclude_none=True),
                file,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            file.write("\n")

        await asyncio.to_thread(_write)

    async def mark_token_count(self, token_count: int):
        await super().mark_token_count(token_count)

        def _write():
            file = self._get_file()
            json.dump(
                {"role": "_usage", "token_count": token_count},
                file,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            file.write("\n")

        await asyncio.to_thread(_write)
