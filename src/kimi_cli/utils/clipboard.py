import pyperclip
from pyperclip import PyperclipException


def is_clipboard_available() -> bool:
    try:
        pyperclip.paste()
        return True
    except PyperclipException:
        return False
