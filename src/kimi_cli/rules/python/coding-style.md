---
name: "Python Coding Style"
description: "Python-specific coding conventions"
priority: 50
paths:
  - "**/*.py"
  - "**/*.pyi"
---

# Python Coding Style

## Standards

- **Follow PEP 8**: Use standard Python naming and formatting conventions
- **Type annotations**: Add type hints to all function signatures
- **Docstrings**: Use Google-style or NumPy-style docstrings for public APIs

## Code Patterns

### Immutability

Prefer immutable data structures where possible:

```python
from dataclasses import dataclass
from typing import NamedTuple, Final

# Use frozen dataclasses
@dataclass(frozen=True)
class Config:
    name: str
    value: int

# Or NamedTuple for simple cases
class Point(NamedTuple):
    x: float
    y: float

# Constants should be UPPER_CASE
MAX_RETRIES: Final[int] = 3
```

### Error Handling

- **Use specific exceptions**: Catch specific exceptions, not bare `except:`
- **Provide context**: Include relevant information in exception messages
- **Don't swallow exceptions**: Log or re-raise, don't silently ignore

```python
# Good
try:
    data = load_config(path)
except FileNotFoundError as e:
    logger.error("Config file not found: %s", path)
    raise ConfigError(f"Cannot load config from {path}") from e

# Bad
try:
    data = load_config(path)
except:  # Too broad!
    pass  # Silently ignoring!
```

## Tooling

When available, prefer these tools for code quality:

- **ruff**: Fast Python linter (replaces flake8, pylint)
- **black**: Code formatter
- **pyright** or **mypy**: Type checking
- **pytest**: Testing framework
