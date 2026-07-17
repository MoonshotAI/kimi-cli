from typing import Literal, cast

import pytest

from kaos import Kaos, StrOrKaosPath
from kaos.overlay import OverlayKaos
from kaos.path import KaosPath


@pytest.mark.asyncio
async def test_overlay_kaos_fallback_readtext():
    class FailKaos:
        async def readtext(
            self,
            path: StrOrKaosPath,
            *,
            encoding: str = "utf-8",
            errors: Literal["strict", "ignore", "replace"] = "strict",
        ) -> str:
            raise FileNotFoundError("missing")

    class OkKaos:
        async def readtext(
            self,
            path: StrOrKaosPath,
            *,
            encoding: str = "utf-8",
            errors: Literal["strict", "ignore", "replace"] = "strict",
        ) -> str:
            return "ok"

    overlay = OverlayKaos(cast(Kaos, FailKaos()), cast(Kaos, OkKaos()))
    result = await overlay.readtext("/tmp/file.txt")
    assert result == "ok"


@pytest.mark.asyncio
async def test_overlay_kaos_iterdir_no_fallback_after_yield():
    class YieldThenErrorKaos:
        async def iterdir(self, path: StrOrKaosPath):
            yield KaosPath("first.txt")
            raise RuntimeError("boom")

    class TrackingKaos:
        def __init__(self) -> None:
            self.called = False

        async def iterdir(self, path: StrOrKaosPath):
            self.called = True
            yield KaosPath("second.txt")

    tracking = TrackingKaos()
    overlay = OverlayKaos(cast(Kaos, YieldThenErrorKaos()), cast(Kaos, tracking))

    with pytest.raises(RuntimeError):
        async for _ in overlay.iterdir("/tmp"):
            pass

    assert tracking.called is False


def test_overlay_kaos_requires_backend():
    with pytest.raises(ValueError):
        OverlayKaos()
