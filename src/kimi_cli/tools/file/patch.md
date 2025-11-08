Apply a unified diff patch to a file.

**Tips:**
- The patch must be in unified diff format, the format used by `diff -u` and `git diff`.
- Only use this tool on text files.
- The tool will fail with error returned if the patch doesn't apply cleanly.
- The file must exist before applying the patch.
- You should prefer this tool over WriteFile tool and Bash `sed` command when editing an existing file.
- You must use the `ReadFile` tool on the target file earlier in the session before calling this tool.
