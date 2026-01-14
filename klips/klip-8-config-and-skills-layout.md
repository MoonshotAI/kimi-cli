---
Author: "@xxchan"
Updated: 2026-01-14
Status: Draft
---

# KLIP-8: Unified Skills and AGENTS.md Discovery

## Motivation

> "Skills should not need vendor-specific directory layouts, duplicate copies, or symlink hacks to be usable across clients."

Coding agent ecosystems are fragmented: Claude uses `.claude/skills/`, Codex uses `.codex/skills/`, each incompatible with others. Users must duplicate skills or maintain symlinks.

This proposal unifies skill discovery to be compatible with existing tools. Same for AGENTS.md.

## Scope

- Skills discovery
- AGENTS.md discovery
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
- `~/.kimi/skills/`
- `~/.claude/skills/`

**Project level** (by priority):
- `.agents/skills/` — canonical, recommended
- `.claude/skills/`

Fallback paths (`~/.kimi/`, `~/.claude/`, `.claude/`) may be deprecated in a future release.

`--skills-dir` overrides all discovery; only specified directory is used.

## Global AGENTS.md

`~/.config/agents/AGENTS.md` — loaded and merged with project level (global first).

Project level `AGENTS.md` works as before.

## Implementation

```python
def find_user_skills_dir() -> Path | None:
    """Return first existing directory."""
    for name in [".config/agents/skills", ".kimi/skills", ".claude/skills"]:
        if (p := Path.home() / name).is_dir():
            return p
    return None

def find_project_skills_dir(work_dir: Path) -> Path | None:
    """Return first existing directory."""
    for name in [".agents/skills", ".claude/skills"]:
        if (p := work_dir / name).is_dir():
            return p
    return None

def discover_all_skills(work_dir: Path) -> list[Skill]:
    """Layered merge: builtin → user → project; same-name overridden."""
    roots = [get_builtin_skills_dir()]
    if user_dir := find_user_skills_dir():
        roots.append(user_dir)
    if project_dir := find_project_skills_dir(work_dir):
        roots.append(project_dir)
    return discover_skills_from_roots(roots)
```

## References

- [agentskills#15](https://github.com/agentskills/agentskills/issues/15): proposal to standardize `.agents/skills/`
- [Amp](https://ampcode.com/manual#agent-skills): `~/.config/agents/`, `.agents/skills/`
