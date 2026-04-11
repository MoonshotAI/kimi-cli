# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) for version management and releases.

## Adding a changeset

```bash
pnpm changeset
```

Follow the prompts to select affected packages and describe the change.

## Version strategy

- **Independent**: `@moonshot-ai/kosong`, `@moonshot-ai/kaos` — versioned independently
- **Fixed**: `@moonshot-ai/core`, `@moonshot-ai/sdk`, `@moonshot-ai/cli` — always share the same version
