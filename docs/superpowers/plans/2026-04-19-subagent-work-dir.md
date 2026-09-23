# Subagent `work_dir` Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the Agent tool to pass a `work_dir` override so subagents operate in the correct directory (e.g. a git worktree), fixing issue #1931.

**Architecture:** Add an optional `work_dir` parameter to the Agent tool that flows through `AgentLaunchSpec` → `SubagentBuilder` → `copy_for_subagent`. When provided, `copy_for_subagent` creates a new `BuiltinSystemPromptArgs` with the overridden `KIMI_WORK_DIR` and a fresh directory listing for `KIMI_WORK_DIR_LS`. This ensures all file tools (Read, Write, Glob, etc.) in the subagent resolve paths relative to the correct directory.

**Tech Stack:** Python 3.12+, pydantic, dataclasses (frozen), KaosPath

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/kimi_cli/subagents/models.py` | Modify | Add `work_dir` field to `AgentLaunchSpec` |
| `src/kimi_cli/soul/agent.py` | Modify | Add `work_dir_override` to `copy_for_subagent`; create new `BuiltinSystemPromptArgs` |
| `src/kimi_cli/subagents/builder.py` | Modify | Read `launch_spec.work_dir`, convert to `KaosPath`, pass to `copy_for_subagent` |
| `src/kimi_cli/tools/agent/__init__.py` | Modify | Add `work_dir` to `Params`; pass through foreground and background paths |
| `src/kimi_cli/subagents/runner.py` | Modify | Add `work_dir` to `ForegroundRunRequest`; use it in `_prepare_instance` |
| `tests/core/test_subagent_builder.py` | Modify | Add test verifying work_dir propagation |
| `tests/core/test_runtime_roles.py` | Modify | Add test for `copy_for_subagent` with work_dir override |

---

### Task 1: Add `work_dir` to `AgentLaunchSpec`

**Files:**
- Modify: `src/kimi_cli/subagents/models.py:36-42`
- Test: `tests/core/test_subagent_builder.py`

- [ ] **Step 1: Write the failing test**

Add a test that creates an `AgentLaunchSpec` with `work_dir` and verifies it's preserved:

```python
# In tests/core/test_subagent_builder.py — add at end of file

def test_launch_spec_accepts_work_dir():
    from kaos.path import KaosPath

    spec = AgentLaunchSpec(
        agent_id="awd",
        subagent_type="coder",
        model_override=None,
        effective_model=None,
        work_dir="/tmp/some-worktree",
    )
    assert spec.work_dir == "/tmp/some-worktree"


def test_launch_spec_work_dir_defaults_to_none():
    spec = AgentLaunchSpec(
        agent_id="anwd",
        subagent_type="coder",
        model_override=None,
        effective_model=None,
    )
    assert spec.work_dir is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/core/test_subagent_builder.py::test_launch_spec_accepts_work_dir -xvs`
Expected: FAIL — `AgentLaunchSpec` does not accept keyword `work_dir`

- [ ] **Step 3: Add `work_dir` field to `AgentLaunchSpec`**

In `src/kimi_cli/subagents/models.py`, add the field to the `AgentLaunchSpec` dataclass:

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class AgentLaunchSpec:
    agent_id: str
    subagent_type: str
    model_override: str | None
    effective_model: str | None
    work_dir: str | None = None  # Optional working directory override for subagent
    created_at: float = field(default_factory=time.time)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/core/test_subagent_builder.py::test_launch_spec_accepts_work_dir tests/core/test_subagent_builder.py::test_launch_spec_work_dir_defaults_to_none -xvs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/subagents/models.py tests/core/test_subagent_builder.py
git commit -m "feat(subagents): add optional work_dir field to AgentLaunchSpec"
```

---

### Task 2: Add `work_dir_override` to `copy_for_subagent`

**Files:**
- Modify: `src/kimi_cli/soul/agent.py:349-379`
- Test: `tests/core/test_runtime_roles.py`

- [ ] **Step 1: Write the failing test**

```python
# In tests/core/test_runtime_roles.py — add at end of file

import platform
from dataclasses import replace

import pytest
from kaos.path import KaosPath


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_copy_for_subagent_with_work_dir_override(runtime, temp_work_dir):
    from kimi_cli.soul.agent import load_agent
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE

    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    override_dir = KaosPath("/tmp/worktree-override")
    sub = runtime.copy_for_subagent(
        agent_id="awdtest",
        subagent_type="coder",
        work_dir_override=override_dir,
    )
    assert sub.builtin_args.KIMI_WORK_DIR == override_dir
    # Original runtime unchanged
    assert runtime.builtin_args.KIMI_WORK_DIR == temp_work_dir


def test_copy_for_subagent_without_work_dir_override_inherits_original(runtime):
    sub = runtime.copy_for_subagent(
        agent_id="anowd",
        subagent_type="coder",
    )
    assert sub.builtin_args.KIMI_WORK_DIR == runtime.builtin_args.KIMI_WORK_DIR
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/core/test_runtime_roles.py::test_copy_for_subagent_with_work_dir_override -xvs`
Expected: FAIL — `copy_for_subagent()` got an unexpected keyword argument `work_dir_override`

- [ ] **Step 3: Implement `work_dir_override` in `copy_for_subagent`**

In `src/kimi_cli/soul/agent.py`, update the import line and the `copy_for_subagent` method:

Change the import at line 5 from:
```python
from dataclasses import asdict, dataclass
```
to:
```python
from dataclasses import asdict, dataclass, replace
```

Update `copy_for_subagent` (lines 349-379):

```python
def copy_for_subagent(
    self,
    *,
    agent_id: str,
    subagent_type: str,
    llm_override: LLM | None = None,
    work_dir_override: KaosPath | None = None,
) -> Runtime:
    """Clone runtime for a subagent."""
    builtin_args = self.builtin_args
    if work_dir_override is not None:
        builtin_args = replace(builtin_args, KIMI_WORK_DIR=work_dir_override)
    return Runtime(
        config=self.config,
        oauth=self.oauth,
        llm=llm_override if llm_override is not None else self.llm,
        session=self.session,
        builtin_args=builtin_args,
        denwa_renji=DenwaRenji(),
        approval=self.approval.share(),
        labor_market=self.labor_market,
        environment=self.environment,
        notifications=self.notifications,
        background_tasks=self.background_tasks.copy_for_role("subagent"),
        skills=self.skills,
        additional_dirs=self.additional_dirs,
        skills_dirs=self.skills_dirs,
        subagent_store=self.subagent_store,
        approval_runtime=self.approval_runtime,
        root_wire_hub=self.root_wire_hub,
        subagent_id=agent_id,
        subagent_type=subagent_type,
        role="subagent",
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/core/test_runtime_roles.py -xvs`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/soul/agent.py tests/core/test_runtime_roles.py
git commit -m "feat(runtime): add work_dir_override to copy_for_subagent"
```

---

### Task 3: Pass `work_dir` in `SubagentBuilder.build_builtin_instance`

**Files:**
- Modify: `src/kimi_cli/subagents/builder.py:12-36`
- Modify: `src/kimi_cli/utils/path.py` (import `list_directory`)
- Test: `tests/core/test_subagent_builder.py`

- [ ] **Step 1: Write the failing test**

```python
# In tests/core/test_subagent_builder.py — add at end of file

import platform

import pytest
from kaos.path import KaosPath


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_passes_work_dir_override_to_subagent(runtime, temp_work_dir):
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE
    from kimi_cli.soul.agent import load_agent

    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    override_dir = temp_work_dir  # Reuse fixture dir — it exists on disk
    builder = SubagentBuilder(runtime)
    agent = await builder.build_builtin_instance(
        agent_id="awdbuild",
        type_def=runtime.labor_market.require_builtin_type("coder"),
        launch_spec=AgentLaunchSpec(
            agent_id="awdbuild",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
            work_dir=str(override_dir),
        ),
    )
    # The subagent's runtime should use the overridden work_dir
    assert agent.runtime.builtin_args.KIMI_WORK_DIR == override_dir


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_without_work_dir_uses_root_dir(runtime):
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE
    from kimi_cli.soul.agent import load_agent

    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    builder = SubagentBuilder(runtime)
    agent = await builder.build_builtin_instance(
        agent_id="anowdbuild",
        type_def=runtime.labor_market.require_builtin_type("coder"),
        launch_spec=AgentLaunchSpec(
            agent_id="anowdbuild",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    # No override — should inherit root's work_dir
    assert agent.runtime.builtin_args.KIMI_WORK_DIR == runtime.builtin_args.KIMI_WORK_DIR
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/core/test_subagent_builder.py::test_builder_passes_work_dir_override_to_subagent -xvs`
Expected: FAIL — the subagent still uses the root work_dir (override is ignored)

- [ ] **Step 3: Implement work_dir pass-through in `SubagentBuilder`**

Update `src/kimi_cli/subagents/builder.py`:

```python
from __future__ import annotations

from kaos.path import KaosPath

from kimi_cli.llm import clone_llm_with_model_alias
from kimi_cli.soul.agent import Agent, Runtime, load_agent
from kimi_cli.subagents.models import AgentLaunchSpec, AgentTypeDefinition


class SubagentBuilder:
    def __init__(self, root_runtime: Runtime):
        self._root_runtime = root_runtime

    async def build_builtin_instance(
        self,
        *,
        agent_id: str,
        type_def: AgentTypeDefinition,
        launch_spec: AgentLaunchSpec,
    ) -> Agent:
        effective_model = self.resolve_effective_model(type_def=type_def, launch_spec=launch_spec)
        llm_override = clone_llm_with_model_alias(
            self._root_runtime.llm,
            self._root_runtime.config,
            effective_model,
            session_id=self._root_runtime.session.id,
            oauth=self._root_runtime.oauth,
        )
        work_dir_override: KaosPath | None = None
        if launch_spec.work_dir is not None:
            work_dir_override = KaosPath(launch_spec.work_dir)
        runtime = self._root_runtime.copy_for_subagent(
            agent_id=agent_id,
            subagent_type=type_def.name,
            llm_override=llm_override,
            work_dir_override=work_dir_override,
        )
        return await load_agent(
            type_def.agent_file,
            runtime,
            mcp_configs=[],
        )

    @staticmethod
    def resolve_effective_model(
        *, type_def: AgentTypeDefinition, launch_spec: AgentLaunchSpec
    ) -> str | None:
        return launch_spec.model_override or launch_spec.effective_model or type_def.default_model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/core/test_subagent_builder.py -xvs`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/subagents/builder.py tests/core/test_subagent_builder.py
git commit -m "feat(subagents): pass work_dir from AgentLaunchSpec through to copy_for_subagent"
```

---

### Task 4: Add `work_dir` to `Params` and wire foreground path

**Files:**
- Modify: `src/kimi_cli/tools/agent/__init__.py:21-63, 120-145`
- Modify: `src/kimi_cli/subagents/runner.py:181-388`

- [ ] **Step 1: Add `work_dir` to `Params`**

In `src/kimi_cli/tools/agent/__init__.py`, add the field to the `Params` class (after `timeout` at line 57):

```python
    work_dir: str | None = Field(
        default=None,
        description=(
            "Optional working directory for the subagent. When set, the subagent's file tools "
            "and system prompt will use this directory instead of the parent agent's working "
            "directory. Must be an absolute path."
        ),
    )
```

- [ ] **Step 2: Add `work_dir` to `ForegroundRunRequest`**

In `src/kimi_cli/subagents/runner.py`, add `work_dir` to `ForegroundRunRequest` (line 181-187):

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class ForegroundRunRequest:
    description: str
    prompt: str
    requested_type: str
    model: str | None
    resume: str | None
    work_dir: str | None = None
```

- [ ] **Step 3: Pass `work_dir` in `_prepare_instance`**

In `src/kimi_cli/subagents/runner.py`, update `_prepare_instance` to include `work_dir` in the `AgentLaunchSpec`. Change the `AgentLaunchSpec` creation inside `_prepare_instance` (around line 377-382):

```python
        record = self._store.create_instance(
            agent_id=agent_id,
            description=req.description.strip(),
            launch_spec=AgentLaunchSpec(
                agent_id=agent_id,
                subagent_type=actual_type,
                model_override=req.model,
                effective_model=req.model or type_def.default_model,
                work_dir=req.work_dir,
            ),
        )
```

- [ ] **Step 4: Pass `work_dir` in `Agent.__call__` (foreground path)**

In `src/kimi_cli/tools/agent/__init__.py`, update the foreground `ForegroundRunRequest` creation (around line 136-141):

```python
            req = ForegroundRunRequest(
                description=params.description,
                prompt=params.prompt,
                requested_type=params.subagent_type or "coder",
                model=params.model,
                resume=params.resume,
                work_dir=params.work_dir,
            )
```

- [ ] **Step 5: Verify compilation**

Run: `python -c "from kimi_cli.tools.agent import Agent; print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/kimi_cli/tools/agent/__init__.py src/kimi_cli/subagents/runner.py
git commit -m "feat(agent-tool): add work_dir param and wire foreground path"
```

---

### Task 5: Wire `work_dir` through the background path

**Files:**
- Modify: `src/kimi_cli/tools/agent/__init__.py:163-275`

- [ ] **Step 1: Pass `work_dir` in `_run_in_background`**

In `src/kimi_cli/tools/agent/__init__.py`, update the `AgentLaunchSpec` creation in `_run_in_background` (around line 211-217):

```python
                self._runtime.subagent_store.create_instance(
                    agent_id=agent_id,
                    description=params.description.strip(),
                    launch_spec=AgentLaunchSpec(
                        agent_id=agent_id,
                        subagent_type=actual_type,
                        model_override=params.model,
                        effective_model=params.model or type_def.default_model,
                        work_dir=params.work_dir,
                    ),
                )
```

No other changes needed — the background path retrieves `AgentLaunchSpec` from storage and passes it through to `SubagentBuilder.build_builtin_instance`, which already handles `work_dir` (from Task 3).

- [ ] **Step 2: Verify compilation**

Run: `python -c "from kimi_cli.tools.agent import Agent; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/kimi_cli/tools/agent/__init__.py
git commit -m "feat(agent-tool): pass work_dir in background agent launch"
```

---

### Task 6: Update Agent tool description

**Files:**
- Modify: `src/kimi_cli/tools/agent/description.md`

- [ ] **Step 1: Add `work_dir` usage guidance**

In `src/kimi_cli/tools/agent/description.md`, add after the `resume` bullet point (line 17):

```markdown
- Use `work_dir` when the subagent should operate in a different directory than the parent agent's current working directory (e.g. a git worktree). Must be an absolute path.
```

- [ ] **Step 2: Commit**

```bash
git add src/kimi_cli/tools/agent/description.md
git commit -m "docs(agent-tool): document work_dir parameter"
```

---

### Task 7: Run full test suite

**Files:**
- All modified files

- [ ] **Step 1: Run all existing subagent tests**

Run: `python -m pytest tests/core/test_subagent_builder.py tests/core/test_runtime_roles.py tests/core/test_subagent_store.py -xvs`
Expected: ALL PASS

- [ ] **Step 2: Run broader test suite to catch regressions**

Run: `python -m pytest tests/core/ -x --timeout=60`
Expected: ALL PASS

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -u
git commit -m "fix: address test regressions from work_dir feature"
```
