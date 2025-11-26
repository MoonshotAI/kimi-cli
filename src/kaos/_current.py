from contextvars import ContextVar

from kaos import Kaos
from kaos.local import local_kaos

current_kaos = ContextVar[Kaos]("current_kaos", default=local_kaos)
