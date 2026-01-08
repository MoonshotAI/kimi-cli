---
Author: @stdrc
Updated: 2025-12-29
Status: Implemented
---

# KLIP-2: ACPKaos, a LocalKaos variant that redirects operations to ACP clients

## Summary

Build ACPKaos as a near-drop-in LocalKaos variant. It behaves like LocalKaos for almost everything, but redirects the few operations that let ACP clients observe what the agent did: file reads/writes and terminal commands. This keeps tool behavior unchanged while making ACP the execution backend.

## Motivation

* We want ACP clients (e.g. Zed) to observe file edits and command execution.
* Tool-level ACP replacements are functional but not the most fundamental design.
* KAOS already abstracts OS operations; ACP fits naturally as a KAOS backend.
* Implementing ACP behavior as tools duplicates logic already present in core tools; ACPKaos eliminates that repetition by moving the integration down a layer.

## Constraints and references

* Use ACP only for methods the client explicitly advertises: `fs/read_text_file`, `fs/write_text_file`, and `terminal/*`. See [ACP initialization](https://agentclientprotocol.com/protocol/initialization), [ACP file system](https://agentclientprotocol.com/protocol/file-system), and [ACP terminals](https://agentclientprotocol.com/protocol/terminals).
* All other operations should pass through to LocalKaos.
* Keep behavior of existing tools (`Shell`, `ReadFile`, `WriteFile`, `StrReplaceFile`) unchanged.
* Capability flags are independent: `readTextFile` and `writeTextFile` may be enabled separately. The implementation must not call unsupported ACP methods.

## Current baseline (no new behavior assumed)

* KAOS is a contextvar-based abstraction with LocalKaos as default.
* Tools call KAOS:
  * `Shell` -> `kaos.exec`.
  * `ReadFile` -> `KaosPath.exists/is_file/read_lines`.
  * `WriteFile` / `StrReplaceFile` -> `KaosPath.read_text/write_text/append_text`.
* ACP integration today is tool-level (terminal replacement); an ACP-backed file tool swap has been experimented with locally but is not merged.

## Design: ACPKaos in one page

ACPKaos wraps LocalKaos and overrides only the minimal surface needed by tools. Everything else delegates to LocalKaos.

### Minimal overrides

* `exec` -> ACP terminal operations.
* `readtext` -> ACP `fs/read_text_file`.
* `writetext` -> ACP `fs/write_text_file` (append uses ACP only when both read+write are supported; otherwise fall back to LocalKaos).
* `readlines` -> optional: implement ACP paging, or update `ReadFile` to use `readtext` and split lines.
* `stat` -> keep LocalKaos (optional ACP fallback if unsaved buffers matter).

### Known limitation (unsaved buffers)

ACP `fs/read_text_file` can expose editor buffers that are not yet saved on disk. However, the current tool chain checks `KaosPath.exists/is_file` before reading; those checks use LocalKaos and will return false for buffer-only files. For now, we accept this limitation and keep `stat/exists/is_file` local. If we later want unsaved buffers to work end-to-end, we must revisit these checks.

### Pseudo-code (intent, not syntax)

```Plain
ACPKaos {
  init(client, session_id, caps, fallback=local_kaos)
    # bind ACP vs local functions once, based on caps
    self._readtext = caps.fs.readTextFile ? acp_readtext : fallback.readtext
    self._writetext = caps.fs.writeTextFile ? acp_writetext : fallback.writetext
    self._exec = caps.terminal ? acp_exec : fallback.exec
    self._appendtext = (caps.fs.readTextFile && caps.fs.writeTextFile)
      ? acp_appendtext
      : fallback_appendtext   # implemented via fallback.writetext(mode="a")

  # pass-throughs
  pathclass/normpath/gethome/getcwd/chdir/stat/iterdir/glob/readbytes/writebytes/mkdir
    -> fallback

  readtext(path):
    return self._readtext(abs(path))

  readlines(path):
    # split readtext into lines (keeps ReadFile behavior unchanged)
    text = self._readtext(abs(path))
    return text.splitlines(keepends=True)

  writetext(path, data, mode):
    if mode == "a":
      return self._appendtext(abs(path), data)
    return self._writetext(abs(path), data, mode)

  exec(args...):
    return self._exec(args...)
}
```

### ACPProcess (terminal adapter, intent only)

```Plain
ACPProcess (implements KaosProcess) {
  # Required because Shell expects a KaosProcess-compatible object.
  spawn(args):
    terminal_id = client.create_terminal(command, args, session_id, cwd=abs(cwd), outputByteLimit=limit)
    start background poll (terminal_output) to refresh output

  stdout/stderr:
    ACP has no stderr split; choose stdout-only and document it.

  wait():
    concurrently:
      wait_for_exit for authoritative status
      terminal_output for incremental output
    handle truncation:
      if truncated or output no longer contains last_seen_tail -> reset delta base and note truncation
    finally:
      terminal/release (MUST), even on error/cancel; release kills running commands

  kill():
    client.terminal/kill
}
```

## Integration points

* Create ACPKaos per ACP session, holding `client`, `session_id`, and `client_capabilities`.
* Set `current_kaos` for the ACP session run (contextvars are task-local); do this inside `prompt` so it covers a full turn.
* Keep `kaos.chdir` behavior intact; ACPKaos should delegate `chdir` to LocalKaos.
* Decide on tool-level replacements: preferred is to skip replacements when ACPKaos is active; transitional is to leave replacements as fallback for environments without ACPKaos.
* ACP calls must use absolute paths to avoid `chdir` surprises.

## Validation

* Unit tests for ACPKaos:
  * read/write calls hit ACP when caps allow.
  * append uses read + write.
  * exec returns output and exit codes.
* Integration tests: run `Shell`, `ReadFile`, `WriteFile`, `StrReplaceFile` with ACPKaos active.
* Manual test in Zed: read unsaved buffer, write changes, run command and confirm UI updates.
* Tests will need a mocked ACP client; we can mirror patterns from the ACP Python SDK tests when implementing.
