---
Author: "@xxchan"
Updated: 2026-01-14
Status: Implemented
---

# KLIP-8: Unified Skills Discovery

## Motivation

> "Skills should not need vendor-specific directory layouts, duplicate copies, or symlink hacks to be usable across clients."

Coding agent ecosystems are fragmented with vendor-specific layouts. Users must duplicate skills or maintain symlinks.

This proposal unifies skill discovery to be compatible with existing tools.

## Scope

- Skills discovery
- Future: `mcp.json` (not this KLIP)

## Non-goals

- `~/.kimi/config.toml` and other Kimi-specific config
- `~/.local/share/kimi/` data directories

## Skills Discovery

Two-level logic:

1. **Layered merge**: builtin → user → project all loaded; same-name skills overridden by later layers
2. **Directory lookup**: within each layer, check candidates by priority; stop at first existing directory

**User level** (by priority):
- `~/.config/agents/skills/` — canonical, recommended
- `~/.kimi/skills/` — legacy fallback
- `~/.claude/skills/` — legacy fallback

**Project level**:
- `.agents/skills/`

Built-in skills load only when the KAOS backend is `LocalKaos` or `ACPKaos`.

`--skills-dir` overrides user/project discovery; only specified directory is used (built-ins still load when supported).

## References

- [agentskills#15](https://github.com/agentskills/agentskills/issues/15): proposal to standardize `.agents/skills/`
- [Amp](https://ampcode.com/manual#agent-skills): `~/.config/agents/`, `.agents/skills/`
