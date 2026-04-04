"""TPS meter display preference - mirrors the theme pattern.

This module provides a global state for the TPS meter display setting,
similar to how theme.py manages the active color theme.
"""

# Module-level private state
_show_tps_meter: bool = False


def set_show_tps_meter(enabled: bool) -> None:
    """Set whether the TPS meter should be displayed in the status bar.

    Args:
        enabled: True to show the TPS meter, False to hide it.
    """
    global _show_tps_meter
    _show_tps_meter = enabled


def get_show_tps_meter() -> bool:
    """Get whether the TPS meter should be displayed.

    Returns:
        True if the TPS meter should be shown, False otherwise.
    """
    return _show_tps_meter
