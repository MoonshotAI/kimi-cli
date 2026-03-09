---
name: gen-rust
description: Sync Rust implementation with Python changes (exclude UI/login) by reviewing recent changes, mapping modules, porting logic, and updating tests.
---

# gen-rust

Use this skill when the user wants Rust (kagent/kosong/kaos) to stay logically identical to Python (kimi_cli/kosong/kaos), excluding UI and login/auth. This includes code and tests: Rust behavior and tests must be fully synchronized with Python changes.

Note: The Rust binary is named `kagent`. User-facing CLI/output text in Rust must use `kagent`
instead of `kimi` to match the Rust command name.

## Quick workflow

1) **Build a complete change inventory**

Review recent changes to understand what needs syncing:

```sh
# Check staged changes
git diff --cached --name-only
git diff --cached -- src packages

# Check recent commits
git log --oneline -20 -- src packages
git diff HEAD~20..HEAD -- src packages

# Review CHANGELOG.md for context
head -50 CHANGELOG.md
```

2) **Classify changes**

- Exclude UI and login/auth changes (Shell/Print/ACP UI, login/logout commands).
- Everything else must be mirrored in Rust.
- Keep a small checklist: file -> change summary -> Rust target -> status.

3) **Map Python -> Rust**

Common mappings:
- `src/kimi_cli/llm.py` -> `rust/kagent/src/llm.rs`
- `src/kimi_cli/soul/*` -> `rust/kagent/src/soul/*`
- `src/kimi_cli/tools/*` -> `rust/kagent/src/tools/*`
- `src/kimi_cli/utils/*` -> `rust/kagent/src/utils/*`
- `src/kimi_cli/wire/*` -> `rust/kagent/src/wire/*`
- `packages/kosong/*` -> `rust/kosong/*`
- `packages/kaos/*` -> `rust/kaos/*`

4) **Port logic carefully**

- Match error messages and tool output text exactly (tests often assert strings).
- Preserve output types (text vs parts) and ordering.
- For media/tool outputs, verify ContentPart wrapping and serialization.
- If Python adds new helper modules, mirror minimal Rust utilities.
- Use `rg` to find existing analogs and references.

5) **Update tests**

- Update Rust tests that assert content/strings/parts.
- Mirror Python unit and integration tests when they exist; add missing Rust tests so coverage matches intent.
- Ensure E2E parity: use the existing Python E2E suite against the Rust binary by setting
  `KIMI_E2E_WIRE_CMD` (do not rewrite E2E in Rust). All E2E cases must pass or the gap must be documented.
- Prefer targeted tests first (`cargo test -p kagent --test <name>`), then full suite if asked.

6) **Verification is mandatory**

- Run the full Rust test suite and ensure all Rust tests pass.
- Run E2E tests with the wire command swapped to Rust (set `KIMI_E2E_WIRE_CMD`), and ensure they pass.

7) **Final report**

- List synced files and logic.
- Call out intentionally skipped UI/login changes.
- List tests run and results (must include full Rust tests and Rust E2E with wire command override).

## Pitfalls to avoid

- Skipping `llm.py`: it often changes model capability logic.
- Using commit message filtering instead of full diff.
- Forgetting to update Rust tests when output text/parts change.
- Mixing UI/login changes into core sync.
- Leaving test parity ambiguous; always state unit/integration/E2E status.

## Minimal diff checklist (template)

- [ ] Recent changes reviewed (staged, commits, changelog)
- [ ] Python diffs inspected for core logic
- [ ] Rust mappings applied
- [ ] Tests updated
- [ ] Targeted tests run
- [ ] Full Rust test suite passed
- [ ] Rust E2E passed with `KIMI_E2E_WIRE_CMD`
