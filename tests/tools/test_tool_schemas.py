from __future__ import annotations

# ruff: noqa

from inline_snapshot import snapshot

from kimi_cli.tools.agent import Agent as AgentTool
from kimi_cli.tools.background import TaskList, TaskOutput, TaskStop
from kimi_cli.tools.dmail import SendDMail
from kimi_cli.tools.file.glob import Glob
from kimi_cli.tools.file.grep_local import Grep
from kimi_cli.tools.file.read import ReadFile
from kimi_cli.tools.file.read_media import ReadMediaFile
from kimi_cli.tools.file.replace import StrReplaceFile
from kimi_cli.tools.file.write import WriteFile
from kimi_cli.tools.shell import Shell
from kimi_cli.tools.think import Think
from kimi_cli.tools.todo import SetTodoList
from kimi_cli.tools.web.fetch import FetchURL
from kimi_cli.tools.web.search import SearchWeb


def test_agent_params_schema(agent_tool: AgentTool):
    """Test the schema of Agent tool parameters."""
    assert agent_tool.base.parameters == snapshot(
        {
            "properties": {
                "description": {
                    "description": "A short (3-5 word) description of the task",
                    "type": "string",
                },
                "prompt": {
                    "description": "The task for the agent to perform",
                    "type": "string",
                },
                "subagent_type": {
                    "default": "coder",
                    "description": "The built-in agent type to use. Defaults to `coder`.",
                    "type": "string",
                },
                "model": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": None,
                    "description": "Optional model override. Selection priority is: this parameter, then the built-in type default model, then the parent agent's current model.",
                },
                "resume": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": None,
                    "description": "Optional agent ID to resume instead of creating a new instance.",
                },
                "run_in_background": {
                    "default": False,
                    "description": "Whether to run the agent in the background. Prefer false unless the task can continue independently and there is a clear benefit to returning control before the result is needed.",
                    "type": "boolean",
                },
                "timeout": {
                    "anyOf": [
                        {"maximum": 3600, "minimum": 30, "type": "integer"},
                        {"type": "null"},
                    ],
                    "default": None,
                    "description": "Timeout in seconds for the agent task. Foreground: no default timeout (runs until completion), max 3600s (1hr). Background: default from config (15min), max 3600s (1hr). The agent is stopped if it exceeds this limit.",
                },
                "work_dir": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": None,
                    "description": "Optional working directory for the subagent. When set, the subagent's file tools and system prompt will use this directory instead of the parent agent's working directory. Must be an absolute path.",
                },
            },
            "required": ["description", "prompt"],
            "type": "object",
        }
    )


def test_send_dmail_params_schema(send_dmail_tool: SendDMail):
    """Test the schema of SendDMail tool parameters."""
    assert send_dmail_tool.base.parameters == snapshot(
        {
            "properties": {
                "message": {"description": "The message to send.", "type": "string"},
                "checkpoint_id": {
                    "description": "The checkpoint to send the message back to.",
                    "minimum": 0,
                    "type": "integer",
                },
            },
            "required": ["message", "checkpoint_id"],
            "type": "object",
        }
    )


def test_think_params_schema(think_tool: Think):
    """Test the schema of Think tool parameters."""
    assert think_tool.base.parameters == snapshot(
        {
            "properties": {
                "thought": {
                    "description": "A thought to think about.",
                    "type": "string",
                }
            },
            "required": ["thought"],
            "type": "object",
        }
    )


def test_set_todo_list_params_schema(set_todo_list_tool: SetTodoList):
    """Test the schema of SetTodoList tool parameters."""
    assert set_todo_list_tool.base.parameters == snapshot(
        {
            "properties": {
                "todos": {
                    "anyOf": [
                        {
                            "items": {
                                "properties": {
                                    "title": {
                                        "description": "The title of the todo",
                                        "minLength": 1,
                                        "type": "string",
                                    },
                                    "status": {
                                        "description": "The status of the todo",
                                        "enum": ["pending", "in_progress", "done"],
                                        "type": "string",
                                    },
                                },
                                "required": ["title", "status"],
                                "type": "object",
                            },
                            "type": "array",
                        },
                        {"type": "null"},
                    ],
                    "default": None,
                    "description": "The updated todo list. If not provided, returns the current todo list without making changes.",
                }
            },
            "type": "object",
        }
    )


def test_shell_params_schema(shell_tool: Shell):
    """Test the schema of Shell tool parameters."""
    assert shell_tool.base.parameters == snapshot(
        {
            "properties": {
                "command": {
                    "description": "The command to execute.",
                    "type": "string",
                },
                "timeout": {
                    "default": 60,
                    "description": "The timeout in seconds for the command to execute. If the command takes longer than this, it will be killed.",
                    "maximum": 86400,
                    "minimum": 1,
                    "type": "integer",
                },
                "run_in_background": {
                    "default": False,
                    "description": "Whether to run the command as a background task.",
                    "type": "boolean",
                },
                "description": {
                    "default": "",
                    "description": "A short description for the background task. Required when run_in_background=true.",
                    "type": "string",
                },
            },
            "required": ["command"],
            "type": "object",
        }
    )


def test_task_output_params_schema(task_output_tool: TaskOutput):
    assert task_output_tool.base.parameters == snapshot(
        {
            "properties": {
                "task_id": {
                    "description": "The background task ID to inspect.",
                    "type": "string",
                },
                "block": {
                    "default": False,
                    "description": "Whether to wait for the task to finish before returning.",
                    "type": "boolean",
                },
                "timeout": {
                    "default": 30,
                    "description": "Maximum number of seconds to wait when block=true.",
                    "maximum": 3600,
                    "minimum": 0,
                    "type": "integer",
                },
            },
            "required": ["task_id"],
            "type": "object",
        }
    )


def test_task_list_params_schema(task_list_tool: TaskList):
    assert task_list_tool.base.parameters == snapshot(
        {
            "properties": {
                "active_only": {
                    "default": True,
                    "description": "Whether to list only non-terminal background tasks.",
                    "type": "boolean",
                },
                "limit": {
                    "default": 20,
                    "description": "Maximum number of tasks to return.",
                    "maximum": 100,
                    "minimum": 1,
                    "type": "integer",
                },
            },
            "type": "object",
        }
    )


def test_task_stop_params_schema(task_stop_tool: TaskStop):
    assert task_stop_tool.base.parameters == snapshot(
        {
            "properties": {
                "task_id": {
                    "description": "The background task ID to stop.",
                    "type": "string",
                },
                "reason": {
                    "default": "Stopped by TaskStop",
                    "description": "Short reason recorded when the task is stopped.",
                    "type": "string",
                },
            },
            "required": ["task_id"],
            "type": "object",
        }
    )


def test_read_file_params_schema(read_file_tool: ReadFile):
    """Test the schema of ReadFile tool parameters."""
    assert read_file_tool.base.parameters == snapshot(
        {
            "properties": {
                "path": {
                    "description": "The path to the file to read. Absolute paths are required when reading files outside the working directory.",
                    "type": "string",
                },
                "line_offset": {
                    "default": 1,
                    "description": "The line number to start reading from. By default read from the beginning of the file. Set this when the file is too large to read at once. Negative values read from the end of the file (e.g. -100 reads the last 100 lines). The absolute value of negative offset cannot exceed 1000.",
                    "type": "integer",
                },
                "n_lines": {
                    "default": 1000,
                    "description": "The number of lines to read. By default read up to 1000 lines, which is the max allowed value. Set this value when the file is too large to read at once.",
                    "minimum": 1,
                    "type": "integer",
                },
            },
            "required": ["path"],
            "type": "object",
        }
    )


def test_read_media_file_params_schema(read_media_file_tool: ReadMediaFile):
    """Test the schema of ReadMediaFile tool parameters."""
    assert read_media_file_tool.base.parameters == snapshot(
        {
            "properties": {
                "path": {
                    "description": "The path to the file to read. Absolute paths are required when reading files outside the working directory.",
                    "type": "string",
                }
            },
            "required": ["path"],
            "type": "object",
        }
    )


def test_glob_params_schema(glob_tool: Glob):
    """Test the schema of Glob tool parameters."""
    assert glob_tool.base.parameters == snapshot(
        {
            "properties": {
                "pattern": {
                    "description": "Glob pattern to match files/directories.",
                    "type": "string",
                },
                "directory": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": None,
                    "description": "Absolute path to the directory to search in (defaults to working directory).",
                },
                "include_dirs": {
                    "default": True,
                    "description": "Whether to include directories in results.",
                    "type": "boolean",
                },
            },
            "required": ["pattern"],
            "type": "object",
        }
    )


def test_grep_params_schema(grep_tool: Grep):
    """Test the schema of Grep tool parameters."""
    assert grep_tool.base.parameters == snapshot(
        {
            "properties": {
                "pattern": {
                    "description": "The regular expression pattern to search for in file contents",
                    "type": "string",
                },
                "path": {
                    "default": ".",
                    "description": "File or directory to search in. Defaults to current working directory. If specified, it must be an absolute path.",
                    "type": "string",
                },
                "glob": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": None,
                    "description": "Glob pattern to filter files (e.g. `*.js`, `*.{ts,tsx}`). No filter by default.",
                },
                "output_mode": {
                    "default": "files_with_matches",
                    "description": "`content`: Show matching lines (supports `-B`, `-A`, `-C`, `-n`, `head_limit`); `files_with_matches`: Show file paths (supports `head_limit`); `count_matches`: Show total number of matches. Defaults to `files_with_matches`.",
                    "type": "string",
                },
                "-B": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": None,
                    "description": "Number of lines to show before each match (the `-B` option). Requires `output_mode` to be `content`.",
                },
                "-A": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": None,
                    "description": "Number of lines to show after each match (the `-A` option). Requires `output_mode` to be `content`.",
                },
                "-C": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": None,
                    "description": "Number of lines to show before and after each match (the `-C` option). Requires `output_mode` to be `content`.",
                },
                "-n": {
                    "default": True,
                    "description": "Show line numbers in output (the `-n` option). Requires `output_mode` to be `content`. Defaults to true.",
                    "type": "boolean",
                },
                "-i": {
                    "default": False,
                    "description": "Case insensitive search (the `-i` option).",
                    "type": "boolean",
                },
                "type": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": None,
                    "description": "File type to search. Examples: py, rust, js, ts, go, java, etc. More efficient than `glob` for standard file types.",
                },
                "head_limit": {
                    "anyOf": [{"minimum": 0, "type": "integer"}, {"type": "null"}],
                    "default": 250,
                    "description": "Limit output to first N lines/entries, equivalent to `| head -N`. Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count_matches (limits count entries). Defaults to 250. Pass 0 for unlimited (use sparingly — large result sets waste context).",
                },
                "offset": {
                    "default": 0,
                    "description": "Skip first N lines/entries before applying head_limit, equivalent to `| tail -n +N | head -N`. Works across all output modes. Defaults to 0.",
                    "minimum": 0,
                    "type": "integer",
                },
                "multiline": {
                    "default": False,
                    "description": "Enable multiline mode where `.` matches newlines and patterns can span lines (the `-U` and `--multiline-dotall` options). By default, multiline mode is disabled.",
                    "type": "boolean",
                },
                "include_ignored": {
                    "default": False,
                    "description": "Include files that are ignored by `.gitignore`, `.ignore`, and other ignore rules. Useful for searching gitignored artifacts such as build outputs (e.g. `dist/`, `build/`) or `node_modules`. Sensitive files (like `.env`) remain filtered by the sensitive-file protection layer. Defaults to false.",
                    "type": "boolean",
                },
            },
            "required": ["pattern"],
            "type": "object",
        }
    )


def test_write_file_params_schema(write_file_tool: WriteFile):
    """Test the schema of WriteFile tool parameters."""
    assert write_file_tool.base.parameters == snapshot(
        {
            "properties": {
                "path": {
                    "description": "The path to the file to write. Absolute paths are required when writing files outside the working directory.",
                    "type": "string",
                },
                "content": {
                    "description": "The content to write to the file",
                    "type": "string",
                },
                "mode": {
                    "default": "overwrite",
                    "description": "The mode to use to write to the file. Two modes are supported: `overwrite` for overwriting the whole file and `append` for appending to the end of an existing file.",
                    "enum": ["overwrite", "append"],
                    "type": "string",
                },
            },
            "required": ["path", "content"],
            "type": "object",
        }
    )


def test_str_replace_file_params_schema(str_replace_file_tool: StrReplaceFile):
    """Test the schema of StrReplaceFile tool parameters."""
    assert str_replace_file_tool.base.parameters == snapshot(
        {
            "properties": {
                "path": {
                    "description": "The path to the file to edit. Absolute paths are required when editing files outside the working directory.",
                    "type": "string",
                },
                "edit": {
                    "anyOf": [
                        {
                            "properties": {
                                "old": {
                                    "description": "The old string to replace. Can be multi-line.",
                                    "type": "string",
                                },
                                "new": {
                                    "description": "The new string to replace with. Can be multi-line.",
                                    "type": "string",
                                },
                                "replace_all": {
                                    "default": False,
                                    "description": "Whether to replace all occurrences.",
                                    "type": "boolean",
                                },
                            },
                            "required": ["old", "new"],
                            "type": "object",
                        },
                        {
                            "items": {
                                "properties": {
                                    "old": {
                                        "description": "The old string to replace. Can be multi-line.",
                                        "type": "string",
                                    },
                                    "new": {
                                        "description": "The new string to replace with. Can be multi-line.",
                                        "type": "string",
                                    },
                                    "replace_all": {
                                        "default": False,
                                        "description": "Whether to replace all occurrences.",
                                        "type": "boolean",
                                    },
                                },
                                "required": ["old", "new"],
                                "type": "object",
                            },
                            "type": "array",
                        },
                    ],
                    "description": "The edit(s) to apply to the file. You can provide a single edit or a list of edits here.",
                },
            },
            "required": ["path", "edit"],
            "type": "object",
        }
    )


def test_search_web_params_schema(search_web_tool: SearchWeb):
    """Test the schema of MoonshotSearch tool parameters."""
    assert search_web_tool.base.parameters == snapshot(
        {
            "properties": {
                "query": {
                    "description": "The query text to search for.",
                    "type": "string",
                },
                "limit": {
                    "default": 5,
                    "description": "The number of results to return. Typically you do not need to set this value. When the results do not contain what you need, you probably want to give a more concrete query.",
                    "maximum": 20,
                    "minimum": 1,
                    "type": "integer",
                },
                "include_content": {
                    "default": False,
                    "description": "Whether to include the content of the web pages in the results. It can consume a large amount of tokens when this is set to True. You should avoid enabling this when `limit` is set to a large value.",
                    "type": "boolean",
                },
            },
            "required": ["query"],
            "type": "object",
        }
    )


def test_fetch_url_params_schema(fetch_url_tool: FetchURL):
    """Test the schema of FetchURL tool parameters."""
    assert fetch_url_tool.base.parameters == snapshot(
        {
            "properties": {
                "url": {
                    "description": "The URL to fetch content from.",
                    "type": "string",
                }
            },
            "required": ["url"],
            "type": "object",
        }
    )
