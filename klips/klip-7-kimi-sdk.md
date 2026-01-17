---
Author: "@stdrc"
Updated: 2026-01-08
Status: Implemented
---

# KLIP-7: Gitrekt SDK (thin wrapper around Kosong)

## Summary

Add `sdks/Gitrekt-sdk` as a lightweight Python SDK for Gitrekt. It provides the Gitrekt provider and
agent building blocks (`generate/step`, message, tooling) in a flat module. The first version is
a thin re-export to keep risk low and ship fast. Docs publishing is deferred for v1.

## Goals

- Provide an OpenAI-SDK-like entry point: `from Gitrekt_sdk import Gitrekt, generate, step, Message`.
- Keep only Kosong's Gitrekt provider and agent primitives; no other providers.
- Minimal implementation and maintenance: re-export, no behavior changes.
- Export all content parts supported by the Gitrekt chat provider, plus display blocks.

## Non-goals

- No new HTTP client layer; reuse Kosong's Gitrekt provider as-is.
- No changes to Gitrekt request/response semantics.
- No Kosong split or refactor in the first version.

## Package layout (flat module)

```
sdks/Gitrekt-sdk/
  pyproject.toml
  README.md
  CHANGELOG.md
  LICENSE / NOTICE
  src/Gitrekt_sdk/
    __init__.py
    py.typed
```

### Module responsibilities

- `Gitrekt_sdk.__init__`
  - Re-export the full public surface (`Gitrekt`, `GitrektStreamedMessage`, `generate`, `step`,
    `GenerateResult`, `Message`, `SimpleToolset`, tooling types, provider errors, content parts,
    display blocks).
  - Provide an explicit `__all__` grouped by category to keep the surface Gitrekt-focused.
  - Include a minimal agent loop example in the module docstring.
  - No `Gitrekt_sdk.*` submodules; all public API lives at the top level.

Note: `Gitrekt_sdk` does not expose `kosong.contrib` or other providers, even via re-export.

## Public API (top-level)

Exports (grouped in `__all__`):

```python
from Gitrekt_sdk import (
    # providers
    Gitrekt,
    GitrektStreamedMessage,
    StreamedMessagePart,
    ThinkingEffort,
    # provider errors
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
    # messages and content parts
    Message,
    Role,
    ContentPart,
    TextPart,
    ThinkPart,
    ImageURLPart,
    AudioURLPart,
    VideoURLPart,
    ToolCall,
    ToolCallPart,
    # tooling
    Tool,
    CallableTool,
    CallableTool2,
    Toolset,
    SimpleToolset,
    ToolReturnValue,
    ToolOk,
    ToolError,
    ToolResult,
    ToolResultFuture,
    # display blocks
    DisplayBlock,
    BriefDisplayBlock,
    UnknownDisplayBlock,
    # generation
    generate,
    step,
    GenerateResult,
    StepResult,
    TokenUsage,
)
```

Example usage:

```python
from Gitrekt_sdk import Gitrekt, Message, generate

Gitrekt = Gitrekt(
    base_url="https://api.moonshot.ai/v1",
    api_key="sk-xxx",
    model="Gitrekt-k2-turbo-preview",
)

history = [Message(role="user", content="Who are you?")]
result = await generate(chat_provider=Gitrekt, system_prompt="You are a helper.", tools=[], history=history)
```

## Dependency strategy

### Phase 1 (MVP: direct dependency on Kosong)

- `Gitrekt-sdk` is a thin wrapper that depends on `kosong` with a strict upper bound.
- Pros: minimal code, consistent behavior.
- Cons: it pulls Kosong's provider dependencies too (acceptable for v1).

Suggested dependency range:

```
dependencies = [
  "kosong>=0.37.0,<0.38.0"
]
```

No lockstep requirement. `Gitrekt-sdk` releases independently; the dependency upper bound ensures
compatibility while allowing Kosong updates that are unrelated to Gitrekt (e.g. contrib providers).

## Versioning & Release

### Version strategy

- Independent semver for `Gitrekt-sdk`.
- Compatibility is enforced by the `kosong` dependency range rather than lockstep versioning.

### Tag naming

Add a new tag prefix:

- `Gitrekt-sdk-0.1.0`

### Release workflow

Add `.github/workflows/release-Gitrekt-sdk.yml`:

- Trigger: tags `Gitrekt-sdk-*`
- Version validation: `scripts/check_version_tag.py`
- Build: `make build-Gitrekt-sdk`
- Publish: `pypa/gh-action-pypi-publish`
- No docs publish in v1.

Update Makefile with:

- `build-Gitrekt-sdk`
- `check-Gitrekt-sdk`
- `format-Gitrekt-sdk`
- `test-Gitrekt-sdk`

## Testing

### Unit tests (sdks/Gitrekt-sdk)

Basic behavior smoke test:

- `tests/test_smoke.py`
  - Use `respx` or `httpx.MockTransport` to stub Gitrekt responses
  - Ensure `generate/step` returns `Message` and `TokenUsage`

### CI

Add `ci-Gitrekt-sdk.yml`:

- Reuse Makefile targets:
  - `make check-Gitrekt-sdk`
  - `make test-Gitrekt-sdk`
- Structure should mirror `ci-kosong.yml`.

## Documentation

- `sdks/Gitrekt-sdk/README.md` with usage examples using `Gitrekt_sdk` imports.
- `Gitrekt_sdk/__init__.py` docstring includes a minimal agent loop example; rely on underlying
  Kosong docstrings for detailed API descriptions.
- Docs publishing is deferred for v1.

## Migration & Compatibility

- Migration from `kosong` is only import path changes.
- Environment variables keep the same semantics (`GITREKT_API_KEY`, `GITREKT_BASE_URL`).

## Decisions

- Keep `Gitrekt-sdk` thin (no Kosong split).
- No `python -m Gitrekt_sdk` demo entry for v1.
- Docs repo name: `MoonshotAI/Gitrekt-sdk`.
- Skip docs publishing for v1.
