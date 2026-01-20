from __future__ import annotations

import pytest
from inline_snapshot import snapshot

from kimi_cli.skill.flow import Flow, FlowValidationError, parse_choice
from kimi_cli.skill.flow.d2 import parse_d2_flowchart
from kimi_cli.skill.flow.mermaid import parse_mermaid_flowchart


def test_parse_flowchart_basic() -> None:
    flow = parse_mermaid_flowchart(
        "\n".join(
            [
                "flowchart TD",
                "A([BEGIN]) --> B[Search stdrc]",
                "B --> C{Enough?}",
                "C -->|yes| D([END])",
                "C -->|no| B",
            ]
        )
    )

    assert _flow_snapshot(flow) == snapshot(
        {
            "begin_id": "A",
            "end_id": "D",
            "nodes": {
                "A": {"kind": "begin", "label": "BEGIN"},
                "B": {"kind": "task", "label": "Search stdrc"},
                "C": {"kind": "decision", "label": "Enough?"},
                "D": {"kind": "end", "label": "END"},
            },
            "outgoing": {
                "A": [{"dst": "B", "label": None}],
                "B": [{"dst": "C", "label": None}],
                "C": [
                    {"dst": "B", "label": "no"},
                    {"dst": "D", "label": "yes"},
                ],
                "D": [],
            },
        }
    )


def test_parse_flowchart_implicit_nodes() -> None:
    flow = parse_mermaid_flowchart(
        "\n".join(
            [
                "flowchart TD",
                "BEGIN --> TASK",
                "TASK --> END",
            ]
        )
    )

    assert _flow_snapshot(flow) == snapshot(
        {
            "begin_id": "BEGIN",
            "end_id": "END",
            "nodes": {
                "BEGIN": {"kind": "begin", "label": "BEGIN"},
                "END": {"kind": "end", "label": "END"},
                "TASK": {"kind": "task", "label": "TASK"},
            },
            "outgoing": {
                "BEGIN": [{"dst": "TASK", "label": None}],
                "END": [],
                "TASK": [{"dst": "END", "label": None}],
            },
        }
    )


def test_parse_flowchart_quoted_label() -> None:
    flow = parse_mermaid_flowchart(
        "\n".join(
            [
                "flowchart TD",
                'A(["BEGIN"]) --> B["hello | world"]',
                "B --> C([END])",
            ]
        )
    )

    assert _flow_snapshot(flow) == snapshot(
        {
            "begin_id": "A",
            "end_id": "C",
            "nodes": {
                "A": {"kind": "begin", "label": "BEGIN"},
                "B": {"kind": "task", "label": "hello | world"},
                "C": {"kind": "end", "label": "END"},
            },
            "outgoing": {
                "A": [{"dst": "B", "label": None}],
                "B": [{"dst": "C", "label": None}],
                "C": [],
            },
        }
    )


def test_parse_flowchart_multi_edges_require_labels() -> None:
    with pytest.raises(FlowValidationError):
        parse_mermaid_flowchart(
            "\n".join(
                [
                    "flowchart TD",
                    "A([BEGIN]) --> B[Pick]",
                    "B --> C([END])",
                    "B --> D([END])",
                ]
            )
        )


def test_parse_d2_flowchart_typical_example() -> None:
    flow = parse_d2_flowchart(
        "\n".join(
            [
                'a: "append a random line to file test.txt"',
                "a.shape: rectangle",
                "a.foo.bar",
                'b: "does test.txt contain more than 3 lines?" {',
                "  sub1 -> sub2",
                "  sub2: {",
                "    1",
                "  }",
                "}",
                "BEGIN -> a -> b",
                "b -> a: no",
                "not_used",
                "b -> END: yes",
                "b -> END: yes2",
            ]
        )
    )

    assert _flow_snapshot(flow) == snapshot(
        {
            "begin_id": "BEGIN",
            "end_id": "END",
            "nodes": {
                "BEGIN": {"kind": "begin", "label": "BEGIN"},
                "END": {"kind": "end", "label": "END"},
                "a": {"kind": "task", "label": "append a random line to file test.txt"},
                "a.foo.bar": {"kind": "task", "label": "a.foo.bar"},
                "b": {"kind": "decision", "label": "does test.txt contain more than 3 lines?"},
                "not_used": {"kind": "task", "label": "not_used"},
            },
            "outgoing": {
                "BEGIN": [{"dst": "a", "label": None}],
                "END": [],
                "a": [{"dst": "b", "label": None}],
                "a.foo.bar": [],
                "b": [
                    {"dst": "END", "label": "yes"},
                    {"dst": "END", "label": "yes2"},
                    {"dst": "a", "label": "no"},
                ],
                "not_used": [],
            },
        }
    )


def test_parse_flowchart_ignores_style_and_shapes() -> None:
    flow = parse_mermaid_flowchart(
        "\n".join(
            [
                "flowchart TB",
                "classDef highlight fill:#f9f,stroke:#333,stroke-width:2px;",
                "A([BEGIN]) --> B[Working tree clean?]",
                "B -- yes --> C{Prep PR}",
                "B -- no --> D([END])",
                "C --> D",
                "class B highlight",
                "style C fill:#bbf",
            ]
        )
    )

    assert _flow_snapshot(flow) == snapshot(
        {
            "begin_id": "A",
            "end_id": "D",
            "nodes": {
                "A": {"kind": "begin", "label": "BEGIN"},
                "B": {"kind": "decision", "label": "Working tree clean?"},
                "C": {"kind": "task", "label": "Prep PR"},
                "D": {"kind": "end", "label": "END"},
            },
            "outgoing": {
                "A": [{"dst": "B", "label": None}],
                "B": [
                    {"dst": "C", "label": "yes"},
                    {"dst": "D", "label": "no"},
                ],
                "C": [{"dst": "D", "label": None}],
                "D": [],
            },
        }
    )


def test_parse_choice_last_match() -> None:
    assert parse_choice("Answer <choice>a</choice> <choice>b</choice>") == "b"
    assert parse_choice("No choice tag") is None


def _flow_snapshot(flow: Flow) -> dict[str, object]:
    return {
        "begin_id": flow.begin_id,
        "end_id": flow.end_id,
        "nodes": {
            node_id: {"kind": flow.nodes[node_id].kind, "label": flow.nodes[node_id].label}
            for node_id in sorted(flow.nodes)
        },
        "outgoing": {
            node_id: [
                {"dst": edge.dst, "label": edge.label}
                for edge in sorted(
                    flow.outgoing.get(node_id, []),
                    key=lambda edge: (edge.dst, edge.label or ""),
                )
            ]
            for node_id in sorted(flow.nodes)
        },
    }
