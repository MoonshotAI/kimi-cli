import json
from pathlib import Path
from typing import cast

import streamingjson  # pyright: ignore[reportMissingTypeStubs]
from kosong.utils.typing import JsonType

from kimi_cli.utils.string import shorten_middle


class SkipThisTool(Exception):
    """Raised when a tool decides to skip itself from the loading process."""

    pass


def extract_key_argument(json_content: str | streamingjson.Lexer, tool_name: str) -> str | None:
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
        case "SendDMail":
            return "El Psy Kongroo"
        case "Think":
            if not isinstance(curr_args, dict) or not curr_args.get("thought"):
                return None
            key_argument = str(curr_args["thought"])
        case "SetTodoList":
            return None
        case "Bash":
            if not isinstance(curr_args, dict) or not curr_args.get("command"):
                return None
            key_argument = str(curr_args["command"])
        case "ReadFile":
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
                content: list[str] = cast(list[str], json_content.json_content)  # pyright: ignore[reportUnknownMemberType]
                key_argument = "".join(content)
            else:
                key_argument = json_content
    key_argument = shorten_middle(key_argument, width=50)
    return key_argument


def _normalize_path(path: str) -> str:
    cwd = str(Path.cwd().absolute())
    if path.startswith(cwd):
        path = path[len(cwd) :].lstrip("/\\")
    return path
