from __future__ import annotations

# ruff: noqa

from inline_snapshot import snapshot

from kimi_cli.tools.multiagent.create import CreateSubagent
from kimi_cli.tools.shell import Shell
from kimi_cli.tools.dmail import SendDMail
from kimi_cli.tools.file.glob import Glob
from kimi_cli.tools.file.grep_local import Grep
from kimi_cli.tools.file.read import ReadFile
from kimi_cli.tools.file.replace import StrReplaceFile
from kimi_cli.tools.file.write import WriteFile
from kimi_cli.tools.multiagent.task import Task
from kimi_cli.tools.think import Think
from kimi_cli.tools.todo import SetTodoList
from kimi_cli.tools.web.fetch import FetchURL
from kimi_cli.tools.web.search import SearchWeb


def test_task_params_schema(task_tool: Task):
    """Test the schema of Task tool parameters."""
    assert task_tool.base.parameters == snapshot(
        {
            "properties": {
                "description": {
                    "description": "A short (3-5 word) description of the task",
                    "type": "string",
                },
                "subagent_name": {
                    "description": "The name of the specialized subagent to use for this task",
                    "type": "string",
                },
                "prompt": {
                    "description": "The task for the subagent to perform. You must provide a detailed prompt with all necessary background information because the subagent cannot see anything in your context.",
                    "type": "string",
                },
            },
            "required": ["description", "subagent_name", "prompt"],
            "type": "object",
        }
    )


def test_create_subagent_params_schema(create_subagent_tool: CreateSubagent):
    """Test the schema of CreateSubagent tool parameters."""
    assert create_subagent_tool.base.parameters == snapshot(
        {
            "properties": {
                "name": {
                    "description": "Unique name for this agent configuration (e.g., 'summarizer', 'code_reviewer'). This name will be used to reference the agent in the Task tool.",
                    "type": "string",
                },
                "system_prompt": {
                    "description": "System prompt defining the agent's role, capabilities, and boundaries.",
                    "type": "string",
                },
            },
            "required": ["name", "system_prompt"],
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
                    "description": "The updated todo list",
                    "items": {
                        "properties": {
                            "title": {
                                "description": "The title of the todo",
                                "minLength": 1,
                                "type": "string",
                            },
                            "status": {
                                "description": "The status of the todo",
                                "enum": ["Pending", "In Progress", "Done"],
                                "type": "string",
                            },
                        },
                        "required": ["title", "status"],
                        "type": "object",
                    },
                    "type": "array",
                }
            },
            "required": ["todos"],
            "type": "object",
        }
    )


def test_shell_params_schema(shell_tool: Shell):
    """Test the schema of Shell tool parameters."""
    assert shell_tool.base.parameters == snapshot(
        {
            "properties": {
                "command": {
                    "description": "The bash command to execute.",
                    "type": "string",
                },
                "timeout": {
                    "default": 60,
                    "description": "The timeout in seconds for the command to execute. If the command takes longer than this, it will be killed.",
                    "maximum": 300,
                    "minimum": 1,
                    "type": "integer",
                },
            },
            "required": ["command"],
            "type": "object",
        }
    )


def test_read_file_params_schema(read_file_tool: ReadFile):
    """Test the schema of ReadFile tool parameters."""
    assert read_file_tool.base.parameters == snapshot(
        {
            "properties": {
                "path": {
                    "description": "The absolute path to the file to read",
                    "type": "string",
                },
                "line_offset": {
                    "default": 1,
                    "description": "The line number to start reading from. By default read from the beginning of the file. Set this when the file is too large to read at once.",
                    "minimum": 1,
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
                    "default": False,
                    "description": "Show line numbers in output (the `-n` option). Requires `output_mode` to be `content`.",
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
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": None,
                    "description": "Limit output to first N lines, equivalent to `| head -N`. Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count_matches (limits count entries). By default, no limit is applied.",
                },
                "multiline": {
                    "default": False,
                    "description": "Enable multiline mode where `.` matches newlines and patterns can span lines (the `-U` and `--multiline-dotall` options). By default, multiline mode is disabled.",
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
                    "description": "The absolute path to the file to write",
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
                    "description": "The absolute path to the file to edit.",
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
