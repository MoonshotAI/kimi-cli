# AGENTS.md project guide

`AGENTS.md` is a Markdown file placed in the project root, written specifically for AI coding agents. Kimi Code CLI automatically reads it when starting a session and injects its content into the system prompt, so the agent understands the project's background, conventions, and constraints from the very first turn.

## How it differs from README.md

`README.md` is for human readers — it describes the project's purpose, installation steps, and usage examples. `AGENTS.md` is for AI agents — it tells the agent how to work correctly within the project. The two serve different purposes:

| | `README.md` | `AGENTS.md` |
|---|---|---|
| Audience | Human developers and users | AI coding agents |
| Purpose | Introduce the project, guide onboarding | Provide project context and working constraints |
| Typical content | Feature overview, install steps, screenshots | Build commands, code style, directory layout, test instructions |

A project can have both files without conflict.

## Why you need AGENTS.md

When an AI agent enters an unfamiliar project, it knows nothing about the project structure, tech stack, or team conventions. Without `AGENTS.md`, the agent either spends many turns exploring on its own or makes assumptions that don't match the project's norms. A good `AGENTS.md` can:

- Reduce exploration overhead so the agent gets productive faster
- Prevent the agent from violating team code style or directory conventions
- Make common commands for building, testing, and linting immediately clear
- Inform the agent about special project restrictions (e.g., "do not modify the `generated/` directory")

## How Kimi Code CLI loads AGENTS.md

When creating a session, Kimi Code CLI looks for the following files in the current working directory, in order:

1. `AGENTS.md` (uppercase)
2. `agents.md` (lowercase)

It reads the first file found and injects the full content into the agent's system prompt via the `${KIMI_AGENTS_MD}` variable. If neither file exists, the variable is an empty string — the agent starts normally but without project context.

::: warning Note
Kimi Code CLI only looks for `AGENTS.md` in the working directory. It does not traverse parent directories or load from the user's home directory. If your project has nested subdirectories, make sure the file is in the directory where you launch `kimi`.
:::

## Generating AGENTS.md with /init

Run the `/init` slash command in a Kimi Code CLI session, and the agent will automatically explore the current project directory, analyze the project structure, tech stack, build configuration, and code organization, then write the results to an `AGENTS.md` file in the working directory.

How `/init` works:

1. Creates a temporary isolated context to avoid polluting the current session
2. Lets the agent explore the project and generate `AGENTS.md` in that temporary context
3. Loads the generated file content back into the current session

If an `AGENTS.md` already exists in the working directory, `/init` will reference its existing content when overwriting. After generation, you should review the file and make corrections or additions as needed.

## Recommended content

A practical `AGENTS.md` typically includes the following (include what's relevant — you don't need to cover everything):

**Project overview** — One or two paragraphs explaining what the project is, what tech stack it uses, and what scenarios it targets. Assume the reader knows nothing about the project.

**Build and test commands** — List the most common commands for daily development, for example:

```sh
# Install dependencies
npm install

# Run tests
npm test

# Build the project
npm run build

# Lint check
npm run lint
```

**Code style** — Describe the coding conventions the project follows, such as indentation style, naming conventions, import ordering rules, and whether specific linter configurations are used.

**Directory layout** — Briefly describe the purpose of main directories, such as `src/` for source code, `tests/` for tests, `docs/` for documentation, etc. For large projects, helping the agent quickly locate where code lives is valuable.

**Common workflows** — Describe the team's development habits, such as branching strategy, commit message format, and PR process.

**Constraints and restrictions** — Explicitly tell the agent what it should not do, for example:

- Do not modify auto-generated files
- Do not commit directly to the `main` branch
- Tests must run in a specific environment

## When to update AGENTS.md

`AGENTS.md` is not a write-once-and-forget file. Consider updating it when:

- The project's tech stack or build system changes
- Important directories or modules are added
- Code conventions are adjusted (e.g., switching linter tools or style configurations)
- Team conventions change (e.g., branching strategy, commit format)
- You notice the agent repeatedly making a specific mistake — document the correct approach

You can rerun `/init` at any time to let the agent regenerate the content, or edit the file manually. Keeping `AGENTS.md` in sync with the actual project state is key to the agent working effectively over time.
