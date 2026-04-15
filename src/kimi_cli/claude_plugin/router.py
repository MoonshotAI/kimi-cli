"""Minimal deterministic router for explicit plugin capability invocations.

Only matches when the user input is essentially the capability name itself
(bare invocation), optionally with trivial surrounding filler.  All other
natural-language inputs fall through to the model, which can see plugin
capabilities via the system prompt and choose them autonomously.

No execution-verb lists, no negation gates, no intent classification.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.claude_plugin.spec import ClaudeCommandSpec
    from kimi_cli.skill import Skill


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

_SPLIT_RE = re.compile(r"[-_\s]+")


def _normalize(name: str) -> str:
    """Collapse hyphens / underscores / whitespace into a single space, lowercase."""
    return _SPLIT_RE.sub(" ", name).strip().lower()


# ---------------------------------------------------------------------------
# Capability descriptor
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PluginCapability:
    """A single matchable plugin capability."""

    kind: Literal["skill", "flow_skill", "command"]
    name: str
    """Full namespaced name (e.g. ``webnovel-writer:webnovel-init``)."""
    skill: Skill | None = None
    command: ClaudeCommandSpec | None = None


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

# After stripping the capability name, only these trivial particles
# may remain on each side for a bare-invocation match.
_FILLER_PARTICLES: frozenset[str] = frozenset({
    "请", "功能", "吧", "啊", "呀", "一下", "下", "给我",
})

_STRIP_PUNCT_RE = re.compile("[\\s.,!?;:，。！？；：()\\[\\]{}\"'\u2E80-\u2EFF]+")


class PluginCapabilityIndex:
    """Lookup table that only matches bare / near-bare capability invocations.

    Each capability registers under its full namespaced name and its bare
    name (without plugin prefix).  A match requires that after removing the
    capability key from the normalized input, only trivial filler remains.
    """

    def __init__(self) -> None:
        self._entries: dict[str, PluginCapability] = {}
        self._ambiguous: set[str] = set()

    @property
    def size(self) -> int:
        return len(self._entries)

    def add(self, cap: PluginCapability) -> None:
        keys = _capability_keys(cap)
        for key in keys:
            if key in self._ambiguous:
                continue
            if key in self._entries:
                if self._entries[key] is not cap:
                    del self._entries[key]
                    self._ambiguous.add(key)
                    logger.debug(
                        "Plugin capability key '{key}' is ambiguous, "
                        "will not auto-dispatch",
                        key=key,
                    )
            else:
                self._entries[key] = cap

    def match(self, user_input: str) -> PluginCapability | None:
        """Match only if the input is essentially the capability name.

        Returns ``None`` for anything that looks like a sentence, question,
        or description — those should go to the model via ``_turn()``.
        """
        normalized = _normalize(user_input)
        if not normalized:
            return None

        for key, cap in self._entries.items():
            if key in normalized and _is_bare_invocation(normalized, key):
                return cap

        return None


# ---------------------------------------------------------------------------
# Index builder
# ---------------------------------------------------------------------------


def build_plugin_capability_index(
    skills: dict[str, Skill],
    commands: dict[str, ClaudeCommandSpec] | None = None,
) -> PluginCapabilityIndex:
    """Build an index from plugin skills and commands."""
    index = PluginCapabilityIndex()

    for skill in skills.values():
        if not skill.is_plugin:
            continue
        kind: Literal["skill", "flow_skill"] = (
            "flow_skill" if skill.type == "flow" and skill.flow is not None else "skill"
        )
        index.add(PluginCapability(kind=kind, name=skill.name, skill=skill))

    if commands:
        for cmd in commands.values():
            index.add(PluginCapability(kind="command", name=cmd.full_name, command=cmd))

    return index


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capability_keys(cap: PluginCapability) -> list[str]:
    """Normalized lookup keys for a capability."""
    keys = [_normalize(cap.name)]
    if ":" in cap.name:
        bare = _normalize(cap.name.split(":", 1)[1])
        if bare and bare != keys[0]:
            keys.append(bare)
    return keys


def _is_bare_invocation(normalized: str, key: str) -> bool:
    """True when the input is just the capability name ± trivial filler."""
    idx = normalized.find(key)
    if idx == -1:
        return False
    before = normalized[:idx].strip()
    after = normalized[idx + len(key) :].strip()

    before_clean = _STRIP_PUNCT_RE.sub("", before)
    after_clean = _STRIP_PUNCT_RE.sub("", after)

    return _is_filler(before_clean) and _is_filler(after_clean)


def _is_filler(text: str) -> bool:
    return not text or text in _FILLER_PARTICLES
