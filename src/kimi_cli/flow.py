from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

from kosong.message import ContentPart

FlowNodeKind = Literal["begin", "end", "task", "decision"]
PromptFlowFormat = Literal["auto", "mermaid", "d2"]


class PromptFlowError(ValueError):
    """Base error for prompt flow parsing/validation."""


class PromptFlowParseError(PromptFlowError):
    """Raised when prompt flow parsing fails."""


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


def parse_d2(text: str) -> PromptFlow:
    """
    Parse a Prompt Flow from a D2 diagram.

    Supported subset:
    - Line comments: `# ...`
    - Block comments: `\"\"\" ... \"\"\"`
    - Statements separated by newlines or `;`
    - Shape declarations:
      - `ID` (implicit label uses ID)
      - `ID: label` (optional quotes)
      - `ID.shape: diamond` (marks a decision node)
    - Directed connections (can be chained):
      - `A -> B`
      - `A -> B: label` (label applies to each connection in a chain)
      - `A -> B <- C: label`

    Notes:
    - BEGIN/END nodes are detected by label (case-insensitive), same as Mermaid flows.
    - Any node (except BEGIN/END) with >1 outgoing edges is treated as a decision node.
    - Undirected (`--`) and bidirectional (`<->`) connections are rejected for Prompt Flow.
    """

    nodes: dict[str, _D2NodeDef] = {}
    outgoing: dict[str, list[FlowEdge]] = {}

    for line_no, statement in _iter_d2_statements(text):
        if _d2_has_connection(statement):
            chain, label = _parse_d2_connection_statement(statement, line_no)
            for src_key, dst_key in chain:
                src_id = _d2_ensure_node(nodes, src_key, line_no)
                dst_id = _d2_ensure_node(nodes, dst_key, line_no)
                edge = FlowEdge(src=src_id, dst=dst_id, label=label)
                outgoing.setdefault(edge.src, []).append(edge)
                outgoing.setdefault(edge.dst, [])
            continue

        _parse_d2_shape_statement(nodes, statement, line_no)

    for node_id in (node.node_id for node in nodes.values()):
        outgoing.setdefault(node_id, [])

    flow_nodes = _d2_build_flow_nodes(nodes, outgoing)
    begin_id, end_id = _validate_flow(flow_nodes, outgoing)
    return PromptFlow(nodes=flow_nodes, outgoing=outgoing, begin_id=begin_id, end_id=end_id)


def parse_prompt_flow(text: str, *, format: PromptFlowFormat = "auto") -> PromptFlow:
    """
    Parse a prompt flow from Mermaid flowchart syntax or D2 syntax.

    If `format="auto"`, we detect Mermaid by a leading `flowchart` / `graph` header (ignoring
    comments).
    """

    detected: PromptFlowFormat = format
    if format == "auto":
        detected = "mermaid" if _looks_like_mermaid_flowchart(text) else "d2"
    if detected == "mermaid":
        return parse_flowchart(text)
    if detected == "d2":
        return parse_d2(text)
    raise PromptFlowParseError(f"Unknown prompt flow format: {format}")


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


def _looks_like_mermaid_flowchart(text: str) -> bool:
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("%%"):
            continue
        return _HEADER_RE.match(line) is not None
    return False


@dataclass(slots=True)
class _D2NodeDef:
    node_id: str
    label: str
    explicit_label: bool
    shape: str | None
    explicit_shape: bool


_D2_OPS = ("<->", "->", "<-", "--")


def _iter_d2_statements(text: str) -> Iterator[tuple[int, str]]:
    in_string = False
    in_block_comment = False
    brace_depth = 0
    line_no = 1
    statement_start_line = 1
    buf: list[str] = []

    i = 0
    while i < len(text):
        if in_block_comment:
            if text.startswith('"""', i):
                in_block_comment = False
                i += 3
                continue
            if text[i] == "\n":
                line_no += 1
            i += 1
            continue

        if not in_string and text.startswith('"""', i):
            in_block_comment = True
            i += 3
            continue

        ch = text[i]

        if not in_string and ch == "#":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue

        if not in_string:
            if ch == "{":
                brace_depth += 1
            elif ch == "}" and brace_depth > 0:
                brace_depth -= 1

        if ch == "\n":
            if not in_string and brace_depth == 0:
                statement = "".join(buf).strip()
                if statement:
                    yield statement_start_line, statement
                buf.clear()
                statement_start_line = line_no + 1
            else:
                buf.append(ch)
            line_no += 1
            i += 1
            continue

        if ch == ";" and not in_string and brace_depth == 0:
            statement = "".join(buf).strip()
            if statement:
                yield statement_start_line, statement
            buf.clear()
            statement_start_line = line_no
            i += 1
            continue

        if ch == '"' and not in_string:
            in_string = True
            buf.append(ch)
            i += 1
            continue

        if in_string and ch == "\\" and i + 1 < len(text):
            buf.append(ch)
            buf.append(text[i + 1])
            i += 2
            continue

        if in_string and ch == '"':
            in_string = False

        buf.append(ch)
        i += 1

    statement = "".join(buf).strip()
    if statement:
        yield statement_start_line, statement


def _d2_has_connection(statement: str) -> bool:
    return _d2_find_first_op(statement) is not None


def _d2_find_first_op(statement: str) -> tuple[int, str] | None:
    in_string = False
    brace_depth = 0
    i = 0
    while i < len(statement):
        ch = statement[i]
        if in_string:
            if ch == "\\" and i + 1 < len(statement):
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            i += 1
            continue

        if ch == "{":
            brace_depth += 1
            i += 1
            continue
        if ch == "}" and brace_depth > 0:
            brace_depth -= 1
            i += 1
            continue

        if brace_depth == 0:
            for op in _D2_OPS:
                if statement.startswith(op, i):
                    return i, op
        i += 1
    return None


def _d2_find_first_colon(statement: str) -> int | None:
    in_string = False
    brace_depth = 0
    i = 0
    while i < len(statement):
        ch = statement[i]
        if in_string:
            if ch == "\\" and i + 1 < len(statement):
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            i += 1
            continue

        if ch == "{":
            brace_depth += 1
            i += 1
            continue
        if ch == "}" and brace_depth > 0:
            brace_depth -= 1
            i += 1
            continue

        if brace_depth == 0 and ch == ":":
            return i
        i += 1
    return None


def _d2_parse_string(value: str, line_no: int, *, context: str) -> str:
    value = value.strip()
    if not value:
        raise PromptFlowParseError(_line_error(line_no, f"Expected {context}"))
    if value[0] != '"':
        return value

    idx = 1
    buf: list[str] = []
    while idx < len(value):
        ch = value[idx]
        if ch == '"':
            idx += 1
            rest = value[idx:].strip()
            if rest:
                raise PromptFlowParseError(_line_error(line_no, f"Unexpected trailing {context}"))
            result = "".join(buf)
            if not result.strip():
                message = f"{context.capitalize()} cannot be empty"
                raise PromptFlowParseError(_line_error(line_no, message))
            return result
        if ch == "\\" and idx + 1 < len(value):
            buf.append(value[idx + 1])
            idx += 2
            continue
        buf.append(ch)
        idx += 1
    raise PromptFlowParseError(_line_error(line_no, f"Unclosed quoted {context}"))


def _parse_d2_connection_statement(
    statement: str,
    line_no: int,
) -> tuple[list[tuple[str, str]], str | None]:
    if _d2_find_first_op(statement) is None:
        raise PromptFlowParseError(_line_error(line_no, "Expected connection"))

    colon_idx = _d2_find_first_colon(statement)
    chain_part = statement
    label: str | None = None
    if colon_idx is not None:
        chain_part = statement[:colon_idx].rstrip()
        label_part = statement[colon_idx + 1 :].strip()
        if label_part:
            if label_part.startswith("{"):
                label = None
            else:
                label = _d2_parse_string(label_part, line_no, context="edge label").strip()
                if not label:
                    raise PromptFlowParseError(_line_error(line_no, "Edge label cannot be empty"))

    segments, ops = _d2_split_chain(chain_part, line_no)
    if not ops:
        raise PromptFlowParseError(_line_error(line_no, "Expected connection operator"))

    edges: list[tuple[str, str]] = []
    for idx, op in enumerate(ops):
        if op in ("--", "<->"):
            raise PromptFlowParseError(
                _line_error(line_no, f"Unsupported connection operator for prompt flow: {op}")
            )
        left = segments[idx]
        right = segments[idx + 1]
        if op == "->":
            edges.append((left, right))
        elif op == "<-":
            edges.append((right, left))
        else:
            message = f"Unsupported connection operator: {op}"
            raise PromptFlowParseError(_line_error(line_no, message))

    return edges, label


def _d2_split_chain(statement: str, line_no: int) -> tuple[list[str], list[str]]:
    in_string = False
    brace_depth = 0
    buf: list[str] = []
    segments: list[str] = []
    ops: list[str] = []

    i = 0
    while i < len(statement):
        ch = statement[i]
        if in_string:
            if ch == "\\" and i + 1 < len(statement):
                buf.append(ch)
                buf.append(statement[i + 1])
                i += 2
                continue
            buf.append(ch)
            if ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            buf.append(ch)
            i += 1
            continue

        if ch == "{":
            brace_depth += 1
        elif ch == "}" and brace_depth > 0:
            brace_depth -= 1

        if brace_depth == 0:
            op = next((cand for cand in _D2_OPS if statement.startswith(cand, i)), None)
            if op is not None:
                segment_raw = "".join(buf).strip()
                if not segment_raw:
                    raise PromptFlowParseError(_line_error(line_no, "Expected node id"))
                segments.append(_d2_parse_string(segment_raw, line_no, context="node id"))
                ops.append(op)
                buf.clear()
                i += len(op)
                continue

        buf.append(ch)
        i += 1

    segment_raw = "".join(buf).strip()
    if not segment_raw:
        raise PromptFlowParseError(_line_error(line_no, "Expected node id"))
    segments.append(_d2_parse_string(segment_raw, line_no, context="node id"))
    return segments, ops


def _d2_ensure_node(nodes: dict[str, _D2NodeDef], key: str, line_no: int) -> str:
    canon = key.strip().casefold()
    if not canon:
        raise PromptFlowParseError(_line_error(line_no, "Expected node id"))
    existing = nodes.get(canon)
    if existing is not None:
        return existing.node_id
    node_id = key.strip()
    nodes[canon] = _D2NodeDef(
        node_id=node_id,
        label=node_id,
        explicit_label=False,
        shape=None,
        explicit_shape=False,
    )
    return node_id


def _parse_d2_shape_statement(nodes: dict[str, _D2NodeDef], statement: str, line_no: int) -> None:
    colon_idx = _d2_find_first_colon(statement)
    if colon_idx is None:
        _d2_ensure_node(nodes, _d2_parse_string(statement, line_no, context="node id"), line_no)
        return

    lhs = statement[:colon_idx].strip()
    rhs = statement[colon_idx + 1 :].strip()
    if not lhs:
        raise PromptFlowParseError(_line_error(line_no, "Expected node id"))

    # Accept D2-style `ID.shape: diamond` to mark decision nodes.
    base_key = lhs
    field: str | None = None
    if "." in lhs:
        base_key, field = lhs.rsplit(".", 1)
        base_key = base_key.strip()
        field = field.strip()
    node_key = _d2_parse_string(base_key, line_no, context="node id")
    canon = node_key.strip().casefold()
    node_id = _d2_ensure_node(nodes, node_key, line_no)
    node = nodes[canon]

    if field is not None and field.casefold() == "shape":
        shape_value = _d2_parse_string(rhs, line_no, context="shape").strip()
        if not shape_value:
            raise PromptFlowParseError(_line_error(line_no, "Shape cannot be empty"))
        if node.shape == shape_value:
            return
        if node.explicit_shape and node.shape is not None:
            raise PromptFlowParseError(
                _line_error(line_no, f'Conflicting definition for node "{node_id}"')
            )
        node.shape = shape_value
        node.explicit_shape = True
        return

    label_value = _d2_parse_string(rhs, line_no, context="node label").strip()
    if not label_value:
        raise PromptFlowParseError(_line_error(line_no, "Node label cannot be empty"))

    if node.label == label_value:
        node.explicit_label = node.explicit_label or True
        return
    if node.explicit_label:
        message = f'Conflicting definition for node "{node_id}"'
        raise PromptFlowParseError(_line_error(line_no, message))
    node.label = label_value
    node.explicit_label = True


def _d2_build_flow_nodes(
    nodes: dict[str, _D2NodeDef],
    outgoing: dict[str, list[FlowEdge]],
) -> dict[str, FlowNode]:
    result: dict[str, FlowNode] = {}
    for node in nodes.values():
        label_norm = node.label.strip().lower()
        kind: FlowNodeKind = "task"
        if label_norm == "begin":
            kind = "begin"
        elif label_norm == "end":
            kind = "end"
        else:
            edges = outgoing.get(node.node_id, [])
            if (node.shape or "").strip().casefold() == "diamond" or len(edges) > 1:
                kind = "decision"

        result[node.node_id] = FlowNode(id=node.node_id, label=node.label, kind=kind)
    return result
