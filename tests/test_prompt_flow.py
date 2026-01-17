from __future__ import annotations

import pytest
from inline_snapshot import snapshot

from gitrekt_cli.flow import PromptFlow, PromptFlowValidationError, parse_choice
from gitrekt_cli.flow.d2 import parse_d2_flowchart
from gitrekt_cli.flow.mermaid import parse_mermaid_flowchart


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

    assert flow.begin_id == "A"
    assert flow.end_id == "D"
    assert flow.nodes["A"].kind == "begin"
    assert flow.nodes["C"].kind == "decision"
    assert [edge.label for edge in flow.outgoing["C"]] == ["yes", "no"]


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

    assert flow.begin_id == "BEGIN"
    assert flow.end_id == "END"
    assert flow.nodes["TASK"].label == "TASK"


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

    assert flow.nodes["B"].label == "hello | world"


def test_parse_flowchart_decision_requires_labels() -> None:
    with pytest.raises(PromptFlowValidationError):
        parse_mermaid_flowchart(
            "\n".join(
                [
                    "flowchart TD",
                    "A([BEGIN]) --> B{Pick}",
                    "B --> C([END])",
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


def test_parse_choice_last_match() -> None:
    assert parse_choice("Answer <choice>a</choice> <choice>b</choice>") == "b"
    assert parse_choice("No choice tag") is None


def _flow_snapshot(flow: PromptFlow) -> dict[str, object]:
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
