from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass

from kosong.message import Message
from kosong.tooling import ToolResult

from kimi_cli.utils.logging import logger


@dataclass(slots=True)
class ConvergenceReport:
    """Result of a convergence check."""

    is_converged: bool
    """True if the flow appears to be stuck in a loop."""
    similarity_score: float
    """0.0 to 1.0, where 1.0 means identical fingerprints."""
    repeated_patterns: list[str]
    """Human-readable description of what is repeating."""
    suggestion: str
    """Suggested action for the flow engine."""


@dataclass(slots=True)
class IterationFingerprint:
    """A lightweight fingerprint of one flow iteration."""

    assistant_text_hash: str
    tool_call_names: tuple[str, ...]
    tool_output_hashes: tuple[str, ...]

    @classmethod
    def from_turn(
        cls,
        assistant_message: Message | None,
        tool_results: Sequence[ToolResult] | None = None,
        exclude_tool_names: Sequence[str] | None = None,
    ) -> IterationFingerprint:
        text = assistant_message.extract_text(" ") if assistant_message else ""
        assistant_text_hash = hashlib.sha256(text.encode()).hexdigest()[:16]

        excluded = set(exclude_tool_names or ())
        tool_call_names: list[str] = []
        tool_output_hashes: list[str] = []
        if assistant_message and assistant_message.tool_calls:
            tool_call_names = [
                tc.function.name
                for tc in assistant_message.tool_calls
                if tc.function.name not in excluded
            ]
        if tool_results:
            for tr in tool_results:
                # Best-effort: we don't have direct access to the original tool call name
                # from ToolResult, so we hash the stringified return value.
                tool_output_hashes.append(
                    hashlib.sha256(str(tr.return_value).encode()).hexdigest()[:16]
                )

        return cls(
            assistant_text_hash=assistant_text_hash,
            tool_call_names=tuple(tool_call_names),
            tool_output_hashes=tuple(tool_output_hashes),
        )


class ConvergenceDetector:
    """Detects when a flow is repeating the same work across iterations."""

    def __init__(
        self,
        *,
        similarity_threshold: float = 0.85,
        min_repetitions: int = 2,
    ) -> None:
        self._similarity_threshold = similarity_threshold
        self._min_repetitions = min_repetitions
        self._fingerprints: list[IterationFingerprint] = []

    def record_iteration(
        self,
        assistant_message: Message | None,
        tool_results: Sequence[ToolResult] | None = None,
        exclude_tool_names: Sequence[str] | None = None,
    ) -> ConvergenceReport:
        fingerprint = IterationFingerprint.from_turn(
            assistant_message, tool_results, exclude_tool_names=exclude_tool_names
        )
        self._fingerprints.append(fingerprint)

        if len(self._fingerprints) < self._min_repetitions + 1:
            return ConvergenceReport(
                is_converged=False,
                similarity_score=0.0,
                repeated_patterns=[],
                suggestion="Continue.",
            )

        # Compare the most recent fingerprint with the previous ones
        latest = self._fingerprints[-1]
        max_similarity = 0.0
        repeated: list[str] = []

        for i, fp in enumerate(self._fingerprints[:-1]):
            similarity = self._compute_similarity(latest, fp)
            if similarity > max_similarity:
                max_similarity = similarity
            if similarity >= self._similarity_threshold:
                repeated.append(f"iteration {i + 1}")

        is_converged = (
            max_similarity >= self._similarity_threshold and len(repeated) >= self._min_repetitions
        )

        if is_converged:
            suggestion = (
                "The flow is repeating similar work. Consider STOPping and summarizing, "
                "or produce a fundamentally different approach."
            )
            logger.warning(
                "Convergence detected: similarity={similarity:.2f}, repeated={repeated}",
                similarity=max_similarity,
                repeated=repeated,
            )
        else:
            suggestion = "Continue."

        return ConvergenceReport(
            is_converged=is_converged,
            similarity_score=max_similarity,
            repeated_patterns=repeated,
            suggestion=suggestion,
        )

    @staticmethod
    def _compute_similarity(a: IterationFingerprint, b: IterationFingerprint) -> float:
        """Simple Jaccard-like similarity between two fingerprints."""
        scores: list[float] = []

        if a.assistant_text_hash == b.assistant_text_hash:
            scores.append(1.0)
        else:
            scores.append(0.0)

        if a.tool_call_names and b.tool_call_names:
            matches = sum(
                1 for x, y in zip(a.tool_call_names, b.tool_call_names, strict=False) if x == y
            )
            max_len = max(len(a.tool_call_names), len(b.tool_call_names))
            scores.append(matches / max_len if max_len > 0 else 0.0)
        elif not a.tool_call_names and not b.tool_call_names:
            scores.append(1.0)
        else:
            scores.append(0.0)

        if a.tool_output_hashes and b.tool_output_hashes:
            matches = sum(
                1
                for x, y in zip(a.tool_output_hashes, b.tool_output_hashes, strict=False)
                if x == y
            )
            max_len = max(len(a.tool_output_hashes), len(b.tool_output_hashes))
            scores.append(matches / max_len if max_len > 0 else 0.0)
        elif not a.tool_output_hashes and not b.tool_output_hashes:
            scores.append(1.0)
        else:
            scores.append(0.0)

        return sum(scores) / len(scores) if scores else 0.0
