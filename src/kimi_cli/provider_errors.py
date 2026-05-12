from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from kosong.chat_provider import (
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
)


@dataclass(frozen=True, slots=True)
class ProviderErrorPresentation:
    kind: str
    headline: str
    guidance: str | None = None
    server_detail: str | None = None
    severity: Literal["warning", "error"] = "error"
    show_support_hint: bool = False

    def as_plain_text(self, *, include_server_detail: bool = False) -> str:
        lines = [self.headline]
        if self.guidance:
            lines.append(self.guidance)
        if include_server_detail and self.server_detail:
            lines.append(f"Server: {self.server_detail}")
        return "\n".join(lines)


def format_chat_provider_error(error: ChatProviderError) -> ProviderErrorPresentation:
    detail = str(error)
    if isinstance(error, APIStatusError):
        if error.status_code == 401:
            return ProviderErrorPresentation(
                kind="auth",
                headline="Authorization failed.",
                guidance="Your session may have expired. Run /login to re-authenticate.",
                server_detail=detail,
            )
        if error.status_code == 402:
            return ProviderErrorPresentation(
                kind="membership",
                headline="Membership expired.",
                guidance="Please renew your plan before retrying.",
                server_detail=detail,
            )
        if error.status_code == 403:
            return ProviderErrorPresentation(
                kind="quota",
                headline="Quota exceeded.",
                guidance="Please upgrade your plan or retry later.",
                server_detail=detail,
            )
        if error.status_code == 429:
            detail_lower = detail.lower()
            if (
                "usage limit for this period" in detail_lower
                or "quota will be refreshed" in detail_lower
                or "next period" in detail_lower
            ):
                return ProviderErrorPresentation(
                    kind="rate_limit",
                    headline="Usage limit reached for this period.",
                    guidance="Wait for quota refresh or upgrade your plan.",
                    server_detail=detail,
                    severity="warning",
                )
            return ProviderErrorPresentation(
                kind="rate_limit",
                headline="API rate limit reached.",
                guidance=(
                    "Please wait a moment before retrying, or reduce the number of "
                    "concurrent agents."
                ),
                server_detail=detail,
                severity="warning",
            )

    if isinstance(error, APIConnectionError):
        return ProviderErrorPresentation(
            kind="network",
            headline="Network connection failed.",
            guidance="Please check your network and try again.",
            severity="warning",
        )

    if isinstance(error, APITimeoutError):
        return ProviderErrorPresentation(
            kind="timeout",
            headline="Request timed out.",
            guidance="The server may be slow or unreachable. Please try again later.",
            severity="warning",
        )

    if isinstance(error, APIEmptyResponseError):
        return ProviderErrorPresentation(
            kind="empty_response",
            headline="The server returned an empty response.",
            guidance="This is usually temporary. Please try again.",
            severity="warning",
        )

    return ProviderErrorPresentation(
        kind="generic",
        headline=f"LLM provider error: {detail}",
        show_support_hint=True,
    )
