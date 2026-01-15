from __future__ import annotations

import pytest

from kimi_cli.flow import (
    PromptFlowValidationError,
    parse_choice,
    parse_d2,
    parse_flowchart,
    parse_prompt_flow,
)


def test_parse_flowchart_basic() -> None:
    flow = parse_flowchart(
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
    flow = parse_flowchart(
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
    flow = parse_flowchart(
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
        parse_flowchart(
            "\n".join(
                [
                    "flowchart TD",
                    "A([BEGIN]) --> B{Pick}",
                    "B --> C([END])",
                ]
            )
        )


def test_parse_choice_last_match() -> None:
    assert parse_choice("Answer <choice>a</choice> <choice>b</choice>") == "b"
    assert parse_choice("No choice tag") is None


def test_parse_d2_basic() -> None:
    flow = parse_d2(
        "\n".join(
            [
                "# D2 prompt flow example",
                'BEGIN: "BEGIN"',
                "END: END",
                "TASK: Search stdrc",
                'DECISION: "Enough?"',
                "DECISION.shape: diamond",
                "BEGIN -> TASK",
                "TASK -> DECISION",
                "DECISION -> END: yes",
                "DECISION -> TASK: no",
            ]
        )
    )

    assert flow.begin_id == "BEGIN"
    assert flow.end_id == "END"
    assert flow.nodes["DECISION"].kind == "decision"
    assert [edge.label for edge in flow.outgoing["DECISION"]] == ["yes", "no"]


def test_parse_d2_connection_chaining_label_applies() -> None:
    flow = parse_d2(
        "\n".join(
            [
                "BEGIN",
                "END",
                "BEGIN -> A -> END: next",
                "A: Step",
            ]
        )
    )

    assert flow.begin_id == "BEGIN"
    assert flow.end_id == "END"
    assert [edge.label for edge in flow.outgoing["BEGIN"]] == ["next"]
    assert [edge.label for edge in flow.outgoing["A"]] == ["next"]


def test_parse_prompt_flow_auto_detects_d2() -> None:
    flow = parse_prompt_flow(
        "\n".join(
            [
                "BEGIN",
                "END",
                "BEGIN -> END",
            ]
        )
    )
    assert flow.begin_id == "BEGIN"
    assert flow.end_id == "END"
