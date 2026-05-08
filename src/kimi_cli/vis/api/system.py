"""Vis API for server capabilities and metadata."""

from __future__ import annotations

import sys
from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/vis", tags=["vis"])


@router.get("/capabilities")
def get_capabilities(request: Request) -> dict[str, Any]:
    """Return server capabilities that affect frontend feature visibility."""
    restrict_open_in: bool = getattr(request.app.state, "restrict_open_in", False)
    return {
        "open_in_supported": sys.platform in {"darwin", "win32"} and not restrict_open_in,
    }
