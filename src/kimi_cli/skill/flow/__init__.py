from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from kosong.message import ContentPart

FlowNodeKind = Literal["begin", "end", "task", "decision"]


class FlowError(ValueError):
    """Base error for flow parsing/validation."""


class FlowParseError(FlowError):
    """Raised when prompt flow parsing fails."""


class FlowValidationError(FlowError):
    """Raised when a flowchart fails validation."""


@dataclass(frozen=True, slots=True)
class FlowNode:
    id: str
    label: str | list[ContentPart]
    kind: FlowNodeKind


@dataclass(frozen=True, slots=True)
class FlowEdge:
    src: str
    dst: str
    label: str | None


@dataclass(slots=True)
class Flow:
    nodes: dict[str, FlowNode]
    outgoing: dict[str, list[FlowEdge]]
    begin_id: str
    end_id: str


_CHOICE_RE = re.compile(r"<choice>([^<]*)</choice>")


def parse_choice(text: str) -> str | None:
    matches = _CHOICE_RE.findall(text or "")
    if not matches:
        return None
    return matches[-1].strip()


def validate_flow(
    nodes: dict[str, FlowNode],
    outgoing: dict[str, list[FlowEdge]],
) -> tuple[str, str]:
    begin_ids = [node.id for node in nodes.values() if node.kind == "begin"]
    end_ids = [node.id for node in nodes.values() if node.kind == "end"]

    if len(begin_ids) != 1:
        raise FlowValidationError(f"Expected exactly one BEGIN node, found {len(begin_ids)}")
    if len(end_ids) != 1:
        raise FlowValidationError(f"Expected exactly one END node, found {len(end_ids)}")

    begin_id = begin_ids[0]
    end_id = end_ids[0]

    reachable: set[str] = set()
    queue: list[str] = [begin_id]
    while queue:
        node_id = queue.pop()
        if node_id in reachable:
            continue
        reachable.add(node_id)
        for edge in outgoing.get(node_id, []):
            if edge.dst not in reachable:
                queue.append(edge.dst)

    for node in nodes.values():
        if node.id not in reachable:
            continue
        edges = outgoing.get(node.id, [])
        if len(edges) <= 1:
            continue
        labels: list[str] = []
        for edge in edges:
            if edge.label is None or not edge.label.strip():
                raise FlowValidationError(f'Node "{node.id}" has an unlabeled edge')
            labels.append(edge.label)
        if len(set(labels)) != len(labels):
            raise FlowValidationError(f'Node "{node.id}" has duplicate edge labels')

    if end_id not in reachable:
        raise FlowValidationError("END node is not reachable from BEGIN")

    return begin_id, end_id
