from contextvars import ContextVar
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from kimi_cli.kaos.path import KaosPath


class Kaos(Protocol):
    async def chdir(self, path: str | KaosPath) -> None: ...


current_kaos = ContextVar[Kaos | None]("current_kaos", default=None)


def get_kaos_or_none() -> Kaos | None:
    return current_kaos.get()


async def chdir(path: str | KaosPath) -> None:
    kaos = get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    await kaos.chdir(path)
