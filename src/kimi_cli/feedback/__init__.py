"""Feedback module for collecting and uploading diagnostic data."""

from kimi_cli.feedback.collector import (
    collect_phase1,
    collect_phase2_context,
    collect_phase2_log_tail,
    collect_phase2_source_zip,
    collect_phase2_wire_tail,
)
from kimi_cli.feedback.display import display_feedback_detail, display_feedback_summary
from kimi_cli.feedback.models import Phase1Request, Phase1Response
from kimi_cli.feedback.uploader import FeedbackUploadError, upload_phase1, upload_phase2

__all__ = [
    "FeedbackUploadError",
    "Phase1Request",
    "Phase1Response",
    "collect_phase1",
    "collect_phase2_context",
    "collect_phase2_log_tail",
    "collect_phase2_source_zip",
    "collect_phase2_wire_tail",
    "display_feedback_detail",
    "display_feedback_summary",
    "upload_phase1",
    "upload_phase2",
]
