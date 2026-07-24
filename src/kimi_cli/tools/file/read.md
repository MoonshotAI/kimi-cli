Read text content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read text files. To read images or videos, use other appropriate tools. To list directories, use the Glob tool or `ls` command via the Shell tool. To read other file types, use appropriate commands via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.
- Content will be returned with a line number before each line like `cat -n` format.
- Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.
- Use negative `line_offset` to read from the end of the file (e.g. `line_offset=-100` reads the last 100 lines). This is useful for viewing the tail of log files. The absolute value cannot exceed ${MAX_LINES}.
- The tool always returns the total number of lines in the file in its message, which you can use to plan subsequent reads.
- The maximum number of lines that can be read at once is ${MAX_LINES}.
- Any lines longer than ${MAX_LINE_LENGTH} characters will be truncated, ending with "...".
