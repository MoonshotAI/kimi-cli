# Fix for GitHub Issue #208: Last Two Characters Trimmed

## Problem
In WSL2 (Ubuntu) environments, the last two characters of lines were being trimmed during multi-paragraph output. The characters would disappear completely, with text resuming on the next line but skipping those missing characters.

## Root Cause
The Rich Console library's auto-detection of terminal width in WSL2 environments was inaccurate, causing text wrapping to occur 2 characters too early. This resulted in:
1. Lines wrapping prematurely
2. The last 2 characters being overwritten or lost during the wrapping process
3. Text continuation on the next line skipping those characters

## Solution
Modified `/vercel/sandbox/src/kimi_cli/ui/shell/console.py` to:

1. **Explicit Width Detection**: Detect terminal width using `os.get_terminal_size()` instead of relying solely on Rich's auto-detection
2. **Safety Margin**: Subtract 2 characters from the detected width to prevent premature wrapping
3. **Environment Variable Override**: Support `KIMI_CONSOLE_WIDTH` environment variable for manual width configuration
4. **Graceful Fallback**: Fall back to Rich's auto-detection if explicit detection fails

## Changes Made

### File: `src/kimi_cli/ui/shell/console.py`

**Before:**
```python
from rich.console import Console
from rich.theme import Theme

console = Console(highlight=False, theme=_NEUTRAL_MARKDOWN_THEME)
```

**After:**
```python
import os
import sys

from rich.console import Console
from rich.theme import Theme

from kimi_cli.utils.logging import logger

def _get_console_width() -> int | None:
    """
    Detect the terminal width with a safety margin to prevent character truncation.
    
    Returns:
        int | None: The detected width with safety margin, or None to use auto-detection.
    """
    # Allow manual override via environment variable
    env_width = os.environ.get("KIMI_CONSOLE_WIDTH")
    if env_width:
        try:
            width = int(env_width)
            logger.debug("Using console width from KIMI_CONSOLE_WIDTH: {width}", width=width)
            return width
        except ValueError:
            logger.warning(
                "Invalid KIMI_CONSOLE_WIDTH value: {env_width}, falling back to auto-detection",
                env_width=env_width,
            )

    # Try to detect terminal size
    try:
        size = os.get_terminal_size(sys.stdout.fileno())
        detected_width = size.columns

        # Apply safety margin to prevent character truncation
        # Subtract 2 characters to account for terminal width detection inaccuracies
        # in WSL2 and other environments
        safe_width = max(80, detected_width - 2)

        logger.debug(
            "Detected terminal width: {detected}, using safe width: {safe}",
            detected=detected_width,
            safe=safe_width,
        )
        return safe_width
    except (AttributeError, ValueError, OSError) as e:
        logger.debug("Failed to detect terminal width: {error}, using auto-detection", error=e)
        return None

console = Console(
    highlight=False,
    theme=_NEUTRAL_MARKDOWN_THEME,
    width=_get_console_width(),
)
```

## Benefits

1. **Fixes Character Truncation**: The 2-character safety margin prevents the last characters from being trimmed
2. **User Control**: Users can override width detection via `KIMI_CONSOLE_WIDTH` environment variable
3. **Backward Compatible**: Falls back to Rich's auto-detection if explicit detection fails
4. **Debug Support**: Logs width detection information for troubleshooting
5. **Minimum Width**: Ensures a minimum width of 80 characters for readability

## Usage

### Default Behavior
No changes needed. The fix automatically applies the safety margin.

### Manual Override
If you experience issues or want to set a specific width:

```bash
export KIMI_CONSOLE_WIDTH=140
kimi
```

### Debugging
To see width detection logs, enable debug logging:

```bash
kimi --log-level debug
```

## Testing

The fix has been validated to:
- ✅ Pass ruff linting checks
- ✅ Pass ruff formatting checks
- ✅ Correctly handle environment variable overrides
- ✅ Gracefully handle invalid environment variable values
- ✅ Fall back to auto-detection when terminal is not available
- ✅ Apply the 2-character safety margin correctly

## Impact

This fix affects all text rendering in the Kimi CLI shell interface, including:
- Multi-paragraph responses
- Markdown rendering
- Tool output display
- Status messages

The change is transparent to users and requires no configuration changes unless manual width override is desired.
