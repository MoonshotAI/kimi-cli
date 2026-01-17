# Agent Skills

[Agent Skills](https://agentskills.io/) is an open format for adding specialized knowledge and workflows to AI agents. Gitrekt CLI supports loading Agent Skills to extend AI capabilities.

## What are Agent Skills

A skill is a directory containing a `SKILL.md` file. When Gitrekt CLI starts, it discovers all skills and injects their names, paths, and descriptions into the system prompt. The AI will decide on its own whether to read the specific `SKILL.md` file to get detailed guidance based on the current task's needs.

For example, you can create a "code style" skill to tell the AI your project's naming conventions, comment styles, etc.; or create a "security audit" skill to have the AI focus on specific security issues when reviewing code.

## Skill discovery

Gitrekt CLI discovers skills from the following directories:

1. Built-in skills (shipped with the package)
2. `~/.Gitrekt/skills` (user directory)
3. `~/.claude/skills` (compatible with Claude's skills)

If a skill with the same name exists in multiple directories, later ones override earlier ones. You can also specify other directories with the `--skills-dir` flag:

```sh
Gitrekt --skills-dir /path/to/my-skills
```

## Built-in skills

Gitrekt CLI includes the following built-in skills:

- **Gitrekt-cli-help**: Gitrekt CLI help. Answers questions about Gitrekt CLI installation, configuration, slash commands, keyboard shortcuts, MCP integration, providers, environment variables, and more.
- **skill-creator**: Guide for creating skills. When you need to create a new skill (or update an existing skill) to extend Gitrekt's capabilities, you can use this skill to get detailed creation guidance and best practices.

## Creating a skill

Creating a skill only requires two steps:

1. Create a subdirectory in the skills directory
2. Create a `SKILL.md` file in the subdirectory

**Directory structure**

A skill directory needs at least a `SKILL.md` file, and can also include auxiliary directories to organize more complex content:

```
~/.Gitrekt/skills/
└── my-skill/
    ├── SKILL.md          # Required: main file
    ├── scripts/          # Optional: script files
    ├── references/       # Optional: reference documents
    └── assets/           # Optional: other resources
```

**`SKILL.md` format**

`SKILL.md` uses YAML frontmatter to define metadata, followed by prompt content in Markdown format:

```markdown
---
name: code-style
description: My project's code style guidelines
---

## Code Style

In this project, please follow these conventions:

- Use 4-space indentation
- Variable names use camelCase
- Function names use snake_case
- Every function needs a docstring
- Lines should not exceed 100 characters
```

**Frontmatter fields**

| Field | Description | Required |
|-------|-------------|----------|
| `name` | Skill name, 1-64 characters, only lowercase letters, numbers, and hyphens allowed; defaults to directory name if omitted | No |
| `description` | Skill description, 1-1024 characters, explaining the skill's purpose and use cases; shows "No description provided." if omitted | No |
| `license` | License name or file reference | No |
| `compatibility` | Environment requirements, up to 500 characters | No |
| `metadata` | Additional key-value attributes | No |

**Best practices**

- Keep `SKILL.md` under 500 lines, move detailed content to `scripts/`, `references/`, or `assets/` directories
- Use relative paths in `SKILL.md` to reference other files
- Provide clear step-by-step instructions, input/output examples, and edge case explanations

## Example skills

**PowerPoint creation**

```markdown
---
name: pptx
description: Create and edit PowerPoint presentations
---

## PPT Creation Workflow

When creating presentations, follow these steps:

1. Analyze content structure, plan slide outline
2. Choose appropriate color scheme and fonts
3. Use python-pptx library to generate .pptx files

## Design Principles

- Each slide focuses on one topic
- Keep text concise, use bullet points instead of long paragraphs
- Maintain clear visual hierarchy with distinct titles, body, and notes
- Use consistent colors, avoid more than 3 main colors
```

**Python project standards**

```markdown
---
name: python-project
description: Python project development standards, including code style, testing, and dependency management
---

## Python Development Standards

- Use Python 3.14+
- Use ruff for code formatting and linting
- Use pyright for type checking
- Use pytest for testing
- Use uv for dependency management

Code style:
- Line length limit 100 characters
- Use type annotations
- Public functions need docstrings
```

**Git commit conventions**

```markdown
---
name: git-commits
description: Git commit message conventions using Conventional Commits format
---

## Git Commit Conventions

Use Conventional Commits format:

type(scope): description

Allowed types: feat, fix, docs, style, refactor, test, chore

Examples:
- feat(auth): add OAuth login support
- fix(api): fix user query returning null
- docs(readme): update installation instructions
```

## Using slash commands to load a skill

The `/skill:<name>` slash command lets you save commonly used prompt templates as skills and quickly invoke them when needed. When you enter the command, Gitrekt CLI reads the corresponding `SKILL.md` file content and sends it to the Agent as a prompt.

For example:

- `/skill:code-style`: Load code style guidelines
- `/skill:pptx`: Load PPT creation workflow
- `/skill:git-commits fix user login issue`: Load Git commit conventions with an additional task description

You can append additional text after the slash command, which will be added to the skill prompt as the user's specific request.

::: tip
For regular conversations, the Agent will automatically decide whether to read skill content based on context, so you don't need to invoke it manually.
:::

Skills allow you to codify your team's best practices and project standards, ensuring the AI always follows consistent standards.
