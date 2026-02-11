from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import aiohttp

from kimi_cli.auth.oauth import _common_headers  # type: ignore[reportPrivateUsage]
from kimi_cli.feedback.models import Phase1Request, Phase1Response
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger

DEFAULT_FEEDBACK_API_BASE = "https://kimi.moonshot.cn/api/coding/v1"
PHASE1_TIMEOUT = aiohttp.ClientTimeout(total=30)
PHASE2_TIMEOUT = aiohttp.ClientTimeout(total=120)


class FeedbackUploadError(Exception):
    pass


def _get_feedback_api_base() -> str:
    """Determine the feedback API base URL.

    Priority: KIMI_FEEDBACK_API_BASE env var > hardcoded default.
    """
    env_base = os.environ.get("KIMI_FEEDBACK_API_BASE")
    if env_base:
        return env_base.rstrip("/")
    return DEFAULT_FEEDBACK_API_BASE


def _get_local_dir() -> Path | None:
    """Return local feedback directory if KIMI_FEEDBACK_LOCAL_DIR is set."""
    local_dir = os.environ.get("KIMI_FEEDBACK_LOCAL_DIR")
    if local_dir:
        return Path(local_dir)
    return None


async def _local_upload_phase1(request: Phase1Request, local_dir: Path) -> Phase1Response:
    """Save Phase 1 data to local directory for debugging."""
    report_id = f"local-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    report_dir = local_dir / report_id
    report_dir.mkdir(parents=True, exist_ok=True)

    phase1_path = report_dir / "phase1.json"
    phase1_path.write_text(
        json.dumps(request.model_dump(mode="json"), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    logger.info("Feedback Phase 1 saved locally: {path}", path=phase1_path)
    return Phase1Response(
        report_id=report_id,
        message=f"Saved locally to {report_dir}",
    )


async def _local_upload_phase2(
    report_id: str,
    context_jsonl: bytes,
    wire_tail: bytes,
    log_tail: bytes,
    source_zip: bytes | None,
    local_dir: Path,
) -> None:
    """Save Phase 2 attachments to local directory for debugging."""
    report_dir = local_dir / report_id
    report_dir.mkdir(parents=True, exist_ok=True)

    if context_jsonl:
        (report_dir / "context.jsonl").write_bytes(context_jsonl)
    if wire_tail:
        (report_dir / "wire_tail.jsonl").write_bytes(wire_tail)
    if log_tail:
        (report_dir / "kimi.log").write_bytes(log_tail)
    if source_zip is not None:
        (report_dir / "source.zip").write_bytes(source_zip)

    logger.info("Feedback Phase 2 saved locally: {path}", path=report_dir)


async def upload_phase1(
    request: Phase1Request,
) -> Phase1Response:
    """
    Phase 1: Upload basic diagnostic info as JSON.

    POST {base_url}/feedback
    Returns report_id.

    If KIMI_FEEDBACK_LOCAL_DIR is set, saves to local directory instead.
    """
    local_dir = _get_local_dir()
    if local_dir is not None:
        return await _local_upload_phase1(request, local_dir)

    base_url = _get_feedback_api_base()
    url = f"{base_url}/feedback"

    headers = _common_headers()

    logger.debug("Uploading Phase 1 feedback to {url}", url=url)

    async with (
        new_client_session() as session,
        session.post(
            url,
            json=request.model_dump(mode="json"),
            headers=headers,
            timeout=PHASE1_TIMEOUT,
        ) as response,
    ):
        data = await response.json(content_type=None)
        if response.status not in (200, 201):
            raise FeedbackUploadError(f"Phase 1 upload failed: HTTP {response.status} — {data}")
        return Phase1Response.model_validate(data)


async def upload_phase2(
    report_id: str,
    context_jsonl: bytes,
    wire_tail: bytes,
    log_tail: bytes,
    source_zip: bytes | None = None,
) -> None:
    """
    Phase 2: Upload large attachments as multipart/form-data.

    POST {base_url}/feedback/{report_id}/attachments

    If KIMI_FEEDBACK_LOCAL_DIR is set, saves to local directory instead.
    """
    local_dir = _get_local_dir()
    if local_dir is not None:
        await _local_upload_phase2(
            report_id, context_jsonl, wire_tail, log_tail, source_zip, local_dir
        )
        return

    base_url = _get_feedback_api_base()
    url = f"{base_url}/feedback/{report_id}/attachments"

    headers = _common_headers()

    data = aiohttp.FormData()
    if context_jsonl:
        data.add_field(
            "context_jsonl",
            context_jsonl,
            filename="context.jsonl",
            content_type="application/jsonl",
        )
    if wire_tail:
        data.add_field(
            "wire_tail",
            wire_tail,
            filename="wire_tail.jsonl",
            content_type="application/jsonl",
        )
    if log_tail:
        data.add_field(
            "log_tail",
            log_tail,
            filename="kimi.log",
            content_type="text/plain",
        )
    if source_zip is not None:
        data.add_field(
            "source_zip",
            source_zip,
            filename="source.zip",
            content_type="application/zip",
        )

    logger.debug("Uploading Phase 2 feedback to {url}", url=url)

    async with (
        new_client_session() as session,
        session.post(
            url,
            data=data,
            headers=headers,
            timeout=PHASE2_TIMEOUT,
        ) as response,
    ):
        if response.status not in (200, 201, 204):
            detail = await response.text()
            raise FeedbackUploadError(f"Phase 2 upload failed: HTTP {response.status} — {detail}")
