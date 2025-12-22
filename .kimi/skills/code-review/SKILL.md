---
name: code-review
description: Review code changes for DRY, SOLID, YAGNI, KISS principles and single source of truth violations. Use when reviewing PRs, diffs, or code quality.
license: MIT
triggers:
  - review PR
  - review pull request
  - code review
  - review code
  - check code quality
  - review changes
  - review diff
  - check for DRY
  - SOLID principles
  - pass code review
metadata:
  author: kimi-community
  version: "1.0"
---

# Code Review Skill

## When to Use This Skill

Activate this skill when:
- Reviewing a pull request or merge request
- Analyzing code changes in a diff
- Auditing existing code for quality issues
- The user asks to review code for best practices
- Checking code before committing

## Review Process

### Step 1: Gather Context

First, understand what you're reviewing:

1. If reviewing a PR, get the diff:
   ```bash
   git diff main...HEAD
   # or for a specific PR
   gh pr diff <pr-number>
   ```

2. If reviewing specific files, read them fully before commenting.

3. Understand the purpose of the changes - read PR description, commit messages, or ask the user.

### Step 2: Apply the Principles

Review the code against each principle systematically.

---

## DRY (Don't Repeat Yourself)

**Principle**: Every piece of knowledge must have a single, unambiguous, authoritative representation within a system.

### What to Look For

| Violation | Example | Fix |
|-----------|---------|-----|
| Duplicated logic | Same validation in multiple places | Extract to shared function |
| Copy-pasted code | Identical blocks with minor changes | Parameterize and reuse |
| Repeated constants | Magic numbers/strings scattered | Define constants once |
| Duplicate data schemas | Same structure defined multiple times | Create shared type/model |
| Repeated error messages | Same error text in multiple places | Centralize messages |

### Review Checklist

- [ ] Are there any code blocks that look nearly identical?
- [ ] Are magic numbers or strings repeated?
- [ ] Is the same validation logic implemented multiple times?
- [ ] Are there multiple sources defining the same data structure?
- [ ] Could any repeated patterns be extracted into a helper?

### How to Report

```markdown
**DRY Violation** (Severity: Medium)
- **Location**: `src/handlers/user.py:45-52` and `src/handlers/admin.py:30-37`
- **Issue**: Email validation logic is duplicated
- **Suggestion**: Extract to `utils/validators.py:validate_email()`
```

---

## SOLID Principles

### S - Single Responsibility Principle (SRP)

**Principle**: A class/module should have only one reason to change.

#### What to Look For

- Classes doing too many things (God classes)
- Functions with multiple unrelated operations
- Modules mixing different concerns (e.g., business logic + I/O + formatting)

#### Review Checklist

- [ ] Can you describe what this class does in one sentence without "and"?
- [ ] Does this function do exactly one thing?
- [ ] If requirements change, how many places need modification?

### O - Open/Closed Principle (OCP)

**Principle**: Software entities should be open for extension, but closed for modification.

#### What to Look For

- Long if/else or switch statements that grow with new types
- Code that requires modification to add new features
- Missing abstraction points

#### Review Checklist

- [ ] Can new behavior be added without modifying existing code?
- [ ] Are there switch statements on type that could be polymorphism?
- [ ] Is there a plugin/strategy pattern opportunity?

### L - Liskov Substitution Principle (LSP)

**Principle**: Subtypes must be substitutable for their base types.

#### What to Look For

- Subclasses that throw exceptions for inherited methods
- Overrides that change the expected behavior
- isinstance checks to handle specific subtypes differently

#### Review Checklist

- [ ] Can subclasses be used wherever the parent is expected?
- [ ] Do overridden methods honor the parent's contract?
- [ ] Are there type checks that suggest broken substitutability?

### I - Interface Segregation Principle (ISP)

**Principle**: Clients should not be forced to depend on interfaces they don't use.

#### What to Look For

- Large interfaces with many methods
- Classes implementing interfaces with dummy/empty methods
- Clients importing modules just for one small piece

#### Review Checklist

- [ ] Are there interfaces with methods that some implementers don't need?
- [ ] Could large interfaces be split into smaller, focused ones?
- [ ] Are clients forced to depend on things they don't use?

### D - Dependency Inversion Principle (DIP)

**Principle**: High-level modules should not depend on low-level modules. Both should depend on abstractions.

#### What to Look For

- Direct instantiation of dependencies inside classes
- Hard-coded references to concrete implementations
- Missing dependency injection

#### Review Checklist

- [ ] Are dependencies injected rather than created internally?
- [ ] Do modules depend on abstractions (interfaces/protocols)?
- [ ] Can implementations be swapped without changing the dependent code?

### How to Report SOLID Violations

```markdown
**SOLID Violation: Single Responsibility** (Severity: High)
- **Location**: `src/services/order_service.py`
- **Issue**: OrderService handles order creation, email notifications, inventory updates, and PDF generation
- **Suggestion**: Split into OrderService, NotificationService, InventoryService, DocumentService
```

---

## YAGNI (You Aren't Gonna Need It)

**Principle**: Don't implement something until it is necessary.

### What to Look For

| Smell | Example | Question to Ask |
|-------|---------|-----------------|
| Unused parameters | Function accepts options never used | Is this needed now? |
| Speculative generalization | Abstract factory for one implementation | Will there be more? |
| Future-proofing | Comments like "for future use" | When specifically? |
| Over-engineered solutions | Complex patterns for simple problems | What's the actual requirement? |
| Unused exports | Public APIs never called | Who uses this? |

### Review Checklist

- [ ] Is every feature being added actually required now?
- [ ] Are there abstractions with only one implementation?
- [ ] Is there commented-out code "for later"?
- [ ] Are there configuration options nobody uses?
- [ ] Is the complexity justified by current requirements?

### How to Report

```markdown
**YAGNI Violation** (Severity: Low)
- **Location**: `src/config/feature_flags.py:89-120`
- **Issue**: Plugin system infrastructure with no plugins
- **Question**: Are plugins on the roadmap? If not, consider removing.
```

---

## KISS (Keep It Simple, Stupid)

**Principle**: Simplicity should be a key goal. Avoid unnecessary complexity.

### What to Look For

| Complexity Smell | Simpler Alternative |
|------------------|---------------------|
| Nested ternaries | if/else blocks or early returns |
| Deep nesting (>3 levels) | Extract methods, guard clauses |
| Clever one-liners | Readable multi-line code |
| Overuse of design patterns | Direct solution when appropriate |
| Premature optimization | Clear code first, optimize when needed |
| Complex regex | String methods or parser |
| Callback hell | async/await or promises |

### Review Checklist

- [ ] Can a junior developer understand this code?
- [ ] Is there a simpler way to achieve the same result?
- [ ] Are design patterns adding value or just complexity?
- [ ] Is the code optimized prematurely?
- [ ] Would breaking this into smaller pieces help?

### Complexity Metrics to Consider

- **Cyclomatic complexity**: >10 is concerning, >20 needs refactoring
- **Function length**: >50 lines warrants scrutiny
- **Parameter count**: >4 parameters suggests object needed
- **Nesting depth**: >3 levels needs flattening

### How to Report

```markdown
**KISS Violation** (Severity: Medium)
- **Location**: `src/utils/parser.py:123`
- **Issue**: Complex nested list comprehension with multiple conditions
- **Current**: `[x.value for x in items if x.valid and x.type in types for y in x.children if y.active]`
- **Suggestion**: Break into explicit loop with clear variable names
```

---

## Single Source of Truth (SSOT)

**Principle**: Every piece of data should have one authoritative source.

### What to Look For

| Violation | Risk | Fix |
|-----------|------|-----|
| Duplicated state | Data gets out of sync | Derive from single source |
| Config in multiple places | Conflicting settings | Centralize configuration |
| Schema defined multiple times | Drift between definitions | Generate from one source |
| Constants redefined | Different values in different files | Single constants file |
| Business rules scattered | Inconsistent behavior | Centralize rules |

### Common SSOT Violations

1. **Database schema + ORM models + API types** defined separately
   - Fix: Generate types from schema, or use schema as source

2. **Frontend + Backend validation** with different rules
   - Fix: Share validation schema (JSON Schema, Zod, etc.)

3. **Environment variables** with defaults in multiple places
   - Fix: Single config module that loads and validates env

4. **Feature flags** checked with hardcoded strings
   - Fix: Enum or constants file for flag names

### Review Checklist

- [ ] Is any data or configuration defined in multiple places?
- [ ] If a value changes, how many files need updating?
- [ ] Are there derived values that could get out of sync?
- [ ] Is there a clear "owner" for each piece of data?

### How to Report

```markdown
**SSOT Violation** (Severity: High)
- **Location**: `src/api/schemas.py` and `src/db/models.py`
- **Issue**: User schema defined in both API layer and DB layer with different fields
- **Risk**: Fields added to one location may be forgotten in the other
- **Suggestion**: Generate API schema from DB models, or use shared base
```

---

## Review Output Format

Structure your review as follows:

```markdown
# Code Review: [PR Title or Description]

## Summary
[1-2 sentence overview of the changes and overall quality]

## Principle Violations

### Critical (Must Fix)
[List any high-severity violations that should block merge]

### Major (Should Fix)
[List medium-severity violations that should be addressed]

### Minor (Consider)
[List low-severity violations or suggestions]

## What's Done Well
[Acknowledge good practices observed in the code]

## Recommendations
[Prioritized list of specific actions]
```

---

## Severity Guidelines

| Severity | Criteria | Action |
|----------|----------|--------|
| **Critical** | Will cause bugs, security issues, or major maintenance burden | Block merge |
| **Major** | Significant code quality issue, but won't break functionality | Request changes |
| **Minor** | Style preference or minor improvement opportunity | Comment only |

---

## Quick Reference Card

```
DRY:   "Is this logic/data defined elsewhere?"
SRP:   "Does this do exactly one thing?"
OCP:   "Can I extend without modifying?"
LSP:   "Can subtypes substitute parents?"
ISP:   "Are interfaces focused and minimal?"
DIP:   "Do we depend on abstractions?"
YAGNI: "Do we need this right now?"
KISS:  "Is there a simpler way?"
SSOT:  "Where is the authoritative source?"
```

---

## Example Review

Here's how a complete review might look:

```markdown
# Code Review: Add User Export Feature (#142)

## Summary
Adds CSV export for user data. Implementation works but has several DRY
and SRP violations that will make maintenance difficult.

## Principle Violations

### Critical (Must Fix)
None

### Major (Should Fix)

**DRY Violation**
- `src/export/csv.py:45-60` duplicates date formatting from `src/utils/dates.py`
- Suggestion: Import and use `format_date()` from utils

**SRP Violation**
- `UserExporter` class handles file I/O, data transformation, and CSV formatting
- Suggestion: Split into `UserDataTransformer` and `CSVWriter`

### Minor (Consider)

**KISS**
- `build_row()` uses nested ternary that's hard to read
- Consider explicit if/else for clarity

## What's Done Well
- Good error handling with specific exception types
- Well-documented public API
- Comprehensive test coverage

## Recommendations
1. Extract date formatting to use shared utility
2. Consider splitting UserExporter responsibilities
3. Simplify build_row() logic
```
