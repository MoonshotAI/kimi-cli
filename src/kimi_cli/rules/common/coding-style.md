---
name: "Coding Style"
description: "General coding style guidelines for all languages"
priority: 100
---

# Coding Style Guidelines

## Code Organization

- **Small, focused files**: Aim for 200-400 lines per file, maximum 800 lines
- **Single responsibility**: Each file/module should have one clear purpose
- **Meaningful names**: Use descriptive variable, function, and class names

## Code Quality

- **Functions should be small**: Ideally under 50 lines
- **Avoid deep nesting**: Maximum 4 levels of indentation
- **Fail fast**: Validate inputs and preconditions early
- **No silent failures**: Always handle errors explicitly

## Comments and Documentation

- **Self-documenting code**: Prefer clear names over comments
- **Why, not what**: Comments should explain intent, not mechanics
- **Keep comments current**: Update or remove outdated comments

## General Principles

- **DRY (Don't Repeat Yourself)**: Extract common logic into reusable functions
- **YAGNI (You Aren't Gonna Need It)**: Don't add functionality until necessary
- **KISS (Keep It Simple, Stupid)**: Simple solutions are better than clever ones
