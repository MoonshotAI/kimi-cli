mod tool_test_utils;

use kagent::soul::toolset::KimiToolset;
use kagent::tools::dmail::SendDMail;
use kagent::tools::file::{Glob, Grep, ReadFile, ReadMediaFile, StrReplaceFile, WriteFile};
use kagent::tools::multiagent::{CreateSubagent, TaskTool};
use kagent::tools::shell::Shell;
use kagent::tools::think::Think;
use kagent::tools::todo::SetTodoList;
use kagent::tools::web::{FetchURL, SearchWeb};
use kosong::tooling::CallableTool;
use std::sync::Arc;

use tool_test_utils::RuntimeFixture;

fn normalize_required(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Array(required)) = map.get_mut("required") {
                required.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
            for item in map.values_mut() {
                normalize_required(item);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                normalize_required(item);
            }
        }
        _ => {}
    }
}

fn assert_schema_eq(actual: serde_json::Value, expected: serde_json::Value) {
    let mut actual = actual;
    let mut expected = expected;
    normalize_required(&mut actual);
    normalize_required(&mut expected);
    assert_eq!(actual, expected);
}

#[test]
fn test_task_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = TaskTool::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
        }),
    );
}

#[test]
fn test_create_subagent_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = CreateSubagent::new(
        Arc::new(tokio::sync::Mutex::new(KimiToolset::new())),
        &fixture.runtime,
    );
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
        }),
    );
}

#[test]
fn test_send_dmail_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = SendDMail::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
        }),
    );
}

#[test]
fn test_think_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = Think::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
            "properties": {
                "thought": {
                    "description": "A thought to think about.",
                    "type": "string",
                }
            },
            "required": ["thought"],
            "type": "object",
        }),
    );
}

#[test]
fn test_set_todo_list_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = SetTodoList::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
                                "enum": ["pending", "in_progress", "done"],
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
        }),
    );
}

#[test]
fn test_shell_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = Shell::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
        }),
    );
}

#[test]
fn test_read_file_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
            "properties": {
                "path": {
                    "description": "The path to the file to read. Absolute paths are required when reading files outside the working directory.",
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
        }),
    );
}

#[test]
fn test_read_media_file_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
            "properties": {
                "path": {
                    "description": "The path to the file to read. Absolute paths are required when reading files outside the working directory.",
                    "type": "string",
                }
            },
            "required": ["path"],
            "type": "object",
        }),
    );
}

#[test]
fn test_glob_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = Glob::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
            "properties": {
                "pattern": {
                    "description": "Glob pattern to match files/directories.",
                    "type": "string",
                },
                "directory": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": null,
                    "description": "Absolute path to the directory to search in (defaults to working directory).",
                },
                "include_dirs": {
                    "default": true,
                    "description": "Whether to include directories in results.",
                    "type": "boolean",
                },
            },
            "required": ["pattern"],
            "type": "object",
        }),
    );
}

#[test]
fn test_grep_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
                    "default": null,
                    "description": "Glob pattern to filter files (e.g. `*.js`, `*.{ts,tsx}`). No filter by default.",
                },
                "output_mode": {
                    "default": "files_with_matches",
                    "description": "`content`: Show matching lines (supports `-B`, `-A`, `-C`, `-n`, `head_limit`); `files_with_matches`: Show file paths (supports `head_limit`); `count_matches`: Show total number of matches. Defaults to `files_with_matches`.",
                    "type": "string",
                },
                "-B": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": null,
                    "description": "Number of lines to show before each match (the `-B` option). Requires `output_mode` to be `content`.",
                },
                "-A": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": null,
                    "description": "Number of lines to show after each match (the `-A` option). Requires `output_mode` to be `content`.",
                },
                "-C": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": null,
                    "description": "Number of lines to show before and after each match (the `-C` option). Requires `output_mode` to be `content`.",
                },
                "-n": {
                    "default": false,
                    "description": "Show line numbers in output (the `-n` option). Requires `output_mode` to be `content`.",
                    "type": "boolean",
                },
                "-i": {
                    "default": false,
                    "description": "Case insensitive search (the `-i` option).",
                    "type": "boolean",
                },
                "type": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": null,
                    "description": "File type to search. Examples: py, rust, js, ts, go, java, etc. More efficient than `glob` for standard file types.",
                },
                "head_limit": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": null,
                    "description": "Limit output to first N lines, equivalent to `| head -N`. Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count_matches (limits count entries). By default, no limit is applied.",
                },
                "multiline": {
                    "default": false,
                    "description": "Enable multiline mode where `.` matches newlines and patterns can span lines (the `-U` and `--multiline-dotall` options). By default, multiline mode is disabled.",
                    "type": "boolean",
                },
            },
            "required": ["pattern"],
            "type": "object",
        }),
    );
}

#[test]
fn test_write_file_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
        }),
    );
}

#[test]
fn test_str_replace_file_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
                                    "default": false,
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
                                        "default": false,
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
        }),
    );
}

#[test]
fn test_search_web_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = SearchWeb::new(&fixture.runtime).expect("search web tool");
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
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
                    "default": false,
                    "description": "Whether to include the content of the web pages in the results. It can consume a large amount of tokens when this is set to True. You should avoid enabling this when `limit` is set to a large value.",
                    "type": "boolean",
                },
            },
            "required": ["query"],
            "type": "object",
        }),
    );
}

#[test]
fn test_fetch_url_params_schema() {
    let fixture = RuntimeFixture::new();
    let tool = FetchURL::new(&fixture.runtime);
    let base = tool.base();
    assert_schema_eq(
        base.parameters,
        serde_json::json!({
            "properties": {
                "url": {
                    "description": "The URL to fetch content from.",
                    "type": "string",
                }
            },
            "required": ["url"],
            "type": "object",
        }),
    );
}
