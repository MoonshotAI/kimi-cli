"""Vis API for server capabilities and metadata."""

from __future__ import annotations

import sys
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/api/vis", tags=["vis"])


@router.get("/capabilities")
def get_capabilities() -> dict[str, Any]:
    """Return server capabilities that affect frontend feature visibility."""
    return {"open_in_supported": sys.platform in {"darwin", "win32"}}
