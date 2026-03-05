# Kimi CLI Plans System

The Plans System is an AI-powered planning feature that helps you tackle complex development tasks by generating structured implementation plans with multiple options, tracking execution progress, and providing checkpoint/resume capabilities.

## Overview

When you face a complex development task, the Plans System can:

1. **Auto-detect complexity** - Automatically determines if your request needs structured planning
2. **Generate options** - Creates 2-3 distinct implementation approaches with trade-offs
3. **Track execution** - Breaks work into steps and tracks progress
4. **Save checkpoints** - Resume interrupted work from where you left off
5. **Support parallel execution** - Run independent steps concurrently

## Quick Start

### Auto-Detection Flow

Simply describe your task, and the Plans System will automatically detect if planning is needed:

```bash
> Refactor the authentication system
🤔 This looks complex. Generating implementation plans...

📋 Plan Options:
   1. Quick Patch (30 min)
      Fast fix with minimal changes
      Pros: Immediate solution, low risk
      Cons: Technical debt, not maintainable

   2. Proper Refactor (2 days)
      Complete rewrite with tests
      Pros: Clean code, maintainable, well-tested
      Cons: Takes longer, requires more testing

Select an option (1-2) or 'skip':
```

### Manual Planning

Use the `/plan` command to explicitly request a plan:

```bash
/plan Add user authentication with OAuth support
```

### Toggle Planning Mode

Press `Ctrl+T` to toggle between ACT and PLAN modes:

- **ACT Mode** (default): Direct execution of requests
- **PLAN Mode**: Always generate plans for complex tasks

## Commands Reference

### `/plan [description]`

Generate a plan for the given task description.

**Examples:**
```bash
/plan Implement a caching layer for the API
/plan Refactor the database models to use SQLAlchemy
/plan Add user authentication system
```

### `/plan-execute [plan-id]`

Execute a previously generated plan.

**Examples:**
```bash
/plan-execute                    # Execute the most recent plan
/plan-execute 20240304_120000    # Execute specific plan by ID
```

**Options:**
- `--resume` or `-r`: Resume from checkpoint if available
- `--fresh` or `-f`: Start fresh, ignore any checkpoints

### `/plan-checkpoint`

Manage execution checkpoints.

**Subcommands:**
```bash
/plan-checkpoint list            # List all checkpoints
/plan-checkpoint show [plan-id]  # Show checkpoint details
/plan-checkpoint delete [plan-id]# Delete a checkpoint
/plan-checkpoint clear           # Delete all checkpoints
```

### `/plan-status [plan-id]`

Check the status of a plan execution.

**Examples:**
```bash
/plan-status                     # Status of most recent plan
/plan-status 20240304_120000     # Status of specific plan
```

### `/plan-list`

List all saved plans.

```bash
/plan-list                       # List all plans
/plan-list --limit 10            # Limit to 10 most recent
```

### `/plan-show [plan-id]`

Display detailed information about a plan.

```bash
/plan-show                       # Show most recent plan
/plan-show 20240304_120000       # Show specific plan
```

## Configuration

Add the following to your `~/.kimi/config.toml` file:

```toml
[plans]
# Enable/disable auto-detection
auto_detect = true

# Complexity threshold (0-100, default: 60)
# Lower values = more tasks get plans
threshold = 60

# Default number of parallel steps
max_parallel = 3

# Enable/disable checkpoints
enable_checkpoints = true

# Checkpoint directory (default: ~/.kimi/checkpoints)
checkpoint_dir = "~/.kimi/checkpoints"

# Plans storage directory (default: ~/.kimi/plans)
plans_dir = "~/.kimi/plans"

# Default step retry count
max_retries = 3
```

## How It Works

### Complexity Detection

The system analyzes your request using multiple factors:

| Factor | Weight | Trigger |
|--------|--------|---------|
| File count | 30 | >3 files |
| Keywords | 20 | "refactor", "redesign", "migrate", etc. |
| Explicit plan | 40 | "plan", "create a plan" |
| Security | 20 | "security", "auth", "encrypt" |
| Breaking changes | 25 | "breaking", "backward incompatible" |
| Cross-module | 15 | Files in multiple directories |
| New architecture | 20 | "architecture", "design pattern" |

**Threshold:** 60 points triggers planning mode

### Plan Generation

When planning is triggered, the system generates 2-3 implementation options:

1. **Quick Fix** (`quick`) - Fastest solution, may incur technical debt
2. **Proper Solution** (`proper`) - Clean, maintainable, comprehensive
3. **Hybrid Approach** (`hybrid`) - Balanced approach (optional)

Each option includes:
- Title and description
- Pros and cons
- Estimated time
- Approach type classification

### Execution

Plans are executed in waves based on dependencies:

```
Wave 1: [Analyze]                    # No dependencies
Wave 2: [Design]                     # Depends on Analyze
Wave 3: [Implement-Core, Setup-Tests] # Both depend on Design
Wave 4: [Write-Tests]                # Depends on Implement-Core + Setup-Tests
Wave 5: [Documentation]              # Depends on Write-Tests
```

Steps within a wave run in parallel (up to `max_parallel`).

### Checkpoints

Checkpoints are automatically saved:
- After each wave completes
- When execution is interrupted
- On step failure (before retry)

Resume with:
```bash
/plan-execute --resume
```

## Examples

### Example 1: Simple Bug Fix

```bash
> Fix typo in README.md
```
Result: No plan generated (too simple)

### Example 2: Feature Implementation

```bash
> Add user authentication system
```
Result: Plan generated with options

### Example 3: Explicit Planning

```bash
/plan Create a caching layer for API responses with Redis
```
Result: Detailed plan with multiple implementation approaches

### Example 4: Resume Interrupted Work

```bash
> /plan-execute --resume
Resuming from checkpoint...
[████████░░] 80% complete
Continuing with step: Write tests
```

### Example 5: Complex Refactor

```bash
> Refactor the entire codebase to use async/await
🤔 Complexity score: 85/100

📋 Plan: Refactor codebase to async/await

Option 1: Gradual Migration (1 week)
  Migrate module by module, keeping sync compatibility
  Pros: Low risk, can rollback, no downtime
  Cons: Takes longer, temporary complexity

Option 2: Full Rewrite (3 days)
  Complete async conversion in one go
  Pros: Clean result, no compatibility layers
  Cons: High risk, extensive testing needed, potential bugs

Option 3: Adapter Pattern (5 days)
  Create async wrappers, migrate gradually
  Pros: Flexible, good for large codebases
  Cons: More complex initially, performance overhead

Select option (1-3):
```

## Best Practices

### When to Use Plans

**Use planning for:**
- Tasks affecting multiple files (>3)
- Refactoring or redesign work
- Breaking changes
- Security-related changes
- New feature development
- Architecture changes

**Skip planning for:**
- Simple bug fixes
- Documentation updates
- Single-file changes
- Configuration tweaks

### Choosing Options

- **Quick Fix**: Use for urgent fixes, prototypes, or when time is critical
- **Proper Solution**: Use for production code, long-term maintainability
- **Hybrid**: Use when you need a balance of speed and quality

### Checkpoint Management

- Checkpoints auto-delete when execution completes
- Manually delete old checkpoints to save disk space
- Use `--fresh` to start over if a checkpoint is corrupted

### Parallel Execution

Steps run in parallel when:
- They have no dependencies on each other
- `can_parallel` is true (default)
- Within `max_parallel` limit

## Troubleshooting

### "LLM not configured" Error

The Plans System requires a configured LLM. Run:
```bash
/login
```

### Checkpoints Not Saving

Verify permissions on `~/.kimi/checkpoints`:
```bash
ls -la ~/.kimi/
```

### Plan Generation Fails

Common causes:
- Network connectivity issues
- LLM rate limiting
- Invalid JSON in response

Try again or simplify your request.

### Resume Doesn't Work

Check if checkpoint exists:
```bash
/plan-checkpoint list
```

If corrupted, delete and start fresh:
```bash
/plan-checkpoint delete <plan-id>
/plan-execute --fresh
```

### Steps Taking Too Long

Adjust parallel execution:
```toml
[plans]
max_parallel = 5  # Increase parallelism
```

Or skip checkpoints for faster execution:
```bash
/plan-execute --no-checkpoints
```

## Advanced Usage

### Custom Step Retry Logic

Steps automatically retry on failure with exponential backoff:
- Retry 1: Wait 2 seconds
- Retry 2: Wait 4 seconds
- Retry 3: Wait 8 seconds

After max retries, you'll be prompted to retry, skip, or abort.

### Event Listeners (API)

For programmatic use:

```python
from kimi_cli.plans.executor import PlanExecutor

executor = PlanExecutor(llm)

# Listen to step events
executor.add_listener("step_start", lambda step: print(f"Started: {step.step_id}"))
executor.add_listener("step_complete", lambda step: print(f"Done: {step.step_id}"))
executor.add_listener("step_failed", lambda step: print(f"Failed: {step.step_id}"))

# Execute plan
execution = await executor.execute(plan)
```

### Manual Plan Creation (API)

```python
from kimi_cli.plans.models import Plan, PlanOption, PlanStep
from datetime import datetime

plan = Plan(
    id="my-plan",
    query="Custom task",
    options=[
        PlanOption(
            id=1,
            title="My Option",
            description="Description",
            pros=["Good"],
            cons=["Bad"],
            estimated_time="1 hour",
            approach_type="quick",
        ),
    ],
    created_at=datetime.now(),
    context_snapshot={},
    steps=[
        PlanStep(id="step1", name="Step 1", description="Do something"),
    ],
)
```

## See Also

- [README.md](README.md) - General project documentation
- `/help` - In-application help
- `/plan --help` - Plan command help
