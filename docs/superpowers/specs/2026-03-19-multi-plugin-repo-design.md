# Multi-Plugin Repository Support

## Problem

Currently `kimi plugin install` assumes one plugin per git repository — it expects `plugin.json` at the repo root. Users cannot install a single plugin from a monorepo that contains multiple plugins.

## Scope

- **Git URLs only** — local directories and zip files are out of scope (local dirs already work by pointing to the subdirectory directly).
- **CLI layer only** — `plugin/manager.py`, `plugin/__init__.py`, and `plugin/tool.py` are unchanged. The `install_plugin` function already accepts a `source` directory; we just need to resolve the correct subdirectory before calling it.

## Supported URL Formats

### With `.git` suffix (any git host)

| URL | clone_url | subpath |
|-----|-----------|---------|
| `https://host/org/repo.git` | same | `None` |
| `https://host/org/repo.git/my-plugin` | `https://host/org/repo.git` | `my-plugin` |
| `https://host/org/repo.git/packages/my-plugin` | `https://host/org/repo.git` | `packages/my-plugin` |
| `git@host:org/repo.git` | same | `None` |
| `git@host:org/repo.git/my-plugin` | `git@host:org/repo.git` | `my-plugin` |

Split at the first `.git` that is immediately followed by `/` or is at end-of-string. Everything up to and including `.git` is the clone URL; the rest (after `/`) is the subpath.

This avoids false matches on substrings like `.github` (e.g. `https://github.com/my.github.io/tools.git/plugin` correctly splits at `tools.git`).

### GitHub/GitLab short URLs (no `.git`)

| URL | clone_url | subpath |
|-----|-----------|---------|
| `https://github.com/org/repo` | same | `None` |
| `https://github.com/org/repo/my-plugin` | `https://github.com/org/repo` | `my-plugin` |
| `https://github.com/org/repo/packages/my-plugin` | `https://github.com/org/repo` | `packages/my-plugin` |
| `https://github.com/org/repo/tree/main/my-plugin` | `https://github.com/org/repo` | `my-plugin` |

Parse path segments after domain: first two are `owner/repo`, remaining is subpath. If the remaining starts with `tree/{single-segment}/`, strip that prefix.

**Limitation**: `tree/{branch}/` stripping only handles single-segment branch names (e.g. `main`, `develop`). Multi-segment branches like `feat/v2` are ambiguous without querying the remote. Users with such branches should use the `.git` URL form instead.

**Note**: URLs with fewer than 2 path segments (e.g. `https://github.com/org`) are not valid plugin URLs and will error. SSH URLs without `.git` suffix are not supported for subpath extraction — SSH users should always use the `.git` form.

## Design

### New function: `_parse_git_url`

```python
def _parse_git_url(target: str) -> tuple[str, str | None]:
    """Parse a git URL into (clone_url, subpath).

    Handles .git URLs, SSH URLs, and GitHub/GitLab browser URLs.
    Returns (clone_url, None) when no subpath is specified.
    """
```

Pure function, no side effects. Two code paths:

1. **`.git` in URL**: find the first `.git` followed by `/` or end-of-string. Split there. Everything after is subpath (strip leading `/`).
2. **GitHub/GitLab short URL**: parse path segments, first two after domain are owner/repo, rest is subpath. If subpath starts with `tree/{single-segment}/`, strip that prefix.

### Modified: `_resolve_source` git branch

**Entry guard update**: The current git URL detection uses `target.endswith(".git")` which will reject URLs like `repo.git/my-plugin`. Change to `".git/" in target or target.endswith(".git")` to match `.git` mid-string.

**Clone URL**: Call `_parse_git_url(target)` to get `(clone_url, subpath)`. Use `clone_url` (not the original `target`) in the `git clone` command.

After cloning, apply subpath resolution:

- **subpath provided**: resolve `clone_dir / subpath` and validate it stays within `clone_dir` using `Path.is_relative_to()` (prevents traversal like `../../etc`). Error if directory or `plugin.json` doesn't exist.
- **no subpath, root has `plugin.json`**: existing behavior (return root).
- **no subpath, root has no `plugin.json`**: scan one level of subdirectories for `plugin.json`. If found, list available plugin names and suggest the correct URL. If none found, error "No plugin.json found".

Example error message for the scan-and-suggest case:
```
Error: No plugin.json at repository root. Available plugins:
  - my-plugin
  - another-plugin
Use: kimi plugin install https://github.com/org/repo/my-plugin
```

### Files changed

- `src/kimi_cli/cli/plugin.py`: add `_parse_git_url`, modify git branch of `_resolve_source`

### Testing

Add to `tests/core/test_plugin.py`:

1. **`_parse_git_url` parametrized tests**: all URL formats above, plus edge cases (trailing slashes, nested subpaths, `.github` in hostname, URLs with fewer than 2 path segments).
2. **`_resolve_source` integration tests** (with mocked `git clone`):
   - Git URL with subpath → returns correct subdirectory
   - Subpath doesn't exist → error
   - Subpath traversal attempt → error
   - No subpath, no root `plugin.json`, has sub-plugins → error listing available plugins
   - No subpath, no root `plugin.json`, no sub-plugins → plain error

### What doesn't change

- `plugin/manager.py` — `install_plugin` receives the resolved source dir, unaware of URL parsing
- `plugin/__init__.py` — spec parsing unchanged
- `plugin/tool.py` — tool execution unchanged
