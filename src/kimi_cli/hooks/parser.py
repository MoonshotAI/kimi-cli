"""Parser for HOOK.md files following the AgentHooks specification."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import frontmatter
import yaml


# Trigger name mapping: legacy names -> canonical names
TRIGGER_ALIASES: dict[str, str] = {
    # Legacy -> Canonical
    "session_start": "pre-session",
    "session_end": "post-session",
    "before_agent": "pre-agent-turn",
    "after_agent": "post-agent-turn",
    "before_stop": "pre-agent-turn-stop",
    "before_tool": "pre-tool-call",
    "after_tool": "post-tool-call",
    "after_tool_failure": "post-tool-call-failure",
    "subagent_start": "pre-subagent",
    "subagent_stop": "post-subagent",
    "pre_compact": "pre-context-compact",
}

# Valid canonical trigger names
VALID_TRIGGERS: set[str] = {
    # Session lifecycle
    "pre-session",
    "post-session",
    # Agent turn lifecycle
    "pre-agent-turn",
    "post-agent-turn",
    # Agent turn stop (Quality Gate)
    "pre-agent-turn-stop",
    "post-agent-turn-stop",
    # Tool interception
    "pre-tool-call",
    "post-tool-call",
    "post-tool-call-failure",
    # Subagent lifecycle
    "pre-subagent",
    "post-subagent",
    # Context management
    "pre-context-compact",
    "post-context-compact",
} | set(TRIGGER_ALIASES.keys())


def normalize_trigger(trigger: str) -> str:
    """Normalize trigger name to canonical form.

    Args:
        trigger: Trigger name (legacy or canonical)

    Returns:
        Canonical trigger name
    """
    return TRIGGER_ALIASES.get(trigger, trigger)


@dataclass(frozen=True, slots=True)
class HookMetadata:
    """Hook metadata parsed from YAML frontmatter."""

    name: str
    trigger: str
    description: str = ""
    matcher: dict[str, str] | None = None
    timeout: int = 30000
    async_: bool = field(default=False, kw_only=True)
    priority: int = 100
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> HookMetadata:
        """Create HookMetadata from dictionary."""
        # Handle 'async' field with alias
        async_value = data.get("async", data.get("async_", False))

        # Normalize trigger name (handle legacy aliases)
        trigger = normalize_trigger(data["trigger"])

        return cls(
            name=data["name"],
            trigger=trigger,
            description=data.get("description", ""),
            matcher=data.get("matcher"),
            timeout=data.get("timeout", 30000),
            async_=async_value,
            priority=data.get("priority", 100),
            metadata={k: v for k, v in data.items() if k not in cls._known_fields()},
        )

    @staticmethod
    def _known_fields() -> set[str]:
        return {"name", "trigger", "description", "matcher", "timeout", "async", "priority"}


@dataclass(frozen=True, slots=True)
class ParsedHook:
    """A parsed HOOK.md file."""

    path: Path
    metadata: HookMetadata
    content: str

    @property
    def name(self) -> str:
        return self.metadata.name

    @property
    def trigger(self) -> str:
        return self.metadata.trigger

    @property
    def scripts_dir(self) -> Path:
        """Path to the scripts directory."""
        return self.path / "scripts"

    def find_entry_point(self) -> Path | None:
        """Find the hook entry point script.

        Priority order:
        1. scripts/run (no extension)
        2. scripts/run.sh
        3. scripts/run.py
        """
        candidates = [
            self.scripts_dir / "run",
            self.scripts_dir / "run.sh",
            self.scripts_dir / "run.py",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None


class HookParser:
    """Parser for AgentHooks HOOK.md files."""

    @staticmethod
    def parse(hook_dir: Path) -> ParsedHook:
        """Parse a HOOK.md file from a hook directory.

        Args:
            hook_dir: Path to the hook directory containing HOOK.md

        Returns:
            ParsedHook object

        Raises:
            FileNotFoundError: If HOOK.md doesn't exist
            ValueError: If frontmatter is invalid
        """
        hook_md_path = hook_dir / "HOOK.md"
        if not hook_md_path.exists():
            raise FileNotFoundError(f"HOOK.md not found in {hook_dir}")

        # Parse frontmatter
        post = frontmatter.load(str(hook_md_path))

        if not post.metadata:
            raise ValueError(f"No YAML frontmatter found in {hook_md_path}")

        if "name" not in post.metadata or "trigger" not in post.metadata:
            raise ValueError(f"Missing required fields in {hook_md_path}: name, trigger")

        metadata = HookMetadata.from_dict(post.metadata)
        content = post.content

        return ParsedHook(
            path=hook_dir,
            metadata=metadata,
            content=content,
        )

    @staticmethod
    def parse_content(content: str, hook_name: str = "unknown") -> ParsedHook:
        """Parse HOOK.md content directly (for testing).

        Args:
            content: The HOOK.md file content
            hook_name: Name for the parsed hook

        Returns:
            ParsedHook object

        Raises:
            ValueError: If frontmatter is missing or invalid
        """
        post = frontmatter.loads(content)

        if not post.metadata:
            raise ValueError(f"No YAML frontmatter found in {hook_name}")

        if "name" not in post.metadata or "trigger" not in post.metadata:
            raise ValueError(f"Missing required fields in frontmatter: name, trigger")

        metadata = HookMetadata.from_dict(post.metadata)

        return ParsedHook(
            path=Path(hook_name),
            metadata=metadata,
            content=post.content,
        )


class Matcher:
    """Matcher for filtering hooks based on tool and pattern."""

    def __init__(self, tool: str | None = None, pattern: str | None = None):
        self.tool_pattern = re.compile(tool) if tool else None
        self.arg_pattern = re.compile(pattern) if pattern else None

    def matches(self, tool_name: str | None = None, arguments: dict[str, Any] | None = None) -> bool:
        """Check if the matcher matches the given context."""
        if self.tool_pattern is not None:
            if tool_name is None or not self.tool_pattern.search(tool_name):
                return False

        if self.arg_pattern is not None:
            if arguments is None or not self.arg_pattern.search(str(arguments)):
                return False

        return True
