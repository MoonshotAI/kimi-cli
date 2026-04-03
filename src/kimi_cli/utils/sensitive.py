from __future__ import annotations

import fnmatch
from pathlib import PurePath

# High-confidence sensitive file patterns.
# Only patterns with very low false-positive risk are included.
SENSITIVE_PATTERNS: list[str] = [
    # Environment variable / secrets
    ".env",
    ".env.*",
    # SSH private keys
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    # Cloud credentials (path-based, also bare name for stripped-path scenarios)
    ".aws/credentials",
    ".gcp/credentials",
    "credentials",
]

# Template/example files that match .env.* but are not sensitive.
SENSITIVE_EXEMPTIONS: set[str] = {
    ".env.example",
    ".env.sample",
    ".env.template",
}


def is_sensitive_file(path: str) -> bool:
    """Check if a file path matches any sensitive file pattern."""
    name = PurePath(path).name
    if name in SENSITIVE_EXEMPTIONS:
        return False
    for pattern in SENSITIVE_PATTERNS:
        if "/" in pattern:
            if path.endswith(pattern) or ("/" + pattern) in path:
                return True
        else:
            if fnmatch.fnmatch(name, pattern):
                return True
    return False


def sensitive_file_warning(paths: list[str]) -> str:
    """Generate a warning message for sensitive files that were skipped."""
    names = sorted({PurePath(p).name for p in paths})
    file_list = ", ".join(names[:5])
    if len(names) > 5:
        file_list += f", ... ({len(names)} files total)"
    return (
        f"Skipped {len(paths)} sensitive file(s) ({file_list}) "
        f"to protect secrets. These files may contain credentials or private keys."
    )
