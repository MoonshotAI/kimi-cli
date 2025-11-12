from contextvars import ContextVar
from typing import Protocol


class Kaos(Protocol):
    pass


current_kaos = ContextVar[Kaos | None]("current_kaos", default=None)


def get_kaos_or_none() -> Kaos | None:
    return current_kaos.get()
