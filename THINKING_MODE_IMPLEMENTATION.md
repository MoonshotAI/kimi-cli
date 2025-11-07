# Thinking Mode Sticky Implementation

## Overview
This document describes the implementation of GitHub Issue #177: Making the thinking/non-thinking mode choice sticky across sessions.

## Problem
Previously, Kimi CLI always started in non-thinking mode, regardless of the mode used at the end of the previous session.

## Solution
The thinking mode preference is now persisted per work directory in the metadata file and automatically restored when starting a new session.

## Changes Made

### 1. `src/kimi_cli/metadata.py`
**Added field to `WorkDirMeta` class:**
```python
last_thinking_mode: bool | None = None
"""Last thinking mode preference for this work directory."""
```

This field stores the last thinking mode state for each work directory. It's optional (None by default) to maintain backward compatibility.

### 2. `src/kimi_cli/ui/shell/prompt.py`
**Modified `CustomPromptSession.__init__` to accept initial thinking mode:**
```python
def __init__(
    self, status_provider: Callable[[], StatusSnapshot], initial_thinking: bool = False
):
    # ... existing code ...
    self._thinking: bool = initial_thinking  # Changed from hardcoded False
    self._work_dir: Path = Path.cwd()  # Added to track work directory
```

**Added imports:**
```python
from kimi_cli.metadata import load_metadata, save_metadata
```

**Modified `_switch_thinking` handler to persist changes:**
```python
@_kb.add("tab", filter=~has_completions & is_agent_mode, eager=True)
def _switch_thinking(event: KeyPressEvent) -> None:
    """Toggle thinking mode when Tab is pressed and no completions are shown."""
    self._thinking = not self._thinking
    event.app.invalidate()
    # Save the thinking mode preference to metadata
    try:
        metadata = load_metadata()
        work_dir_meta = next(
            (wd for wd in metadata.work_dirs if wd.path == str(self._work_dir)), None
        )
        if work_dir_meta is not None:
            work_dir_meta.last_thinking_mode = self._thinking
            save_metadata(metadata)
            logger.debug(
                "Saved thinking mode preference: {thinking}", thinking=self._thinking
            )
    except Exception as e:
        logger.warning("Failed to save thinking mode preference: {error}", error=e)
```

### 3. `src/kimi_cli/ui/shell/__init__.py`
**Modified `ShellApp.run()` to load and pass thinking mode:**
```python
# Load the last thinking mode preference from metadata
from kimi_cli.metadata import load_metadata

initial_thinking = False
try:
    metadata = load_metadata()
    work_dir = self.soul._runtime.session.work_dir
    work_dir_meta = next(
        (wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None
    )
    if work_dir_meta is not None and work_dir_meta.last_thinking_mode is not None:
        initial_thinking = work_dir_meta.last_thinking_mode
        logger.debug(
            "Loaded thinking mode preference: {thinking}", thinking=initial_thinking
        )
except Exception as e:
    logger.warning("Failed to load thinking mode preference: {error}", error=e)

with CustomPromptSession(
    lambda: self.soul.status, initial_thinking=initial_thinking
) as prompt_session:
```

## How It Works

1. **On Session Start:**
   - `ShellApp.run()` loads the metadata file
   - Finds the work directory's metadata entry
   - Extracts the `last_thinking_mode` value (if it exists)
   - Passes it to `CustomPromptSession` as `initial_thinking`
   - The prompt session initializes with the saved thinking mode

2. **On Thinking Mode Toggle:**
   - User presses Tab (in agent mode, no completions shown)
   - `_switch_thinking` handler toggles `self._thinking`
   - Handler loads metadata, finds the work directory entry
   - Updates `last_thinking_mode` field
   - Saves metadata back to disk

3. **Per-Directory Isolation:**
   - Each work directory has its own metadata entry
   - Thinking mode preference is stored per directory
   - Switching directories maintains separate preferences

## Backward Compatibility

- The `last_thinking_mode` field is optional (`bool | None`)
- If not set (None), defaults to False (non-thinking mode)
- Existing metadata files without this field will work correctly
- No migration needed for existing installations

## User Experience

**Before:**
1. Start kimi → always in non-thinking mode
2. Toggle to thinking mode (Tab)
3. Exit kimi
4. Start kimi again → back to non-thinking mode ❌

**After:**
1. Start kimi → in non-thinking mode (default)
2. Toggle to thinking mode (Tab) → saved automatically
3. Exit kimi
4. Start kimi again → still in thinking mode ✓
5. Toggle to non-thinking mode (Tab) → saved automatically
6. Exit and restart → in non-thinking mode ✓

## Visual Indicators

- Non-thinking mode: `username✨ ` prompt
- Thinking mode: `username💫 ` prompt
- Bottom toolbar shows: `agent (thinking)` when in thinking mode

## Testing Checklist

- [x] Code compiles without syntax errors
- [x] Metadata model updated with new field
- [x] CustomPromptSession accepts initial_thinking parameter
- [x] Thinking mode toggle saves to metadata
- [x] ShellApp loads thinking mode from metadata
- [ ] Manual testing: Toggle and restart verification
- [ ] Manual testing: Different directories have separate preferences
- [ ] Manual testing: Backward compatibility with existing metadata

## Files Modified

1. `src/kimi_cli/metadata.py` - Added `last_thinking_mode` field
2. `src/kimi_cli/ui/shell/prompt.py` - Added persistence logic
3. `src/kimi_cli/ui/shell/__init__.py` - Added loading logic

## Notes

- The implementation uses the existing metadata persistence mechanism
- Error handling ensures failures don't crash the application
- Debug logging added for troubleshooting
- The feature is transparent to users (no configuration needed)
