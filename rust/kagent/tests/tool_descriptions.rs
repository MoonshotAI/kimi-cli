mod tool_test_utils;

use kagent::soul::toolset::KimiToolset;
use kagent::tools::dmail::SendDMail;
use kagent::tools::file::{Glob, Grep, ReadFile, ReadMediaFile, StrReplaceFile, WriteFile};
use kagent::tools::multiagent::{CreateSubagent, TaskTool};
use kagent::tools::shell::Shell;
use kagent::tools::think::Think;
use kagent::tools::todo::SetTodoList;
use kagent::tools::web::{FetchURL, SearchWeb};
use kosong::tooling::CallableTool2;
use std::sync::Arc;

use tool_test_utils::{RuntimeFixture, normalize_newlines};

#[test]
fn test_task_description() {
    let fixture = RuntimeFixture::new();
    let tool = TaskTool::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Spawn a subagent to perform a specific task. Subagent will be spawned with a fresh context without any history of yours.\n\
\n\
**Context Isolation**\n\
\n\
Context isolation is one of the key benefits of using subagents. By delegating tasks to subagents, you can keep your main context clean and focused on the main goal requested by the user.\n\
\n\
Here are some scenarios you may want this tool for context isolation:\n\
\n\
- You wrote some code and it did not work as expected. In this case you can spawn a subagent to fix the code, asking the subagent to return how it is fixed. This can potentially benefit because the detailed process of fixing the code may not be relevant to your main goal, and may clutter your context.\n\
- When you need some latest knowledge of a specific library, framework or technology to proceed with your task, you can spawn a subagent to search on the internet for the needed information and return to you the gathered relevant information, for example code examples, API references, etc. This can avoid ton of irrelevant search results in your own context.\n\
\n\
DO NOT directly forward the user prompt to Task tool. DO NOT simply spawn Task tool for each todo item. This will cause the user confused because the user cannot see what the subagent do. Only you can see the response from the subagent. So, only spawn subagents for very specific and narrow tasks like fixing a compilation error, or searching for a specific solution.\n\
\n\
**Parallel Multi-Tasking**\n\
\n\
Parallel multi-tasking is another key benefit of this tool. When the user request involves multiple subtasks that are independent of each other, you can use Task tool multiple times in a single response to let subagents work in parallel for you.\n\
\n\
Examples:\n\
\n\
- User requests to code, refactor or fix multiple modules/files in a project, and they can be tested independently. In this case you can spawn multiple subagents each working on a different module/file.\n\
- When you need to analyze a huge codebase (> hundreds of thousands of lines), you can spawn multiple subagents each exploring on a different part of the codebase and gather the summarized results.\n\
- When you need to search the web for multiple queries, you can spawn multiple subagents for better efficiency.\n\
\n\
**Available Subagents:**\n\
\n\
- `mocker`: The mock agent for testing purposes.\n"
    );
}

#[test]
fn test_create_subagent_description() {
    let fixture = RuntimeFixture::new();
    let tool = CreateSubagent::new(
        Arc::new(tokio::sync::Mutex::new(KimiToolset::new())),
        &fixture.runtime,
    );
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Create a custom subagent with specific system prompt and name for reuse.\n\
\n\
Usage:\n\
- Define specialized agents with custom roles and boundaries\n\
- Created agents can be referenced by name in the Task tool\n\
- Use this when you need a specific agent type not covered by predefined agents\n\
- The created agent configuration will be saved and can be used immediately\n\
\n\
Example workflow:\n\
1. Use CreateSubagent to define a specialized agent (e.g., 'code_reviewer')\n\
2. Use the Task tool with agent='code_reviewer' to launch the created agent\n"
    );
}

#[test]
fn test_send_dmail_description() {
    let fixture = RuntimeFixture::new();
    let tool = SendDMail::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Send a message to the past, just like sending a D-Mail in Steins;Gate.\n\
\n\
This tool is provided to enable you to proactively manage the context. You can see some `user` messages with text `CHECKPOINT {checkpoint_id}` wrapped in `<system>` tags in the context. When you feel there is too much irrelevant information in the current context, you can send a D-Mail to revert the context to a previous checkpoint with a message containing only the useful information. When you send a D-Mail, you must specify an existing checkpoint ID from the before-mentioned messages.\n\
\n\
Typical scenarios you may want to send a D-Mail:\n\
\n\
- You read a file, found it very large and most of the content is not relevant to the current task. In this case you can send a D-Mail immediately to the checkpoint before you read the file and give your past self only the useful part.\n\
- You searched the web, the result is large.\n  - If you got what you need, you may send a D-Mail to the checkpoint before you searched the web and put only the useful result in the mail message.\n  - If you did not get what you need, you may send a D-Mail to tell your past self to try another query.\n\
- You wrote some code and it did not work as expected. You spent many struggling steps to fix it but the process is not relevant to the ultimate goal. In this case you can send a D-Mail to the checkpoint before you wrote the code and give your past self the fixed version of the code and tell yourself no need to write it again because you already wrote to the filesystem.\n\
\n\
After a D-Mail is sent, the system will revert the current context to the specified checkpoint, after which, you will no longer see any messages which you can now see after that checkpoint. The message in the D-Mail will be appended to the end of the context. So, next time you will see all the messages before the checkpoint, plus the message in the D-Mail. You must make it very clear in the message, tell your past self what you have done/changed, what you have learned and any other information that may be useful, so that your past self can continue the task without confusion and will not repeat the steps you have already done.\n\
\n\
You must understand that, unlike D-Mail in Steins;Gate, the D-Mail you send here will not revert the filesystem or any external state. That means, you are basically folding the recent messages in your context into a single message, which can significantly reduce the waste of context window.\n\
\n\
When sending a D-Mail, DO NOT explain to the user. The user do not care about this. Just explain to your past self.\n"
    );
}

#[test]
fn test_think_description() {
    let fixture = RuntimeFixture::new();
    let tool = Think::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.\n"
    );
}

#[test]
fn test_set_todo_list_description() {
    let fixture = RuntimeFixture::new();
    let tool = SetTodoList::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Update the whole todo list.\n\
\n\
Todo list is a simple yet powerful tool to help you get things done. You typically want to use this tool when the given task involves multiple subtasks/milestones, or, multiple tasks are given in a single request. This tool can help you to break down the task and track the progress.\n\
\n\
This is the only todo list tool available to you. That said, each time you want to operate on the todo list, you need to update the whole. Make sure to maintain the todo items and their statuses properly.\n\
\n\
Once you finished a subtask/milestone, remember to update the todo list to reflect the progress. Also, you can give yourself a self-encouragement to keep you motivated.\n\
\n\
Abusing this tool to track too small steps will just waste your time and make your context messy. For example, here are some cases you should not use this tool:\n\
\n\
- When the user just simply ask you a question. E.g. \"What language and framework is used in the project?\", \"What is the best practice for x?\"\n\
- When it only takes a few steps/tool calls to complete the task. E.g. \"Fix the unit test function 'test_xxx'\", \"Refactor the function 'xxx' to make it more solid.\"\n\
- When the user prompt is very specific and the only thing you need to do is brainlessly following the instructions. E.g. \"Replace xxx to yyy in the file zzz\", \"Create a file xxx with content yyy.\"\n\
\n\
However, do not get stuck in a rut. Be flexible. Sometimes, you may try to use todo list at first, then realize the task is too simple and you can simply stop using it; or, sometimes, you may realize the task is complex after a few steps and then you can start using todo list to break it down.\n"
    );
}

#[cfg(not(windows))]
#[test]
fn test_shell_description() {
    let fixture = RuntimeFixture::new();
    let tool = Shell::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Execute a bash (`/bin/bash`) command. Use this tool to explore the filesystem, edit files, run scripts, get system information, etc.\n\
\n\
**Output:**\n\
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command failed, the exit code will be provided in a system tag.\n\
\n\
**Guidelines for safety and security:**\n\
- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls.\n\
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, you shall set `timeout` argument to a reasonable value.\n\
- Avoid using `..` to access files or directories outside of the working directory.\n\
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\n\
- Never run commands that require superuser privileges unless explicitly instructed to do so.\n\
\n\
**Guidelines for efficiency:**\n\
- For multiple related commands, use `&&` to chain them in a single call, e.g. `cd /path && ls -la`\n\
- Use `;` to run commands sequentially regardless of success/failure\n\
- Use `||` for conditional execution (run second command only if first fails)\n\
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands\n\
- Always quote file paths containing spaces with double quotes (e.g., cd \"/path with spaces/\")\n\
- Use `if`, `case`, `for`, `while` control flows to execute complex logic in a single call.\n\
- Verify directory structure before create/edit/delete files or directories to reduce the risk of failure.\n\
\n\
**Commands available:**\n\
- Shell environment: cd, pwd, export, unset, env\n\
- File system operations: ls, find, mkdir, rm, cp, mv, touch, chmod, chown\n\
- File viewing/editing: cat, grep, head, tail, diff, patch\n\
- Text processing: awk, sed, sort, uniq, wc\n\
- System information/operations: ps, kill, top, df, free, uname, whoami, id, date\n\
- Network operations: curl, wget, ping, telnet, ssh\n\
- Archive operations: tar, zip, unzip\n\
- Other: Other commands available in the shell environment. Check the existence of a command by running `which <command>` before using it.\n"
    );
}

#[test]
fn test_read_file_description() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Read text content from a file.\n\
\n\
**Tips:**\n\
- Make sure you follow the description of each tool parameter.\n\
- A `<system>` tag will be given before the read file content.\n\
- The system will notify you when there is anything wrong when reading the file.\n\
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\n\
- This tool can only read text files. To read images or videos, use other appropriate tools. To list directories, use the Glob tool or `ls` command via the Shell tool. To read other file types, use appropriate commands via the Shell tool.\n\
- If the file doesn't exist or path is invalid, an error will be returned.\n\
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.\n\
- Content will be returned with a line number before each line like `cat -n` format.\n\
- Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.\n\
- The maximum number of lines that can be read at once is 1000.\n\
- Any lines longer than 2000 characters will be truncated, ending with \"...\".\n"
    );
}

#[test]
fn test_read_media_file_description() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Read media content from a file.\n\
\n\
**Tips:**\n\
- Make sure you follow the description of each tool parameter.\n\
- A `<system>` tag will be given before the read file content.\n\
- The system will notify you when there is anything wrong when reading the file.\n\
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\n\
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.\n\
- If the file doesn't exist or path is invalid, an error will be returned.\n\
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.\n\
- The media content will be returned in a form that you can directly view and understand.\n\
\n\
**Capabilities**\n\
- This tool supports image and video files for the current model.\n"
    );
}

#[test]
fn test_glob_description() {
    let fixture = RuntimeFixture::new();
    let tool = Glob::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Find files and directories using glob patterns. This tool supports standard glob syntax like `*`, `?`, and `**` for recursive searches.\n\
\n\
**When to use:**\n\
- Find files matching specific patterns (e.g., all Python files: `*.py`)\n\
- Search for files recursively in subdirectories (e.g., `src/**/*.js`)\n\
- Locate configuration files (e.g., `*.config.*`, `*.json`)\n\
- Find test files (e.g., `test_*.py`, `*_test.go`)\n\
\n\
**Example patterns:**\n\
- `*.py` - All Python files in current directory\n\
- `src/**/*.js` - All JavaScript files in src directory recursively\n\
- `test_*.py` - Python test files starting with \"test_\"\n\
- `*.config.{js,ts}` - Config files with .js or .ts extension\n\
\n\
**Bad example patterns:**\n\
- `**`, `**/*.py` - Any pattern starting with '**' will be rejected. Because it would recursively search all directories and subdirectories, which is very likely to yield large result that exceeds your context size. Always use more specific patterns like `src/**/*.py` instead.\n\
- `node_modules/**/*.js` - Although this does not start with '**', it would still highly possible to yield large result because `node_modules` is well-known to contain too many directories and files. Avoid recursively searching in such directories, other examples include `venv`, `.venv`, `__pycache__`, `target`. If you really need to search in a dependency, use more specific patterns like `node_modules/react/src/*` instead.\n"
    );
}

#[test]
fn test_grep_description() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
A powerful search tool based-on ripgrep.\n\
\n\
**Tips:**\n\
- ALWAYS use Grep tool instead of running `grep` or `rg` command with Shell tool.\n\
- Use the ripgrep pattern syntax, not grep syntax. E.g. you need to escape braces like `\\\\{` to search for `{`.\n"
    );
}

#[test]
fn test_write_file_description() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Write content to a file.\n\
\n\
**Tips:**\n\
- When `mode` is not specified, it defaults to `overwrite`. Always write with caution.\n\
- When the content to write is too long (e.g. > 100 lines), use this tool multiple times instead of a single call. Use `overwrite` mode at the first time, then use `append` mode after the first write.\n"
    );
}

#[test]
fn test_str_replace_file_description() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "\
Replace specific strings within a specified file.\n\
\n\
**Tips:**\n\
- Only use this tool on text files.\n\
- Multi-line strings are supported.\n\
- Can specify a single edit or a list of edits in one call.\n\
- You should prefer this tool over WriteFile tool and Shell `sed` command.\n"
    );
}

#[test]
fn test_search_web_description() {
    let fixture = RuntimeFixture::new();
    let tool = SearchWeb::new(&fixture.runtime).expect("search web tool");
    assert_eq!(
        normalize_newlines(tool.description()),
        "WebSearch tool allows you to search on the internet to get latest information, including news, documents, release notes, blog posts, papers, etc.\n"
    );
}

#[test]
fn test_fetch_url_description() {
    let fixture = RuntimeFixture::new();
    let tool = FetchURL::new(&fixture.runtime);
    assert_eq!(
        normalize_newlines(tool.description()),
        "Fetch a web page from a URL and extract main text content from it.\n"
    );
}
