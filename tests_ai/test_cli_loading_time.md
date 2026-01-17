# CLI Loading Time

## `src/gitrekt_cli/__init__.py` be empty

**Scope**

`src/gitrekt_cli/__init__.py`

**Requirements**

The `src/gitrekt_cli/__init__.py` file must be empty, containing no code or imports.

## No unnecessary import in `src/gitrekt_cli/cli.py`

**Scope**

`src/gitrekt_cli/cli.py`

**Requirements**

The `src/gitrekt_cli/cli.py` file must not import any modules from `gitrekt_cli` or `kosong`, except for `gitrekt_cli.constant`, at the top level.

## As-needed imports in `src/gitrekt_cli/app.py`

**Scope**

`src/gitrekt_cli/app.py`

**Requirements**

The `src/gitrekt_cli/app.py` file must not import any modules prefixed with `gitrekt_cli.ui` at the top level; instead, UI-specific modules should be imported within functions as needed.

<examples>

```python
# top-level
from gitrekt_cli.ui.shell import ShellApp  # Incorrect: top-level import of UI module

# inside function
async def run_shell_app(...):
    from gitrekt_cli.ui.shell import ShellApp  # Correct: import as needed
    app = ShellApp(...)
    await app.run()
```

</examples>

## `--help` should run fast

**Scope**

No specific source file.

**Requirements**

The time taken to run `uv run Gitrekt --help` must be less than 150 milliseconds on average over 5 runs after a 3-run warm-up.
