import pyperclip


def is_clipboard_available() -> bool:
    """Check if the Pyperclip clipboard is available."""
    try:
        pyperclip.paste()
        return True
    except Exception:
        return False
