---
name: gen-rust
description: Sync Rust implementation with Python changes (exclude UI/login) by diffing a commit range, mapping modules, porting logic, and updating tests.
metadata:
  short-description: Sync Rust with Python core logic
---

# gen-rust

Use this skill when the user wants Rust (kagent/kosong/kaos) to stay logically identical to Python (kimi_cli/kosong/kaos), excluding UI and login/auth. Prefer file-level diffs over commit-message scanning.

## Quick workflow

1) **Rebase first** (keep work safe)

- `git fetch origin main`
- If working tree dirty: `git stash -u -m "codex: temp stash before rebase"`
- `git rebase origin/main`
- `git stash pop` (resolve if needed)

2) **Build a complete change inventory** (do NOT rely on commit titles)

- List all changed files in range:
  - `git diff --name-only <BASE>..origin/main`
- Inspect Python diffs in range:
  - `git diff <BASE>..origin/main -- src`
- If needed, inspect specific file history:
  - `git log --oneline <BASE>..origin/main -- src/kimi_cli/llm.py`

3) **Classify changes**

- Exclude UI and login/auth changes.
- Everything else must be mirrored in Rust.
- Keep a small checklist: file -> change summary -> Rust target -> status.

4) **Map Python -> Rust**

Common mappings:
- `src/kimi_cli/llm.py` -> `rust/kagent/src/llm.rs`
- `src/kimi_cli/soul/*` -> `rust/kagent/src/soul/*`
- `src/kimi_cli/tools/*` -> `rust/kagent/src/tools/*`
- `src/kimi_cli/utils/*` -> `rust/kagent/src/utils/*`
- `src/kimi_cli/wire/*` -> `rust/kagent/src/wire/*`
- `packages/kosong/*` -> `rust/kosong/*`
- `packages/kaos/*` -> `rust/kaos/*`

5) **Port logic carefully**

- Match error messages and tool output text exactly (tests often assert strings).
- Preserve output types (text vs parts) and ordering.
- For media/tool outputs, verify ContentPart wrapping and serialization.
- If Python adds new helper modules, mirror minimal Rust utilities.
- Use `rg` to find existing analogs and references.

6) **Update tests**

- Update Rust tests that assert content/strings/parts.
- Mirror Python unit and integration tests when they exist; add missing Rust tests so coverage matches intent.
- Ensure E2E parity: any Python E2E scenario must be runnable and pass on Rust, or document the gap.
- Prefer targeted tests first (`cargo test -p kagent --test <name>`), then full suite if asked.

7) **Final report**

- List synced files and logic.
- Call out intentionally skipped UI/login changes.
- List tests run and results.

## Pitfalls to avoid

- Skipping `llm.py`: it often changes model capability logic.
- Using commit message filtering instead of full diff.
- Forgetting to update Rust tests when output text/parts change.
- Mixing UI/login changes into core sync.
- Leaving test parity ambiguous; always state unit/integration/E2E status.

## Minimal diff checklist (template)

- [ ] `git diff --name-only <BASE>..origin/main` reviewed
- [ ] Python diffs inspected for core logic
- [ ] Rust mappings applied
- [ ] Tests updated
- [ ] Targeted tests run
