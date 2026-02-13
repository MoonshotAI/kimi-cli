<!--
⚠️ IMPORTANT: This file is partially managed by Monoco.
- Content between MONOCO_GENERATED_START and MONOCO_GENERATED_END is auto-generated.
- Use `monoco sync` to refresh this content.
- Do NOT manually edit the managed block.
- Do NOT add content after MONOCO_GENERATED_END (use separate files instead).
-->

<!-- MONOCO_GENERATED_START -->
## Monoco

> **Auto-Generated**: This section is managed by Monoco. Do not edit manually.

### Doc-Extractor

#### Doc-Extractor: Document Normalization and Rendering

Document extraction and rendering system for converting various document formats into standardized WebP page sequences suitable for VLM (Vision Language Model) consumption.

##### Overview

Doc-Extractor provides a content-addressed storage system for documents with automatic format normalization:

- **Input**: PDF, DOCX, PPTX, XLSX, Images (PNG, JPG), Archives (ZIP, TAR, RAR, 7Z)
- **Output**: WebP page sequences with configurable DPI and quality
- **Storage**: SHA256-based content addressing in `~/.monoco/blobs/`

##### Commands

###### Extract Document
```bash
monoco doc-extractor extract <file> [options]
```

Options:
- `--dpi, -d`: DPI for rendering (72-300, default: 150)
- `--quality, -q`: WebP quality (1-100, default: 85)
- `--pages, -p`: Specific pages to render (e.g., "1-5,10,15-20")

###### List Extracted Documents
```bash
monoco doc-extractor list [--category <cat>] [--limit <n>]
```

###### Search Documents
```bash
monoco doc-extractor search <query>
```

###### Show Document Details
```bash
monoco doc-extractor show <hash_prefix>
monoco doc-extractor cat <hash_prefix>    # Show metadata JSON
monoco doc-extractor source <hash_prefix> # Show source/archive info
```

###### Index Management
```bash
monoco doc-extractor index rebuild   # Rebuild index from blobs
monoco doc-extractor index stats     # Show index statistics
monoco doc-extractor index clear     # Clear index (keeps blobs)
monoco doc-extractor index path      # Show index file path
```

###### Cleanup
```bash
monoco doc-extractor clean [--older-than <days>] [--dry-run]
monoco doc-extractor delete <hash_prefix> [--force]
```

##### Storage Structure

```
~/.monoco/blobs/
├── index.yaml              # Global metadata index
└── {sha256_hash}/          # Content-addressed directory
    ├── meta.json           # Document metadata
    ├── source.{ext}        # Original file (preserved extension)
    ├── source.pdf          # Normalized PDF format
    └── pages/
        ├── 0.webp          # Page 0 rendering
        ├── 1.webp          # Page 1 rendering
        └── ...
```

##### Python API

```python
from monoco.features.doc_extractor import DocExtractor, ExtractConfig

extractor = DocExtractor()
config = ExtractConfig(dpi=150, quality=85)
result = await extractor.extract("/path/to/document.pdf", config)

print(f"Hash: {result.blob.hash}")
print(f"Pages: {result.page_count}")
print(f"Cached: {result.is_cached}")
```

##### Key Principles

1. **Content-Addressed**: Files are stored by SHA256 hash - duplicates are automatically deduplicated
2. **Format Normalization**: All documents are converted to PDF then rendered to WebP
3. **Archive Support**: ZIP and other archives are automatically extracted, with inner document tracked
4. **Cache-Aware**: Extraction results are cached; re-extracting returns cached results instantly

### Agent

##### Monoco Core

Core commands for project management. Follows the **Trunk Based Development (TBD)** pattern.

- **Init**: `monoco init` (Initialize a new Monoco project)
- **Config**: `monoco config get|set <key> [value]` (Manage configuration)
- **Sync**: `monoco sync` (Sync with agent environment)
- **Uninstall**: `monoco uninstall` (Clean up agent integration)

---

#### ⚠️ Agent Must Read: Git Workflow Protocol (Trunk-Branch)

Before modifying any code, **must** follow these steps:

##### Standard Process

1. **Create Issue**: `monoco issue create feature -t "Feature Title"`
2. **🔒 Start Branch**: `monoco issue start FEAT-XXX --branch`
   - ⚠️ **Isolation Required**: Use `--branch` or `--worktree` parameter
   - ❌ **Trunk Operation Prohibited**: Forbidden from directly modifying code on Trunk (`main`/`master`)
3. **Implement**: Normal coding and testing
4. **Sync Files**: `monoco issue sync-files` (must run before submitting)
5. **Submit for Review**: `monoco issue submit FEAT-XXX`
6. **Merge to Trunk**: `monoco issue close FEAT-XXX --solution implemented`

##### Quality Gates

- Git Hooks automatically run `monoco issue lint` and tests
- Do not use `git commit --no-verify` to bypass checks
- Linter prevents direct modifications on protected Trunk branches

> 📖 See `monoco-issue` skill for complete workflow documentation.

### Issue Management

#### Issue Management & Trunk Based Development

Monoco follows the **Trunk Based Development (TBD)** pattern. All development occurs in short-lived branches (Branch) and is eventually merged back into the main line (Trunk).

System for managing task lifecycles using `monoco issue`.

- **Create**: `monoco issue create <type> -t "Title"`
- **Status**: `monoco issue open|close|backlog <id>`
- **Check**: `monoco issue lint`
- **Lifecycle**: `monoco issue start|submit|delete <id>`
- **Sync Context**: `monoco issue sync-files [id]`
- **Structure**: `Issues/{CapitalizedPluralType}/{lowercase_status}/` (e.g. `Issues/Features/open/`)

##### Standard Workflow (Trunk-Branch)

1. **Create Issue**: `monoco issue create feature -t "Title"`
2. **Start Branch**: `monoco issue start FEAT-XXX --branch` (Isolation)
3. **Implement**: Normal coding and testing.
4. **Sync Files**: `monoco issue sync-files` (Update `files` field).
5. **Submit**: `monoco issue submit FEAT-XXX`.
6. **Merge to Trunk**: `monoco issue close FEAT-XXX --solution implemented` (The only way to reach Trunk).

##### Git Merge Strategy

- **NO Manual Trunk Operation**: Strictly forbidden from using `git merge` or `git pull` directly on Trunk (`main`/`master`).
- **Atomic Merge**: `monoco issue close` merges changes from Branch to Trunk only for the files listed in the `files` field.
- **Conflicts**: If conflicts occur, follow the instructions provided by the `close` command (usually manual cherry-pick).
- **Cleanup**: `monoco issue close` prunes the Branch/Worktree by default.

### Memo (Fleeting Notes)

Lightweight note-taking for ideas and quick thoughts. **Signal Queue Model** (FEAT-0165).

#### Signal Queue Semantics

- **Memo is a signal, not an asset** - Its value is in triggering action
- **File existence = signal pending** - Inbox has unprocessed memos
- **File cleared = signal consumed** - Memos are deleted after processing
- **Git is the archive** - History is in git, not app state

#### Commands

- **Add**: `monoco memo add "Content" [-c context]` - Create a signal
- **List**: `monoco memo list` - Show pending signals (consumed memos are in git history)
- **Delete**: `monoco memo delete <id>` - Manual delete (normally auto-consumed)
- **Open**: `monoco memo open` - Edit inbox directly

#### Workflow

1. Capture ideas as memos
2. When threshold (5) is reached, Architect is auto-triggered
3. Memos are consumed (deleted) and embedded in Architect's prompt
4. Architect creates Issues from memos
5. No need to "link" or "resolve" memos - they're gone after consumption

#### Guideline

- Use Memos for **fleeting ideas** - things that might become Issues
- Use Issues for **actionable work** - structured, tracked, with lifecycle
- Never manually link memos to Issues - if important, create an Issue

### Glossary

#### Monoco Glossary

##### Core Architecture Metaphor: "Linux Distro"

| Term             | Definition                                                                                          | Metaphor                            |
| :--------------- | :-------------------------------------------------------------------------------------------------- | :---------------------------------- |
| **Monoco**       | The Agent Operating System Distribution. Managed policy, workflow, and package system.              | **Distro** (e.g., Ubuntu, Arch)     |
| **Kimi CLI**     | The core runtime execution engine. Handles LLM interaction, tool execution, and process management. | **Kernel** (Linux Kernel)           |
| **Session**      | An initialized instance of the Agent Kernel, managed by Monoco. Has state and context.              | **Init System / Daemon** (systemd)  |
| **Issue**        | An atomic unit of work with state (Open/Done) and strict lifecycle.                                 | **Unit File** (systemd unit)        |
| **Skill**        | A package of capabilities (tools, prompts, flows) that extends the Agent.                           | **Package** (apt/pacman package)    |
| **Context File** | Configuration files (e.g., `GEMINI.md`, `AGENTS.md`) defining environment rules and preferences.    | **Config** (`/etc/config`)          |
| **Agent Client** | The user interface connecting to Monoco (CLI, VSCode, Zed).                                         | **Desktop Environment** (GNOME/KDE) |
| **Trunk**        | The stable main line of code (usually `main` or `master`). The final destination for all features.  | **Trunk**                           |
| **Branch**       | A temporary isolated development environment created for a specific Issue.                          | **Branch**                          |

##### Key Concepts

###### Context File

Files like `GEMINI.md` that provide the "Constitution" for the Agent. They define the role, scope, and behavioral policies of the Agent within a specific context (Root, Directory, Project).

###### Headless

Monoco is designed to run without a native GUI. It exposes its capabilities via standard protocols (LSP, ACP) to be consumed by various Clients (IDEs, Terminals).

###### Universal Shell

The concept that the CLI is the universal interface for all workflows. Monoco acts as an intelligent layer over the shell.

### Spike (Research)

Manage external reference repositories.

- **Add Repo**: `monoco spike add <url>` (Available in `.reference/<name>` for reading)
- **Sync**: `monoco spike sync` (Run to download content)
- **Constraint**: Never edit files in `.reference/`. Treat them as read-only external knowledge.

### Artifacts



### Documentation I18n

Manage internationalization.

- **Scan**: `monoco i18n scan` (Check for missing translations)
- **Structure**:
  - Root files: `FILE_ZH.md`
  - Subdirs: `folder/zh/file.md`

<!-- MONOCO_GENERATED_END -->
