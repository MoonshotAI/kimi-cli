Retrieve output from a running or completed background task.

Use this after `Shell(run_in_background=true)` when you need to inspect progress or explicitly wait for completion.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- By default this tool is non-blocking and returns a current status/output snapshot.
- Use `block=true` only when you intentionally want to wait for completion or timeout.
- This tool returns structured task metadata, a fixed-size output preview, and an `output_path` for the full log.
- When the preview is truncated, use `ReadFile` with the returned `output_path` to inspect the full log in pages.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
