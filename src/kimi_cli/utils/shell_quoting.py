"""Defensive rewrites applied to shell commands before execution.

The model occasionally hallucinates Windows CMD syntax even when running on
git-bash (which is POSIX). One such hallucination has caused real damage:
``cmd 2>nul`` in git-bash creates a literal file named ``nul`` in cwd, which
is a Windows reserved device name that breaks ``git add .`` / ``git clone``.

The fix here mirrors claude-code's ``rewriteWindowsNullRedirect``
(see anthropics/claude-code#4928): rewrite the bad redirect to ``/dev/null``
before the command reaches the shell.
"""

from __future__ import annotations

import re

# Match `>nul`, `> NUL`, `2>nul`, `&>nul`, `>>nul` (case-insensitive),
# but NOT `>null`, `>nullable`, `>nul.txt`, `cat nul.txt`.
#
# Group 1 captures the redirect operator + optional whitespace, so the rewrite
# preserves the original spacing (e.g. `2> nul` -> `2> /dev/null`).
_NUL_REDIRECT = re.compile(r"(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])")


def rewrite_windows_null_redirect(command: str) -> str:
    """Rewrite Windows-style ``>nul`` redirects to POSIX ``/dev/null``.

    Limitation: the regex does not parse shell quoting, so ``echo ">nul"``
    will also be rewritten. This is acceptable collateral — the case is
    extremely rare and rewriting to ``/dev/null`` inside a string literal is
    harmless.
    """
    return _NUL_REDIRECT.sub(r"\1/dev/null", command)
