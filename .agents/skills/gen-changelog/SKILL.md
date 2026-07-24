---
name: gen-changelog
description: Generate changelog entries for code changes.
---

Generate changelog entries for changes on the current branch relative to `main`, then sync to the docs site.

## Steps

1. **Inspect**: `git log main..HEAD --oneline` + `git diff main..HEAD --stat`.
2. **Edit root CHANGELOG**: add bullets under `## Unreleased` in `CHANGELOG.md` using the prefix table below. For changes scoped to a subpackage under `packages/` or `sdks/`, **also** update that subpackage's `CHANGELOG.md` — subpackage CHANGELOGs follow their own prefix conventions (e.g. `packages/kosong/CHANGELOG.md` uses provider prefixes like `Kimi:` / `Anthropic:`); only the root CHANGELOG follows the table below.
3. **Sync English docs**: `node docs/scripts/sync-changelog.mjs`.
4. **Translate to Chinese**: hand-write equivalents under `## 未发布` in `docs/zh/release-notes/changelog.md`. Use the full-width colon `：`. Follow `docs/AGENTS.md` terminology.
5. **Breaking changes**: if any, add a section under `## Unreleased` in `docs/en/release-notes/breaking-changes.md` with **Affected** + **Migration** subsections, and under `## 未发布` in `docs/zh/release-notes/breaking-changes.md` with **受影响** + **迁移** subsections.

## Entry format

```
- <Prefix>: <verb-led sentence, readable standalone> — <optional rationale / before-after / migration>
```

- **First sentence stands alone** — readers should know after one sentence whether the bullet matters to them.
- **One change per bullet.** No `; also`, `; and`, or nested em-dashes. Two changes = two bullets.
- **Verb-led**: `Fix …` / `Add …` / `Switch …` / `Bump …`.
- **User-meaningful only.** No internal refactors, test churn, or CI tweaks — except `Lib:` for SDK-facing changes.

## Prefixes — pick from this list, do not invent new ones

| Prefix | Scope |
|---|---|
| `Shell` | Interactive TUI: keys, status bar, slash commands, terminal rendering |
| `Web` | `kimi web` |
| `Vis` | `kimi vis` tracing visualizer |
| `CLI` | Top-level flags, subcommands, `--print` / `--yolo` / `--afk` |
| `ACP` | Zed / JetBrains and other ACP integrations |
| `Core` | Agent runtime, step loop, approval, quota, turns, background tasks |
| `Tool` | Any built-in tool; name the specific tool in the body (ReadFile, Grep, Todo, Plan, …) |
| `Skill` | Skill discovery/loading, Flow, Loop (always singular — not `Skills:`) |
| `MCP` | MCP server integration |
| `Plugin` | Plugin system, `kimi plugin` subcommands |
| `LLM` | Provider-agnostic or cross-provider; name the provider in the body (Kimi / Anthropic / OpenAI / DeepSeek …). **Do not** create per-provider prefixes |
| `Kosong` | Changes to the `kosong` LLM abstraction layer surfaced in the root CHANGELOG (the subpackage's own CHANGELOG uses provider prefixes) |
| `Wire` | Wire protocol events, version |
| `Auth` | OAuth, token refresh, `/login` |
| `Config` | Config schema, env vars |
| `Lib` | SDK-facing API changes |
| `Build` | Nix / Rust / Python / packaging |

When unsure, match an existing entry of the same kind. Prefer this list; if you genuinely need a new prefix, raise it with maintainers and update this table in the same PR so the convention stays single-sourced.

**Ordering**: within each version, group bullets by prefix in the order of the table above. Order within a prefix is free — keep the development order.

## Highlights

Starting from the next release, add `**Highlights**: …` under each version header (1–3 items most users will notice); mirror it as `**亮点**：…` in Chinese. Skip on releases that are only internal or `Lib:`. Highlights summarize — every highlighted item still needs its full bullet below. **Do not backfill historical versions.**
