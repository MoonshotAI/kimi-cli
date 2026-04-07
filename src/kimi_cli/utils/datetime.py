from datetime import datetime, timedelta


def format_relative_time(timestamp: float) -> str:
    """Format a timestamp as a relative time string."""
    now = datetime.now()
    dt = datetime.fromtimestamp(timestamp)
    diff = now - dt
    if diff < timedelta(minutes=5):
        return "just now"
    if diff < timedelta(hours=1):
        minutes = int(diff.total_seconds() / 60)
        return f"{minutes}m ago"
    if diff < timedelta(days=1):
        hours = int(diff.total_seconds() / 3600)
        return f"{hours}h ago"
    if diff < timedelta(days=7):
        return f"{diff.days}d ago"
    return dt.strftime("%m-%d")


def format_duration(seconds: int) -> str:
    """Format a duration in seconds using short units."""
    delta = timedelta(seconds=seconds)
    parts: list[str] = []
    days = delta.days
    if days:
        parts.append(f"{days}d")
    hours, remainder = divmod(delta.seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if secs and not parts:
        parts.append(f"{secs}s")
    return " ".join(parts) or "0s"


def format_elapsed(seconds: float) -> str:
    """Format elapsed seconds for spinner display.

    Unlike :func:`format_duration` (which omits seconds when minutes are
    present), this always includes seconds for sub-hour durations so that
    spinner text stays precise::

        0.5  -> "<1s"
        5    -> "5s"
        90   -> "1m 30s"
        3661 -> "1h 1m 1s"
    """
    if seconds < 1:
        return "<1s"
    total = int(seconds)
    if total < 60:
        return f"{total}s"
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return " ".join(parts)
