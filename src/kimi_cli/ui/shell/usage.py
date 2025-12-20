"""This file is pure vibe-coded. If any bugs are found, let's just rewrite it..."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast

import aiohttp
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.progress_bar import ProgressBar
from rich.table import Table
from rich.text import Text

from kimi_cli.config import LLMProvider
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.slash import registry
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.datetime import format_duration

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


@dataclass(slots=True, frozen=True)
class UsageRow:
    label: str
    used: int
    limit: int
    reset_hint: str | None = None


@registry.command
async def usage(app: Shell, args: list[str]):
    """Display API usage and quota information"""
    assert isinstance(app.soul, KimiSoul)
    if app.soul.runtime.llm is None:
        console.print("[red]LLM not set. Please run /setup first.[/red]")
        return

    provider = app.soul.runtime.llm.provider_config
    if provider is None:
        console.print("[red]LLM provider configuration not found.[/red]")
        return

    usage_url = _usage_url(provider)
    if usage_url is None:
        console.print("[yellow]Usage is available on Kimi for Coding platform only.[/yellow]")
        return

    with console.status("[cyan]Fetching usage...[/cyan]"):
        try:
            payload = await _fetch_usage(usage_url, provider.api_key.get_secret_value())
        except aiohttp.ClientResponseError as e:
            message = "Failed to fetch usage."
            if e.status == 401:
                message = "Authorization failed. Please check your API key."
            elif e.status == 404:
                message = "Usage endpoint not available. Try Kimi For Coding."
            console.print(f"[red]{message}[/red]")
            return
        except aiohttp.ClientError as e:
            console.print(f"[red]Failed to fetch usage: {e}[/red]")
            return

    summary, limits = _parse_usage_payload(payload)
    if summary is None and not limits:
        console.print("[yellow]No usage data available.[/yellow]")
        return

    console.print(_build_usage_panel(summary, limits))


def _usage_url(provider: LLMProvider) -> str | None:
    base_url = (provider.base_url or "").rstrip("/")
    coding_base_url = "https://api.kimi.com/coding/v1"
    if base_url != coding_base_url:
        return None
    return f"{base_url}/usages"


async def _fetch_usage(url: str, api_key: str) -> Mapping[str, Any]:
    async with (
        new_client_session() as session,
        session.get(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            raise_for_status=True,
        ) as resp,
    ):
        return await resp.json()


def _parse_usage_payload(
    payload: Mapping[str, Any],
) -> tuple[UsageRow | None, list[UsageRow]]:
    summary: UsageRow | None = None
    limits: list[UsageRow] = []

    usage = payload.get("usage")
    if isinstance(usage, Mapping):
        usage_map: Mapping[str, Any] = cast(Mapping[str, Any], usage)
        summary = _to_usage_row(usage_map, default_label="Total quota")

    raw_limits_obj = payload.get("limits")
    if isinstance(raw_limits_obj, Sequence):
        limits_seq: Sequence[Any] = cast(Sequence[Any], raw_limits_obj)
        for idx, item in enumerate(limits_seq):
            if not isinstance(item, Mapping):
                continue
            item_map: Mapping[str, Any] = cast(Mapping[str, Any], item)
            detail_raw = item_map.get("detail")
            detail: Mapping[str, Any] = (
                cast(Mapping[str, Any], detail_raw) if isinstance(detail_raw, Mapping) else item_map
            )
            # window may contain duration/timeUnit
            window_raw = item_map.get("window")
            window: Mapping[str, Any] = (
                cast(Mapping[str, Any], window_raw) if isinstance(window_raw, Mapping) else {}
            )
            label = _limit_label(item_map, detail, window, idx)
            row = _to_usage_row(detail, default_label=label)
            if row:
                limits.append(row)

    return summary, limits


def _to_usage_row(data: Mapping[str, Any], *, default_label: str) -> UsageRow | None:
    limit = _to_int(data.get("limit"))
    # Support both "used" and "remaining" (used = limit - remaining)
    used = _to_int(data.get("used"))
    if used is None:
        remaining = _to_int(data.get("remaining"))
        if remaining is not None and limit is not None:
            used = limit - remaining
    if used is None and limit is None:
        return None
    return UsageRow(
        label=str(data.get("name") or data.get("title") or default_label),
        used=used or 0,
        limit=limit or 0,
        reset_hint=_reset_hint(data),
    )


def _limit_label(
    item: Mapping[str, Any],
    detail: Mapping[str, Any],
    window: Mapping[str, Any],
    idx: int,
) -> str:
    # Try to extract a human-readable label
    for key in ("name", "title", "scope"):
        if val := (item.get(key) or detail.get(key)):
            return str(val)

    # Convert duration to readable format (e.g., 300 minutes -> "5h quota")
    # Check window first, then item, then detail
    duration = _to_int(window.get("duration") or item.get("duration") or detail.get("duration"))
    time_unit = window.get("timeUnit") or item.get("timeUnit") or detail.get("timeUnit") or ""
    if duration:
        if "MINUTE" in time_unit:
            if duration >= 60 and duration % 60 == 0:
                return f"{duration // 60}h limit"
            return f"{duration}m limit"
        if "HOUR" in time_unit:
            return f"{duration}h limit"
        if "DAY" in time_unit:
            return f"{duration}d limit"
        return f"{duration}s limit"

    return f"Limit #{idx + 1}"


def _reset_hint(data: Mapping[str, Any]) -> str | None:
    for key in ("reset_at", "resetAt", "reset_time", "resetTime"):
        if val := data.get(key):
            return _format_reset_time(str(val))

    for key in ("reset_in", "resetIn", "ttl", "window"):
        seconds = _to_int(data.get(key))
        if seconds:
            return f"resets in {format_duration(seconds)}"

    return None


def _format_reset_time(val: str) -> str:
    """Format ISO timestamp to a readable duration."""
    from datetime import UTC, datetime

    try:
        # Parse ISO format like "2025-12-23T05:24:18.443553353Z"
        # Truncate nanoseconds to microseconds for Python compatibility
        if "." in val and val.endswith("Z"):
            base, frac = val[:-1].split(".")
            frac = frac[:6]  # Keep only microseconds
            val = f"{base}.{frac}Z"
        dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
        now = datetime.now(UTC)
        delta = dt - now

        if delta.total_seconds() <= 0:
            return "reset"
        return f"resets in {format_duration(int(delta.total_seconds()))}"
    except (ValueError, TypeError):
        return f"resets at {val}"


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _build_usage_panel(summary: UsageRow | None, limits: list[UsageRow]) -> Panel:
    rows = ([summary] if summary else []) + limits
    if not rows:
        return Panel(
            Text("No usage data", style="grey50"), title="API Usage", border_style="wheat4"
        )

    # Calculate label width for alignment
    label_width = max(len(r.label) for r in rows)
    label_width = max(label_width, 6)  # minimum width

    lines: list[RenderableType] = []
    for row in rows:
        lines.append(_format_row(row, label_width))

    return Panel(
        Group(*lines),
        title="API Usage",
        border_style="wheat4",
        padding=(0, 2),
        expand=False,
    )


def _format_row(row: UsageRow, label_width: int) -> RenderableType:
    ratio = row.used / row.limit if row.limit > 0 else 0
    color = _ratio_color(ratio)

    label = Text(f"{row.label:<{label_width}}  ", style="cyan")
    bar = ProgressBar(total=row.limit or 1, completed=row.used, width=20, complete_style=color)

    detail = Text()
    detail.append(
        f"  {row.used:,} / {row.limit:,}" if row.limit else f"  {row.used:,}", style="bold"
    )
    if row.reset_hint:
        detail.append(f"  ({row.reset_hint})", style="grey50")

    t = Table.grid(padding=0)
    t.add_column(width=label_width + 2)
    t.add_column(width=20)
    t.add_column()
    t.add_row(label, bar, detail)
    return t


def _ratio_color(ratio: float) -> str:
    if ratio >= 0.9:
        return "red"
    if ratio >= 0.7:
        return "yellow"
    return "green"
