---
name: release
description: Execute the release workflow for Kimi Code CLI packages.
---

Release process for Kimi Code CLI packages. Tags are pushed without a `v` prefix and follow one of these patterns (matched by `.github/workflows/release-*.yml`):

| Tag pattern | Releases |
|---|---|
| `1.42.0` (numeric) | `kimi-cli` (root) + `kimi-code` wrapper, released together — versions must stay aligned |
| `kosong-0.53.0` | `packages/kosong` |
| `pykaos-0.9.0` | `packages/kaos` (PyPI name `pykaos`) |
| `kimi-sdk-0.3.0` | `sdks/kimi-sdk` |

The Rust implementation (`kagent`) lives in a separate repository and is **not** released from here.

## Steps

1. **Understand the automation.** Read `AGENTS.md` and `.github/workflows/release*.yml` so you know what each release workflow expects before changing any versions.

2. **Detect changed packages.** Check each release unit under `packages/`, `sdks/`, and the repo root for changes since its last release tag. Use path-scoped diffs for subpackages so unrelated repo changes do not trigger a package release, e.g. `git diff kosong-0.53.0..HEAD -- packages/kosong`, `git diff pykaos-0.9.0..HEAD -- packages/kaos`, and `git diff kimi-sdk-0.2.1..HEAD -- sdks/kimi-sdk`. If nothing changed anywhere, stop and report that there is nothing to release. Note: `packages/kimi-code` is a thin wrapper and must stay version-synced with `kimi-cli`, so treat it as changed whenever the root package changes.

3. **Confirm new versions with the user.** For each changed package, propose a new version and confirm before editing. Versioning policy:
   - Patch is always `0`.
   - Bump the minor version for any change.
   - Major only changes by explicit manual decision from the user.

4. **Create the release branch.** Name it `bump-<package>-<new-version>`. If multiple packages are being bumped together, use a single branch with a descriptive name.

5. **Update version metadata and changelogs.** For each changed package:
   - Update its `pyproject.toml`.
   - Update `CHANGELOG.md`, keeping the `## Unreleased` header empty in place (do **not** rename it — add a new dated `## <version> (YYYY-MM-DD)` section below it).
   - Update `breaking-changes.md` in both languages if there are breaking changes.
   - If bumping `packages/kosong` or `packages/kaos`, also update the root `pyproject.toml` pinned dependency (`kosong[contrib]==<version>` or `pykaos==<version>`) so root validation keeps passing.

6. **Sync the `kimi-code` wrapper when the root version changes.** Bump `packages/kimi-code/pyproject.toml` `version` and its `kimi-cli==<version>` dependency to match the new root version.

7. **Run `uv sync`** to refresh the lockfile.

8. **Update docs.** Follow the `gen-docs` skill to make sure docs reflect the release.

9. **Confirm with the user before opening the PR.** Summarize the staged changes and ask the user to explicitly confirm:
   - **Version numbers** — every updated `pyproject.toml` (changed package + `packages/kimi-code` if the root moved) reflects the version agreed in step 3.
   - **Dependency pins** — the root `pyproject.toml` pins (`kosong[contrib]==<version>`, `pykaos==<version>`) and `packages/kimi-code`'s `kimi-cli==<version>` match the bumped versions.
   - **Documentation** — CHANGELOG entries are added below `## Unreleased` (Unreleased still present and empty), `breaking-changes.md` is updated in both languages if applicable, and `gen-docs` left no inconsistencies.

   Wait for explicit user approval before proceeding. If the user flags anything, fix it and re-confirm — do not push.

10. **Open the PR.** Commit all changes, push, and open a PR with `gh` describing the version bumps.

11. **Hand off the tag step.** After merge, switch to `main`, pull latest, and tell the user the exact `git tag` command for the final release tag (pick the right tag pattern from the table above — e.g. `git tag 1.43.0` for a root release, `git tag kosong-0.54.0` for a kosong release). The user will run the tag and push tags themselves.

## Stop conditions

Fail fast — never paper over an error to keep the release moving. Stop and report back to the user when any of these happen:

- Nothing changed since the last tag → there is nothing to release.
- `uv sync` fails or produces unexpected `uv.lock` churn beyond the version bump.
- `gen-docs` reports a doc inconsistency you cannot resolve.
- PR checks go red after push — investigate, do **not** `--no-verify` or force-merge.
- The release workflow fails after tag push — read the workflow logs and surface the failure, do not retag silently.
