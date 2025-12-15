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
