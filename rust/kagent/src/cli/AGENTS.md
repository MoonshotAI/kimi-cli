# CLI Module Notes

- Purpose: owns CLI parsing/routing and keeps `main.rs` minimal.
- Subcommands: `info` and `mcp` live in separate modules; keep behavior aligned with Python CLI.
- Wire-only: non-wire UI flags should remain unsupported in Rust builds.
- MCP commands: use `rmcp` for client/auth flows; config format stays compatible with `~/.kimi/mcp.json`.
- MCP clients must not auto-inject `mcp-session-id` headers; some standard servers reject them.
