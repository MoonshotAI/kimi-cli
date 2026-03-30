"""Shell command security analysis for approval workflows.

This module provides lightweight analysis of shell commands to highlight
potentially dangerous patterns in approval workflows. It does NOT sanitize
or block commands — it provides metadata for informed user consent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum, auto


class RiskLevel(Enum):
    """Risk classification for command patterns."""

    LOW = auto()
    MEDIUM = auto()  # Common but potentially destructive
    HIGH = auto()    # Dangerous patterns requiring extra scrutiny


@dataclass(frozen=True, slots=True)
class SecurityNote:
    """A security observation about a command."""

    pattern: str
    risk: RiskLevel
    description: str


# Patterns that merit attention in approval workflows
# These are advisory — the model is expected to run shell commands as part of
# normal operation, but users should be aware of risky patterns.
_SECURITY_PATTERNS: list[tuple[re.Pattern[str], RiskLevel, str]] = [
    # Command chaining and redirection (medium risk — common but powerful)
    (
        re.compile(r"(?:;|&&|\|\|)\s*\w+"),
        RiskLevel.MEDIUM,
        "Multiple commands chained with ; && ||",
    ),
    (re.compile(r"\|"), RiskLevel.MEDIUM, "Pipe to another command"),
    (re.compile(r"[<>]|>>|<<"), RiskLevel.MEDIUM, "File redirection"),
    # Command substitution (high risk — arbitrary code execution)
    (re.compile(r"`[^`]+`"), RiskLevel.HIGH, "Backtick command substitution"),
    (re.compile(r"\$\([^)]+\)"), RiskLevel.HIGH, "$(...) command substitution"),
    # Network operations (high risk — data exfiltration or download-execute)
    (
        re.compile(r"\b(curl|wget|nc|netcat|ncat)\b"),
        RiskLevel.HIGH,
        "Network transfer tool",
    ),
    # Network primitives via common interpreters (higher severity — likely evasion)
    (
        re.compile(r"\b(socat)\b"),
        RiskLevel.HIGH,
        "Socket relay tool (socat)",
    ),
    (
        re.compile(r"\bopenssl\s+s_client\b"),
        RiskLevel.HIGH,
        "SSL client for network connections",
    ),
    (
        re.compile(r"\bpython3?\s+-c\b.*\b(socket|urllib|http|exec|open|compile|__import__)\b"),
        RiskLevel.HIGH,
        "Python inline code with execution/network primitives",
    ),
    (
        re.compile(r"\bperl\s+-e\b.*\b(socket|net|www)\b"),
        RiskLevel.HIGH,
        "Perl inline code with network primitives",
    ),
    (
        re.compile(r"\bruby\s+-e\b.*\b(socket|net/http|open-uri)\b"),
        RiskLevel.HIGH,
        "Ruby inline code with network primitives",
    ),
    # Destructive operations (high risk)
    (re.compile(r"\brm\s+-[rf]*[rf]"), RiskLevel.HIGH, "Destructive rm with -r or -f flags"),
    (re.compile(r"\bdd\s+if="), RiskLevel.HIGH, "Disk write with dd"),
    (re.compile(r">\s+/\w+"), RiskLevel.HIGH, "Write to system path"),
    # Privilege escalation
    (re.compile(r"\bsudo\b"), RiskLevel.HIGH, "Privilege escalation with sudo"),
    (re.compile(r"\bsu\s+-"), RiskLevel.HIGH, "Switch user"),
    # Background/disown (medium — hides execution)
    (re.compile(r"&\s*$|&\s*disown"), RiskLevel.MEDIUM, "Background process"),
]


def analyze_command(command: str) -> list[SecurityNote]:
    """Analyze a shell command for security-relevant patterns.

    Returns a list of security notes sorted by risk level (high first).
    This is advisory — commands are not blocked, but risky patterns
    are highlighted for user review during approval.

    Args:
        command: The shell command to analyze.

    Returns:
        List of SecurityNote objects describing observed patterns.

    Example:
        >>> analyze_command("git add . && make test")
        [SecurityNote(pattern='&&', risk=RiskLevel.MEDIUM, description='Multiple commands chained')]
    """
    notes: list[SecurityNote] = []
    seen_patterns: set[str] = set()

    for pattern, risk, description in _SECURITY_PATTERNS:
        if pattern.search(command):
            # Deduplicate by description to avoid redundant warnings
            if description not in seen_patterns:
                seen_patterns.add(description)
                notes.append(
                    SecurityNote(
                        pattern=pattern.pattern[:50],  # Truncate long patterns
                        risk=risk,
                        description=description,
                    )
                )

    # Sort by risk level (high first)
    notes.sort(key=lambda n: n.risk.value, reverse=True)
    return notes


def has_high_risk_patterns(command: str) -> bool:
    """Quick check for high-risk patterns requiring extra scrutiny.

    Args:
        command: The shell command to check.

    Returns:
        True if any HIGH risk patterns are detected.
    """
    return any(note.risk == RiskLevel.HIGH for note in analyze_command(command))


def format_security_notes(notes: list[SecurityNote]) -> str:
    """Format security notes for display in approval panels.

    Args:
        notes: List of security notes from analyze_command().

    Returns:
        Formatted string for display, or empty string if no notes.
    """
    if not notes:
        return ""

    risk_prefix = {RiskLevel.LOW: "LOW", RiskLevel.MEDIUM: "MED", RiskLevel.HIGH: "HIGH"}
    lines = ["Security notes:"]
    for note in notes:
        lines.append(f"  [{risk_prefix[note.risk]}] {note.description}")

    return "\n".join(lines)
