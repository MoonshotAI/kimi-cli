use std::collections::BTreeMap;

use kagent::skill::flow::d2::parse_d2_flowchart;
use kagent::skill::flow::mermaid::parse_mermaid_flowchart;
use kagent::skill::flow::{Flow, FlowNodeKind, parse_choice};

#[derive(Debug, PartialEq)]
struct FlowNodeSnapshot {
    kind: FlowNodeKind,
    label: String,
}

#[derive(Debug, PartialEq)]
struct FlowEdgeSnapshot {
    dst: String,
    label: Option<String>,
}

#[derive(Debug, PartialEq)]
struct FlowSnapshot {
    begin_id: String,
    end_id: String,
    nodes: BTreeMap<String, FlowNodeSnapshot>,
    outgoing: BTreeMap<String, Vec<FlowEdgeSnapshot>>,
}

fn node(kind: FlowNodeKind, label: &str) -> FlowNodeSnapshot {
    FlowNodeSnapshot {
        kind,
        label: label.to_string(),
    }
}

fn edge(dst: &str, label: Option<&str>) -> FlowEdgeSnapshot {
    FlowEdgeSnapshot {
        dst: dst.to_string(),
        label: label.map(|value| value.to_string()),
    }
}

fn flow_snapshot(flow: &Flow) -> FlowSnapshot {
    let mut nodes = BTreeMap::new();
    for (id, node_value) in &flow.nodes {
        nodes.insert(
            id.clone(),
            FlowNodeSnapshot {
                kind: node_value.kind.clone(),
                label: node_value.label_as_string(),
            },
        );
    }

    let mut outgoing = BTreeMap::new();
    for node_id in nodes.keys() {
        let mut edges = flow.outgoing.get(node_id).cloned().unwrap_or_default();
        edges.sort_by_key(|edge| (edge.dst.clone(), edge.label.clone().unwrap_or_default()));
        outgoing.insert(
            node_id.clone(),
            edges
                .into_iter()
                .map(|edge| FlowEdgeSnapshot {
                    dst: edge.dst,
                    label: edge.label,
                })
                .collect(),
        );
    }

    FlowSnapshot {
        begin_id: flow.begin_id.clone(),
        end_id: flow.end_id.clone(),
        nodes,
        outgoing,
    }
}

#[test]
fn test_parse_flowchart_basic() {
    let flow = parse_mermaid_flowchart(
        "flowchart TD\nA([BEGIN]) --> B[Search stdrc]\nB --> C{Enough?}\nC -->|yes| D([END])\nC -->|no| B\n",
    )
    .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("A".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("B".to_string(), node(FlowNodeKind::Task, "Search stdrc"));
    nodes.insert("C".to_string(), node(FlowNodeKind::Decision, "Enough?"));
    nodes.insert("D".to_string(), node(FlowNodeKind::End, "END"));

    let mut outgoing = BTreeMap::new();
    outgoing.insert("A".to_string(), vec![edge("B", None)]);
    outgoing.insert("B".to_string(), vec![edge("C", None)]);
    outgoing.insert(
        "C".to_string(),
        vec![edge("B", Some("no")), edge("D", Some("yes"))],
    );
    outgoing.insert("D".to_string(), vec![]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "A".to_string(),
            end_id: "D".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_flowchart_implicit_nodes() {
    let flow = parse_mermaid_flowchart("flowchart TD\nBEGIN --> TASK\nTASK --> END\n")
        .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("BEGIN".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("END".to_string(), node(FlowNodeKind::End, "END"));
    nodes.insert("TASK".to_string(), node(FlowNodeKind::Task, "TASK"));

    let mut outgoing = BTreeMap::new();
    outgoing.insert("BEGIN".to_string(), vec![edge("TASK", None)]);
    outgoing.insert("END".to_string(), vec![]);
    outgoing.insert("TASK".to_string(), vec![edge("END", None)]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "BEGIN".to_string(),
            end_id: "END".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_flowchart_quoted_label() {
    let flow = parse_mermaid_flowchart(
        "flowchart TD\nA([\"BEGIN\"]) --> B[\"hello | world\"]\nB --> C([END])\n",
    )
    .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("A".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("B".to_string(), node(FlowNodeKind::Task, "hello | world"));
    nodes.insert("C".to_string(), node(FlowNodeKind::End, "END"));

    let mut outgoing = BTreeMap::new();
    outgoing.insert("A".to_string(), vec![edge("B", None)]);
    outgoing.insert("B".to_string(), vec![edge("C", None)]);
    outgoing.insert("C".to_string(), vec![]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "A".to_string(),
            end_id: "C".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_flowchart_multi_edges_require_labels() {
    let result = parse_mermaid_flowchart(
        "flowchart TD\nA([BEGIN]) --> B[Pick]\nB --> C([END])\nB --> D([END])\n",
    );
    assert!(result.is_err());
}

#[test]
fn test_parse_d2_flowchart_typical_example() {
    let flow = parse_d2_flowchart(
        "a: \"append a random line to file test.txt\"\na.shape: rectangle\na.foo.bar\nb: \"does test.txt contain more than 3 lines?\" {\n  sub1 -> sub2\n  sub2: {\n    1\n  }\n}\nBEGIN -> a -> b\nb -> a: no\nnot_used\nb -> END: yes\nb -> END: yes2\n",
    )
    .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("BEGIN".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("END".to_string(), node(FlowNodeKind::End, "END"));
    nodes.insert(
        "a".to_string(),
        node(FlowNodeKind::Task, "append a random line to file test.txt"),
    );
    nodes.insert(
        "a.foo.bar".to_string(),
        node(FlowNodeKind::Task, "a.foo.bar"),
    );
    nodes.insert(
        "b".to_string(),
        node(
            FlowNodeKind::Decision,
            "does test.txt contain more than 3 lines?",
        ),
    );
    nodes.insert("not_used".to_string(), node(FlowNodeKind::Task, "not_used"));

    let mut outgoing = BTreeMap::new();
    outgoing.insert("BEGIN".to_string(), vec![edge("a", None)]);
    outgoing.insert("END".to_string(), vec![]);
    outgoing.insert("a".to_string(), vec![edge("b", None)]);
    outgoing.insert("a.foo.bar".to_string(), vec![]);
    outgoing.insert(
        "b".to_string(),
        vec![
            edge("END", Some("yes")),
            edge("END", Some("yes2")),
            edge("a", Some("no")),
        ],
    );
    outgoing.insert("not_used".to_string(), vec![]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "BEGIN".to_string(),
            end_id: "END".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_d2_flowchart_markdown_block_label() {
    let flow = parse_d2_flowchart(
        "BEGIN -> explanation -> END\nexplanation: |md\n  # I can do headers\n  - lists\n  - lists\n\n  And other normal markdown stuff\n|\n",
    )
    .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("BEGIN".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("END".to_string(), node(FlowNodeKind::End, "END"));
    nodes.insert(
        "explanation".to_string(),
        node(
            FlowNodeKind::Task,
            "# I can do headers\n- lists\n- lists\n\nAnd other normal markdown stuff",
        ),
    );

    let mut outgoing = BTreeMap::new();
    outgoing.insert("BEGIN".to_string(), vec![edge("explanation", None)]);
    outgoing.insert("END".to_string(), vec![]);
    outgoing.insert("explanation".to_string(), vec![edge("END", None)]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "BEGIN".to_string(),
            end_id: "END".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_d2_flowchart_markdown_block_escapes_quotes() {
    let flow =
        parse_d2_flowchart("BEGIN -> note -> END\nnote: |md\n  Use \"quotes\" and \\ paths\n|\n")
            .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("BEGIN".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("END".to_string(), node(FlowNodeKind::End, "END"));
    nodes.insert(
        "note".to_string(),
        node(FlowNodeKind::Task, "Use \"quotes\" and \\ paths"),
    );

    let mut outgoing = BTreeMap::new();
    outgoing.insert("BEGIN".to_string(), vec![edge("note", None)]);
    outgoing.insert("END".to_string(), vec![]);
    outgoing.insert("note".to_string(), vec![edge("END", None)]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "BEGIN".to_string(),
            end_id: "END".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_d2_flowchart_markdown_block_with_comment() {
    let flow =
        parse_d2_flowchart("BEGIN -> note -> END\nnote: |md # keep this as markdown\n  A: B\n|\n")
            .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("BEGIN".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("END".to_string(), node(FlowNodeKind::End, "END"));
    nodes.insert("note".to_string(), node(FlowNodeKind::Task, "A: B"));

    let mut outgoing = BTreeMap::new();
    outgoing.insert("BEGIN".to_string(), vec![edge("note", None)]);
    outgoing.insert("END".to_string(), vec![]);
    outgoing.insert("note".to_string(), vec![edge("END", None)]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "BEGIN".to_string(),
            end_id: "END".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_d2_flowchart_markdown_block_dedent() {
    let flow = parse_d2_flowchart(
        "BEGIN -> note -> END\nnote: |md\n    line one\n      line two\n    line three\n|\n",
    )
    .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("BEGIN".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert("END".to_string(), node(FlowNodeKind::End, "END"));
    nodes.insert(
        "note".to_string(),
        node(FlowNodeKind::Task, "line one\n  line two\nline three"),
    );

    let mut outgoing = BTreeMap::new();
    outgoing.insert("BEGIN".to_string(), vec![edge("note", None)]);
    outgoing.insert("END".to_string(), vec![]);
    outgoing.insert("note".to_string(), vec![edge("END", None)]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "BEGIN".to_string(),
            end_id: "END".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_d2_flowchart_markdown_block_unclosed() {
    let result = parse_d2_flowchart("BEGIN -> note -> END\nnote: |md\n  missing terminator\n");
    assert!(result.is_err());
}

#[test]
fn test_parse_flowchart_ignores_style_and_shapes() {
    let flow = parse_mermaid_flowchart(
        "flowchart TB\nclassDef highlight fill:#f9f,stroke:#333,stroke-width:2px;\nA([BEGIN]) --> B[Working tree clean?]\nB -- yes --> C{Prep PR}\nB -- no --> D([END])\nC --> D\nclass B highlight\nstyle C fill:#bbf\n",
    )
    .expect("parse flowchart");

    let mut nodes = BTreeMap::new();
    nodes.insert("A".to_string(), node(FlowNodeKind::Begin, "BEGIN"));
    nodes.insert(
        "B".to_string(),
        node(FlowNodeKind::Decision, "Working tree clean?"),
    );
    nodes.insert("C".to_string(), node(FlowNodeKind::Task, "Prep PR"));
    nodes.insert("D".to_string(), node(FlowNodeKind::End, "END"));

    let mut outgoing = BTreeMap::new();
    outgoing.insert("A".to_string(), vec![edge("B", None)]);
    outgoing.insert(
        "B".to_string(),
        vec![edge("C", Some("yes")), edge("D", Some("no"))],
    );
    outgoing.insert("C".to_string(), vec![edge("D", None)]);
    outgoing.insert("D".to_string(), vec![]);

    assert_eq!(
        flow_snapshot(&flow),
        FlowSnapshot {
            begin_id: "A".to_string(),
            end_id: "D".to_string(),
            nodes,
            outgoing,
        }
    );
}

#[test]
fn test_parse_choice_last_match() {
    assert_eq!(
        parse_choice("Answer <choice>a</choice> <choice>b</choice>"),
        Some("b".to_string())
    );
    assert_eq!(parse_choice("No choice tag"), None);
}
