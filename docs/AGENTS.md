# Documentation Agent Guide

This repository uses VitePress for the documentation site. The current docs are structural scaffolds only; everything beyond the headings is placeholder guidance. The `Reference Code` blocks are there to guide future writing and should be removed once the docs are complete.

## Structure

- Locales live under `docs/en/` and `docs/zh/` with mirrored paths and filenames.
- Main sections (nav + sidebar) are:
  - Guides: getting-started, use-cases, interaction, sessions, ides, integrations
  - Customization: mcp, skills, agents, print-mode, wire-mode
  - Configuration: config-files, providers, overrides, env-vars, data-locations
  - Reference: kimi-command, kimi-acp, kimi-mcp, slash-commands, keyboard, tools, exit-codes
  - FAQ: setup, interaction, acp, mcp, print-wire, updates
  - Release notes: changelog, breaking-changes
- Navigation and sidebar are defined in `docs/.vitepress/config.ts`. Any new or renamed page must be wired there for both locales.

## Authoring workflow

- Each page is a scaffold: expand the bullets into prose while keeping the section ordering, and keep the `::: info Reference Code` blocks aligned with the relevant section.
- Update both locales together, keeping content parity.

## Naming conventions

- Filenames are kebab-case and mirror across locales (same slug in `docs/en/` and `docs/zh/`).
- Use consistent section labels that match the sidebar titles.
- Use backticks for flags, commands, file paths, and code identifiers.

## Wording conventions

- Do not change H1 titles or nav/sidebar labels.
- English H2+ headings use sentence case (only the first word capitalized unless it is a proper noun). Treat "Wire" as a proper noun; do not treat "agent", "shell mode", or "print mode" as proper nouns.
- Chinese H2+ headings keep English words in sentence case; preserve proper nouns listed in the term table below.
- Use `API key` (lowercase k), but keep `JSON`, `JSONL`, `OAuth`, `macOS`, and `uv` as-is.

Term mapping (Chinese <-> English, and proper noun handling):

| Chinese | English | Proper noun (zh) | Proper noun (en) |
| --- | --- | --- | --- |
| Agent | agent | yes | no |
| Shell 模式 | shell mode | yes | no |
| Print 模式 | print mode | yes | no |
| Wire 模式 | Wire mode | yes | yes (Wire) |
| MCP | MCP | yes | yes |
| ACP | ACP | yes | yes |
| Kimi CLI | Kimi CLI | yes | yes |
| Agent Skills | Agent Skills | yes | yes |
| 系统提示词 | system prompt | no | no |
| 会话 | session | no | no |
| 上下文 | context | no | no |
| 子 Agent | subagent | yes (Agent) | no |
| API key | API key | no | no |
| JSON | JSON | no | no |
| JSONL | JSONL | no | no |
| OAuth | OAuth | no | no |
| macOS | macOS | no | no |
| uv | uv | no | no |

## Build and preview

- Docs are built with VitePress from `docs/`.
- Common commands (run inside `docs/`):
  - `npm install` (or `bun install` if you use bun)
  - `npm run dev`
  - `npm run build`
  - `npm run preview`
- The build output is `docs/.vitepress/dist`.
