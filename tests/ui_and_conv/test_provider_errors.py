from __future__ import annotations

from kosong.chat_provider import APIStatusError

from kimi_cli.provider_errors import format_chat_provider_error


def test_format_chat_provider_error_detects_period_quota_429() -> None:
    presentation = format_chat_provider_error(
        APIStatusError(
            429,
            "You've reached your usage limit for this period. "
            "Your quota will be refreshed in the next period.",
        )
    )

    assert presentation.kind == "rate_limit"
    assert presentation.severity == "warning"
    assert presentation.headline == "Usage limit reached for this period."
    assert presentation.guidance == "Wait for quota refresh or upgrade your plan."
    assert "Server: You've reached your usage limit for this period." in presentation.as_plain_text(
        include_server_detail=True
    )


def test_format_chat_provider_error_handles_transient_429() -> None:
    presentation = format_chat_provider_error(
        APIStatusError(429, "Too many requests right now, please try again later.")
    )

    assert presentation.kind == "rate_limit"
    assert presentation.severity == "warning"
    assert presentation.headline == "API rate limit reached."
    assert (
        presentation.guidance
        == "Please wait a moment before retrying, or reduce the number of concurrent agents."
    )
