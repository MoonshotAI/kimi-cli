import json
import shutil
from typing import cast

import streamingjson  # type: ignore[reportMissingTypeStubs]
from kaos.path import KaosPath
from kosong.utils.typing import JsonType

from kimi_cli.utils.string import shorten_middle

# Minimum and maximum width for key argument display
_MIN_KEY_ARG_WIDTH = 50
_MAX_KEY_ARG_WIDTH = 120
# Approximate overhead for "• Used Shell ()" prefix
_KEY_ARG_OVERHEAD = 20


def _get_key_argument_width() -> int:
    """Get width for key argument based on terminal size."""
    try:
        term_width = shutil.get_terminal_size().columns
    except (ValueError, OSError):
        return _MIN_KEY_ARG_WIDTH
    # Leave room for the prefix and some padding
    available = term_width - _KEY_ARG_OVERHEAD
    return max(_MIN_KEY_ARG_WIDTH, min(available, _MAX_KEY_ARG_WIDTH))


class SkipThisTool(Exception):
    """Raised when a tool decides to skip itself from the loading process."""

    pass


def extract_key_argument(
    json_content: str | streamingjson.Lexer, tool_name: str, *, width: int | None = None
) -> str | None:
    if isinstance(json_content, streamingjson.Lexer):
        json_str = json_content.complete_json()
    else:
        json_str = json_content
    try:
        curr_args: JsonType = json.loads(json_str)
    except json.JSONDecodeError:
        return None
    if not curr_args:
        return None
    key_argument: str = ""
    match tool_name:
        case "Task":
            if not isinstance(curr_args, dict) or not curr_args.get("description"):
                return None
            key_argument = str(curr_args["description"])
        case "CreateSubagent":
            if not isinstance(curr_args, dict) or not curr_args.get("name"):
                return None
            key_argument = str(curr_args["name"])
        case "SendDMail":
            return None
        case "Think":
            if not isinstance(curr_args, dict) or not curr_args.get("thought"):
                return None
            key_argument = str(curr_args["thought"])
        case "SetTodoList":
            return None
        case "Shell":
            if not isinstance(curr_args, dict) or not curr_args.get("command"):
                return None
            key_argument = str(curr_args["command"])
        case "ReadFile":
            if not isinstance(curr_args, dict) or not curr_args.get("path"):
                return None
            key_argument = _normalize_path(str(curr_args["path"]))
        case "ReadMediaFile":
            if not isinstance(curr_args, dict) or not curr_args.get("path"):
                return None
            key_argument = _normalize_path(str(curr_args["path"]))
        case "Glob":
            if not isinstance(curr_args, dict) or not curr_args.get("pattern"):
                return None
            key_argument = str(curr_args["pattern"])
        case "Grep":
            if not isinstance(curr_args, dict) or not curr_args.get("pattern"):
                return None
            key_argument = str(curr_args["pattern"])
        case "WriteFile":
            if not isinstance(curr_args, dict) or not curr_args.get("path"):
                return None
            key_argument = _normalize_path(str(curr_args["path"]))
        case "StrReplaceFile":
            if not isinstance(curr_args, dict) or not curr_args.get("path"):
                return None
            key_argument = _normalize_path(str(curr_args["path"]))
        case "SearchWeb":
            if not isinstance(curr_args, dict) or not curr_args.get("query"):
                return None
            key_argument = str(curr_args["query"])
        case "FetchURL":
            if not isinstance(curr_args, dict) or not curr_args.get("url"):
                return None
            key_argument = str(curr_args["url"])
        case _:
            if isinstance(json_content, streamingjson.Lexer):
                # lexer.json_content is list[str] based on streamingjson source code
                content: list[str] = cast(list[str], json_content.json_content)  # type: ignore[reportUnknownMemberType]
                key_argument = "".join(content)
            else:
                key_argument = json_content
    if width is None:
        width = _get_key_argument_width()
    key_argument = shorten_middle(key_argument, width=width)
    return key_argument


def _normalize_path(path: str) -> str:
    cwd = str(KaosPath.cwd().canonical())
    if path.startswith(cwd):
        path = path[len(cwd) :].lstrip("/\\")
    return path
