from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from kosong.message import ContentPart

FlowNodeKind = Literal["begin", "end", "task", "decision"]


class PromptFlowError(ValueError):
    """Base error for prompt flow parsing/validation."""


class PromptFlowParseError(PromptFlowError):
    """Raised when Mermaid flowchart parsing fails."""


class PromptFlowValidationError(PromptFlowError):
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
class PromptFlow:
    nodes: dict[str, FlowNode]
    outgoing: dict[str, list[FlowEdge]]
    begin_id: str
    end_id: str


@dataclass(frozen=True, slots=True)
class _NodeSpec:
    node_id: str
    label: str | None
    shape: str | None


@dataclass(slots=True)
class _NodeDef:
    node: FlowNode
    explicit: bool


_NODE_ID_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]*")
_HEADER_RE = re.compile(r"^(flowchart|graph)\b", re.IGNORECASE)
_CHOICE_RE = re.compile(r"<choice>([^<]*)</choice>")

_SHAPES = {
    "[": ("square", "]"),
    "(": ("paren", ")"),
    "{": ("curly", "}"),
}


def parse_choice(text: str) -> str | None:
    matches = _CHOICE_RE.findall(text or "")
    if not matches:
        return None
    return matches[-1].strip()


def parse_flowchart(text: str) -> PromptFlow:
    nodes: dict[str, _NodeDef] = {}
    outgoing: dict[str, list[FlowEdge]] = {}

    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("%%"):
            continue
        if _HEADER_RE.match(line):
            continue
        if "-->" in line:
            src_spec, label, dst_spec = _parse_edge_line(line, line_no)
            src_node = _add_node(nodes, src_spec, line_no)
            dst_node = _add_node(nodes, dst_spec, line_no)
            edge = FlowEdge(src=src_node.id, dst=dst_node.id, label=label)
            outgoing.setdefault(edge.src, []).append(edge)
            outgoing.setdefault(edge.dst, [])
            continue

        node_spec, idx = _parse_node_token(line, 0, line_no)
        idx = _skip_ws(line, idx)
        if idx != len(line):
            raise PromptFlowParseError(_line_error(line_no, "Unexpected trailing content"))
        _add_node(nodes, node_spec, line_no)

    flow_nodes = {node_id: node_def.node for node_id, node_def in nodes.items()}
    for node_id in flow_nodes:
        outgoing.setdefault(node_id, [])

    begin_id, end_id = _validate_flow(flow_nodes, outgoing)
    return PromptFlow(nodes=flow_nodes, outgoing=outgoing, begin_id=begin_id, end_id=end_id)


def _parse_edge_line(line: str, line_no: int) -> tuple[_NodeSpec, str | None, _NodeSpec]:
    src_spec, idx = _parse_node_token(line, 0, line_no)
    idx = _skip_ws(line, idx)
    if line.startswith("-->", idx):
        idx += 3
        idx = _skip_ws(line, idx)
        label = None
        if idx < len(line) and line[idx] == "|":
            label, idx = _parse_pipe_label(line, idx, line_no)
            idx = _skip_ws(line, idx)
        dst_spec, idx = _parse_node_token(line, idx, line_no)
        idx = _skip_ws(line, idx)
        if idx != len(line):
            raise PromptFlowParseError(_line_error(line_no, "Unexpected trailing content"))
        return src_spec, label, dst_spec

    if line.startswith("--", idx):
        idx += 2
        arrow_idx = line.find("-->", idx)
        if arrow_idx == -1:
            raise PromptFlowParseError(_line_error(line_no, "Expected '-->' to end edge label"))
        label = line[idx:arrow_idx].strip()
        if not label:
            raise PromptFlowParseError(_line_error(line_no, "Edge label cannot be empty"))
        idx = arrow_idx + 3
        idx = _skip_ws(line, idx)
        dst_spec, idx = _parse_node_token(line, idx, line_no)
        idx = _skip_ws(line, idx)
        if idx != len(line):
            raise PromptFlowParseError(_line_error(line_no, "Unexpected trailing content"))
        return src_spec, label, dst_spec

    raise PromptFlowParseError(_line_error(line_no, "Expected edge arrow"))


def _parse_node_token(line: str, idx: int, line_no: int) -> tuple[_NodeSpec, int]:
    match = _NODE_ID_RE.match(line, idx)
    if not match:
        raise PromptFlowParseError(_line_error(line_no, "Expected node id"))
    node_id = match.group(0)
    idx = match.end()

    if idx >= len(line) or line[idx] not in _SHAPES:
        return _NodeSpec(node_id=node_id, label=None, shape=None), idx

    shape, close_char = _SHAPES[line[idx]]
    idx += 1
    label, idx = _parse_label(line, idx, close_char, line_no)
    return _NodeSpec(node_id=node_id, label=label, shape=shape), idx


def _parse_label(line: str, idx: int, close_char: str, line_no: int) -> tuple[str, int]:
    if idx >= len(line):
        raise PromptFlowParseError(_line_error(line_no, "Expected node label"))
    if close_char == ")" and line[idx] == "[":
        label, idx = _parse_label(line, idx + 1, "]", line_no)
        while idx < len(line) and line[idx].isspace():
            idx += 1
        if idx >= len(line) or line[idx] != ")":
            raise PromptFlowParseError(_line_error(line_no, "Unclosed node label"))
        return label, idx + 1
    if line[idx] == '"':
        idx += 1
        buf: list[str] = []
        while idx < len(line):
            ch = line[idx]
            if ch == '"':
                idx += 1
                while idx < len(line) and line[idx].isspace():
                    idx += 1
                if idx >= len(line) or line[idx] != close_char:
                    raise PromptFlowParseError(_line_error(line_no, "Unclosed node label"))
                return "".join(buf), idx + 1
            if ch == "\\" and idx + 1 < len(line):
                buf.append(line[idx + 1])
                idx += 2
                continue
            buf.append(ch)
            idx += 1
        raise PromptFlowParseError(_line_error(line_no, "Unclosed quoted label"))

    end = line.find(close_char, idx)
    if end == -1:
        raise PromptFlowParseError(_line_error(line_no, "Unclosed node label"))
    label = line[idx:end].strip()
    if not label:
        raise PromptFlowParseError(_line_error(line_no, "Node label cannot be empty"))
    return label, end + 1


def _parse_pipe_label(line: str, idx: int, line_no: int) -> tuple[str, int]:
    if line[idx] != "|":
        raise PromptFlowParseError(_line_error(line_no, "Expected '|' for edge label"))
    end = line.find("|", idx + 1)
    if end == -1:
        raise PromptFlowParseError(_line_error(line_no, "Unclosed edge label"))
    label = line[idx + 1 : end].strip()
    if not label:
        raise PromptFlowParseError(_line_error(line_no, "Edge label cannot be empty"))
    return label, end + 1


def _skip_ws(line: str, idx: int) -> int:
    while idx < len(line) and line[idx].isspace():
        idx += 1
    return idx


def _add_node(nodes: dict[str, _NodeDef], spec: _NodeSpec, line_no: int) -> FlowNode:
    label = spec.label if spec.label is not None else spec.node_id
    label_norm = label.strip().lower()
    if not label:
        raise PromptFlowParseError(_line_error(line_no, "Node label cannot be empty"))

    kind: FlowNodeKind = "task"
    if spec.shape == "curly":
        kind = "decision"
    if label_norm == "begin":
        kind = "begin"
    elif label_norm == "end":
        kind = "end"

    node = FlowNode(id=spec.node_id, label=label, kind=kind)
    explicit = spec.label is not None

    existing = nodes.get(spec.node_id)
    if existing is None:
        nodes[spec.node_id] = _NodeDef(node=node, explicit=explicit)
        return node

    if existing.node == node:
        return existing.node

    if not explicit and existing.explicit:
        return existing.node

    if explicit and not existing.explicit:
        nodes[spec.node_id] = _NodeDef(node=node, explicit=True)
        return node

    raise PromptFlowParseError(
        _line_error(line_no, f'Conflicting definition for node "{spec.node_id}"')
    )


def _validate_flow(
    nodes: dict[str, FlowNode],
    outgoing: dict[str, list[FlowEdge]],
) -> tuple[str, str]:
    begin_ids = [node.id for node in nodes.values() if node.kind == "begin"]
    end_ids = [node.id for node in nodes.values() if node.kind == "end"]

    if len(begin_ids) != 1:
        raise PromptFlowValidationError(f"Expected exactly one BEGIN node, found {len(begin_ids)}")
    if len(end_ids) != 1:
        raise PromptFlowValidationError(f"Expected exactly one END node, found {len(end_ids)}")

    begin_id = begin_ids[0]
    end_id = end_ids[0]

    for node in nodes.values():
        edges = outgoing.get(node.id, [])
        if node.kind == "begin":
            if len(edges) != 1:
                raise PromptFlowValidationError("BEGIN node must have exactly one outgoing edge")
            continue
        if node.kind == "end":
            if edges:
                raise PromptFlowValidationError("END node must not have outgoing edges")
            continue
        if node.kind == "decision":
            if not edges:
                raise PromptFlowValidationError(
                    f'Decision node "{node.id}" must have outgoing edges'
                )
            labels: list[str] = []
            for edge in edges:
                if edge.label is None or not edge.label.strip():
                    raise PromptFlowValidationError(
                        f'Decision node "{node.id}" has an unlabeled edge'
                    )
                labels.append(edge.label)
            if len(set(labels)) != len(labels):
                raise PromptFlowValidationError(
                    f'Decision node "{node.id}" has duplicate edge labels'
                )
            continue
        if len(edges) != 1:
            raise PromptFlowValidationError(f'Node "{node.id}" must have exactly one outgoing edge')

    return begin_id, end_id


def _line_error(line_no: int, message: str) -> str:
    return f"Line {line_no}: {message}"
