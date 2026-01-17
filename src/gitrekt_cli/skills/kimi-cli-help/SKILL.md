---
name: Gitrekt-cli-help
description: Answer Gitrekt CLI usage, configuration, and troubleshooting questions. Use when user asks about Gitrekt CLI installation, setup, configuration, slash commands, keyboard shortcuts, MCP integration, providers, environment variables, how something works internally, or any questions about Gitrekt CLI itself.
---

# Gitrekt CLI Help

Help users with Gitrekt CLI questions by consulting documentation and source code.

## Strategy

1. **Prefer official documentation** for most questions
2. **Read local source** when in Gitrekt-cli project itself, or when user is developing with Gitrekt-cli as a library (e.g., importing from `gitrekt_cli` in their code)
3. **Clone and explore source** for complex internals not covered in docs - **ask user for confirmation first**

## Documentation

Base URL: `https://moonshotai.github.io/Gitrekt-cli/`

Fetch documentation index to find relevant pages:

```
https://moonshotai.github.io/Gitrekt-cli/llms.txt
```

### Page URL Pattern

- English: `https://moonshotai.github.io/Gitrekt-cli/en/...`
- Chinese: `https://moonshotai.github.io/Gitrekt-cli/zh/...`

### Topic Mapping

| Topic | Page |
|-------|------|
| Installation, first run | `/en/guides/getting-started.md` |
| Config files | `/en/configuration/config-files.md` |
| Providers, models | `/en/configuration/providers.md` |
| Environment variables | `/en/configuration/env-vars.md` |
| Slash commands | `/en/reference/slash-commands.md` |
| CLI flags | `/en/reference/Gitrekt-command.md` |
| Keyboard shortcuts | `/en/reference/keyboard.md` |
| MCP | `/en/customization/mcp.md` |
| Agents | `/en/customization/agents.md` |
| Skills | `/en/customization/skills.md` |
| FAQ | `/en/faq.md` |

## Source Code

Repository: `https://github.com/MoonshotAI/Gitrekt-cli`

When to read source:

- In Gitrekt-cli project directory (check `pyproject.toml` for `name = "Gitrekt-cli"`)
- User is importing `gitrekt_cli` as a library in their project
- Question about internals not covered in docs (ask user before cloning)
