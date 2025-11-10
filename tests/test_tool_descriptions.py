# ruff: noqa

import platform
import pytest
from inline_snapshot import snapshot

from kimi_cli.tools.bash import Bash
from kimi_cli.tools.dmail import SendDMail
from kimi_cli.tools.file.glob import Glob
from kimi_cli.tools.file.grep import Grep
from kimi_cli.tools.file.patch import PatchFile
from kimi_cli.tools.file.read import ReadFile
from kimi_cli.tools.file.replace import StrReplaceFile
from kimi_cli.tools.file.write import WriteFile
from kimi_cli.tools.task import Task
from kimi_cli.tools.think import Think
from kimi_cli.tools.todo import SetTodoList
from kimi_cli.tools.web.fetch import FetchURL
from kimi_cli.tools.web.search import SearchWeb


def test_task_description(task_tool: Task):
    """Test the description of Task tool."""
    assert task_tool.base.description == snapshot(
        """\
Spawn a subagent to perform a specific task. Subagent will be spawned with a fresh context without any history of yours.

**Context Isolation**

Context isolation is one of the key benefits of using subagents. By delegating tasks to subagents, you can keep your main context clean and focused on the main goal requested by the user.

Here are some scenarios you may want this tool for context isolation:

- You wrote some code and it did not work as expected. In this case you can spawn a subagent to fix the code, asking the subagent to return how it is fixed. This can potentially benefit because the detailed process of fixing the code may not be relevant to your main goal, and may clutter your context.
- When you need some latest knowledge of a specific library, framework or technology to proceed with your task, you can spawn a subagent to search on the internet for the needed information and return to you the gathered relevant information, for example code examples, API references, etc. This can avoid ton of irrelevant search results in your own context.

DO NOT directly forward the user prompt to Task tool. DO NOT simply spawn Task tool for each todo item. This will cause the user confused because the user cannot see what the subagent do. Only you can see the response from the subagent. So, only spawn subagents for very specific and narrow tasks like fixing a compilation error, or searching for a specific solution.

**Parallel Multi-Tasking**

Parallel multi-tasking is another key benefit of this tool. When the user request involves multiple subtasks that are independent of each other, you can use Task tool multiple times in a single response to let subagents work in parallel for you.

Examples:

- User requests to code, refactor or fix multiple modules/files in a project, and they can be tested independently. In this case you can spawn multiple subagents each working on a different module/file.
- When you need to analyze a huge codebase (> hundreds of thousands of lines), you can spawn multiple subagents each exploring on a different part of the codebase and gather the summarized results.
- When you need to search the web for multiple queries, you can spawn multiple subagents for better efficiency.

**Available Subagents:**

- `coder`: Good at general software engineering tasks.
"""
    )


def test_send_dmail_description(send_dmail_tool: SendDMail):
    """Test the description of SendDMail tool."""
    assert send_dmail_tool.base.description == snapshot(
        """\
Send a message to the past, just like sending a D-Mail in Steins;Gate.

You can see some `user` messages with `CHECKPOINT {checkpoint_id}` wrapped in `<system>` tags in the context. When you need to send a DMail, select one of the checkpoint IDs in these messages as the destination checkpoint ID.

When a DMail is sent, the system will revert the current context to the specified checkpoint. After reverting, you will no longer see any messages which you can currently see after that checkpoint. The message in the DMail will be appended to the end of the context. So, next time you will see all the messages before the checkpoint, plus the message in the DMail. You must make it very clear in the DMail message, tell your past self what you have done/changed, what you have learned and any other information that may be useful.

When sending a DMail, DO NOT do much explanation to the user. The user do not care about this. Just explain to your past self.

Here are some typical scenarios you may want to send a DMail:

- You read a file, found it very large and most of the content is not relevant to the current task. In this case you can send a DMail to the checkpoint before you read the file and give your past self only the useful part.
- You searched the web, found the result very large.
  - If you got what you need, you may send a DMail to the checkpoint before you searched the web and give your past self the useful part.
  - If you did not get what you need, you may send a DMail to tell your past self to try another query.
- You wrote some code and it did not work as expected. You spent many struggling steps to fix it but the process is not relevant to the ultimate goal. In this case you can send a DMail to the checkpoint before you wrote the code and give your past self the fixed version of the code and tell yourself no need to write it again because you already wrote to the filesystem.
"""
    )


def test_think_description(think_tool: Think):
    """Test the description of Think tool."""
    assert think_tool.base.description == snapshot(
        "Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.\n"
    )


def test_set_todo_list_description(set_todo_list_tool: SetTodoList):
    """Test the description of SetTodoList tool."""
    assert set_todo_list_tool.base.description == snapshot(
        """\
Update the whole todo list.

Todo list is a simple yet powerful tool to help you get things done. You typically want to use this tool when the given task involves multiple subtasks/milestones, or, multiple tasks are given in a single request. This tool can help you to break down the task and track the progress.

This is the only todo list tool available to you. That said, each time you want to operate on the todo list, you need to update the whole. Make sure to maintain the todo items and their statuses properly.

Once you finished a subtask/milestone, remember to update the todo list to reflect the progress. Also, you can give yourself a self-encouragement to keep you motivated.

Abusing this tool to track too small steps will just waste your time and make your context messy. For example, here are some cases you should not use this tool:

- When the user just simply ask you a question. E.g. "What language and framework is used in the project?", "What is the best practice for x?"
- When it only takes a few steps/tool calls to complete the task. E.g. "Fix the unit test function 'test_xxx'", "Refactor the function 'xxx' to make it more solid."
- When the user prompt is very specific and the only thing you need to do is brainlessly following the instructions. E.g. "Replace xxx to yyy in the file zzz", "Create a file xxx with content yyy."

However, do not get stuck in a rut. Be flexible. Sometimes, you may try to use todo list at first, then realize the task is too simple and you can simply stop using it; or, sometimes, you may realize the task is complex after a few steps and then you can start using todo list to break it down.
"""
    )


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
def test_bash_description(bash_tool: Bash):
    """Test the description of Bash tool."""
    assert bash_tool.base.description == snapshot(
        """\
Execute a shell command. Use this tool to explore the filesystem, edit files, run scripts, get system information, etc.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command failed, the exit code will be provided in a system tag.

**Guidelines for safety and security:**
- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls.
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, you shall set `timeout` argument to a reasonable value.
- Avoid using `..` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- For multiple related commands, use `&&` to chain them in a single call, e.g. `cd /path && ls -la`
- Use `;` to run commands sequentially regardless of success/failure
- Use `||` for conditional execution (run second command only if first fails)
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Use `if`, `case`, `for`, `while` control flows to execute complex logic in a single call.
- Verify directory structure before create/edit/delete files or directories to reduce the risk of failure.

**Commands available:**
- Shell environment: cd, pwd, export, unset, env
- File system operations: ls, find, mkdir, rm, cp, mv, touch, chmod, chown
- File viewing/editing: cat, grep, head, tail, diff, patch
- Text processing: awk, sed, sort, uniq, wc
- System information/operations: ps, kill, top, df, free, uname, whoami, id, date
- Package management: pip, uv, npm, yarn, bun, cargo
- Network operations: curl, wget, ping, telnet, ssh
- Archive operations: tar, zip, unzip
- Other: Other commands available in the shell environment. Check the existence of a command by running `which <command>` before using it.
"""
    )


def test_read_file_description(read_file_tool: ReadFile):
    """Test the description of ReadFile tool."""
    assert read_file_tool.base.description == snapshot(
        """\
Read content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- Content will be returned with a line number before each line like `cat -n` format.
- Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.
- The maximum number of lines that can be read at once is 1000.
- Any lines longer than 2000 characters will be truncated, ending with "...".
- The system will notify you when there is any limitation hit when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read text files. To list directories, you must use the Glob tool or `ls` command via the Bash tool. To read other file types, use appropriate commands via the Bash tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.
"""
    )


def test_glob_description(glob_tool: Glob):
    """Test the description of Glob tool."""
    assert glob_tool.base.description == snapshot(
        """\
Find files and directories using glob patterns. This tool supports standard glob syntax like `*`, `?`, and `**` for recursive searches.

**When to use:**
- Find files matching specific patterns (e.g., all Python files: `*.py`)
- Search for files recursively in subdirectories (e.g., `src/**/*.js`)
- Locate configuration files (e.g., `*.config.*`, `*.json`)
- Find test files (e.g., `test_*.py`, `*_test.go`)

**Example patterns:**
- `*.py` - All Python files in current directory
- `src/**/*.js` - All JavaScript files in src directory recursively
- `test_*.py` - Python test files starting with "test_"
- `*.config.{js,ts}` - Config files with .js or .ts extension

**Bad example patterns:**
- `**`, `**/*.py` - Any pattern starting with '**' will be rejected. Because it would recursively search all directories and subdirectories, which is very likely to yield large result that exceeds your context size. Always use more specific patterns like `src/**/*.py` instead.
- `node_modules/**/*.js` - Although this does not start with '**', it would still highly possible to yield large result because `node_modules` is well-known to contain too many directories and files. Avoid recursively searching in such directories, other examples include `venv`, `.venv`, `__pycache__`, `target`. If you really need to search in a dependency, use more specific patterns like `node_modules/react/src/*` instead.
"""
    )


def test_grep_description(grep_tool: Grep):
    """Test the description of Grep tool."""
    assert grep_tool.base.description == snapshot(
        """\
A powerful search tool based-on ripgrep.

**Tips:**
- ALWAYS use Grep tool instead of running `grep` or `rg` command with Bash tool.
- Use the ripgrep pattern syntax, not grep syntax. E.g. you need to escape braces like `\\\\{` to search for `{`.
"""
    )


def test_write_file_description(write_file_tool: WriteFile):
    """Test the description of WriteFile tool."""
    assert write_file_tool.base.description == snapshot(
        """\
Write content to a file.

**Tips:**
- When `mode` is not specified, it defaults to `overwrite`. Always write with caution.
- When the content to write is too long (e.g. > 100 lines), use this tool multiple times instead of a single call. Use `overwrite` mode at the first time, then use `append` mode after the first write.
"""
    )


def test_str_replace_file_description(str_replace_file_tool: StrReplaceFile):
    """Test the description of StrReplaceFile tool."""
    assert str_replace_file_tool.base.description == snapshot(
        """\
Replace specific strings within a specified file.

**Tips:**
- Only use this tool on text files.
- Multi-line strings are supported.
- Can specify a single edit or a list of edits in one call.
- You should prefer this tool over WriteFile tool and Bash `sed` command.
"""
    )


def test_patch_file_description(patch_file_tool: PatchFile):
    """Test the description of PatchFile tool."""
    assert patch_file_tool.base.description == snapshot(
        """\
Apply a unified diff patch to a file.

**Tips:**
- The patch must be in unified diff format, the format used by `diff -u` and `git diff`.
- Only use this tool on text files.
- The tool will fail with error returned if the patch doesn't apply cleanly.
- The file must exist before applying the patch.
- You should prefer this tool over WriteFile tool and Bash `sed` command when editing an existing file.
"""
    )


def test_search_web_description(search_web_tool: SearchWeb):
    """Test the description of MoonshotSearch tool."""
    assert search_web_tool.base.description == snapshot(
        "WebSearch tool allows you to search on the internet to get latest information, including news, documents, release notes, blog posts, papers, etc.\n"
    )


def test_fetch_url_description(fetch_url_tool: FetchURL):
    """Test the description of FetchURL tool."""
    assert fetch_url_tool.base.description == snapshot(
        "Fetch a web page from a URL and extract main text content from it.\n"
    )
