---
name: release
description: Execute the release workflow for Kimi Code CLI packages.
type: flow
---

```d2
understand: |md
  Understand the release automation by reading AGENTS.md and
  .github/workflows/release*.yml.
|
check_changes: |md
  Check each package under packages/, sdks/, and repo root for changes since the
  last release (by tag). Note packages/kimi-code is a thin wrapper and must stay
  version-synced with kimi-cli.
|
has_changes: "Any packages changed?"
confirm_versions: |md
  For each changed package, confirm the new version with the user. Follow the
  project versioning policy: patch is always 0, bump minor for any change,
  major only changes by explicit manual decision.
|
update_files: |md
  Update the relevant pyproject.toml (and rust/Cargo.toml if root version changes),
  CHANGELOG.md (keep the Unreleased header), and breaking-changes.md in both languages.
|
root_change: "Is the root package version changing?"
sync_kimi_code: |md
  Sync packages/kimi-code/pyproject.toml version and dependency
  `kimi-cli==<version>`.
|
sync_kagent: |md
  Sync rust/Cargo.toml workspace version to match the root package version.
|
uv_sync: "Run uv sync."
gen_docs: |md
  Follow the gen-docs skill instructions to ensure docs are up to date.
|

new_branch: |md
  Create a new branch `bump-<package>-<new-version>` (multiple packages can share
  one branch; name it appropriately).
|
open_pr: |md
  Commit all changes, push to remote, and open a PR with gh describing the
  updates.
|
monitor_pr: "Monitor the PR until it is merged."
post_merge: |md
  After merge, switch to main, pull latest changes, and tell the user the git
  tag command needed for the final release tag (they will tag + push tags). Note:
  a single numeric tag releases kimi-cli, kimi-code, and kagent together.
|

BEGIN -> understand -> check_changes -> has_changes
has_changes -> END: no
has_changes -> confirm_versions: yes
confirm_versions -> update_files -> root_change
root_change -> sync_kimi_code: yes
root_change -> uv_sync: no
sync_kimi_code -> sync_kagent
sync_kagent -> uv_sync
uv_sync -> gen_docs -> new_branch -> open_pr -> monitor_pr -> post_merge -> END
```
