use std::collections::HashMap;

use regex::Regex;

use super::{Flow, FlowEdge, FlowLabel, FlowNode, FlowNodeKind, FlowParseError, validate_flow};

#[derive(Clone, Debug)]
struct NodeSpec {
    node_id: String,
    label: Option<String>,
}

#[derive(Clone, Debug)]
struct NodeDef {
    node: FlowNode,
    explicit: bool,
}

pub fn parse_mermaid_flowchart(text: &str) -> Result<Flow, FlowParseError> {
    let mut nodes: HashMap<String, NodeDef> = HashMap::new();
    let mut outgoing: HashMap<String, Vec<FlowEdge>> = HashMap::new();

    let header_re = Regex::new(r"^(flowchart|graph)\b").unwrap();

    for (line_no, raw_line) in text.lines().enumerate() {
        let mut line = strip_comment(raw_line).trim().to_string();
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        if header_re.is_match(&line) {
            continue;
        }
        if is_style_line(&line) {
            continue;
        }
        line = strip_style_tokens(&line);

        if let Some((src_spec, label, dst_spec)) = try_parse_edge_line(&line, line_no + 1) {
            let src_node = add_node(&mut nodes, &src_spec, line_no + 1)?;
            let dst_node = add_node(&mut nodes, &dst_spec, line_no + 1)?;
            let edge = FlowEdge {
                src: src_node.id.clone(),
                dst: dst_node.id.clone(),
                label,
            };
            outgoing
                .entry(edge.src.clone())
                .or_default()
                .push(edge.clone());
            outgoing.entry(edge.dst.clone()).or_default();
            continue;
        }

        if let Some(node_spec) = try_parse_node_line(&line, line_no + 1) {
            add_node(&mut nodes, &node_spec, line_no + 1)?;
        }
    }

    let mut flow_nodes: HashMap<String, FlowNode> = nodes
        .iter()
        .map(|(k, v)| (k.clone(), v.node.clone()))
        .collect();
    for node_id in flow_nodes.keys() {
        outgoing.entry(node_id.clone()).or_default();
    }

    flow_nodes = infer_decision_nodes(&flow_nodes, &outgoing);
    let (begin_id, end_id) = validate_flow(&flow_nodes, &outgoing)
        .map_err(|err| FlowParseError::new(err.to_string()))?;
    Ok(Flow {
        nodes: flow_nodes,
        outgoing,
        begin_id,
        end_id,
    })
}

fn try_parse_edge_line(line: &str, line_no: usize) -> Option<(NodeSpec, Option<String>, NodeSpec)> {
    let (src_spec, idx) = parse_node_token(line, 0, line_no).ok()?;
    let (normalized, label) = normalize_edge_line(line);
    let idx = skip_ws(&normalized, idx);
    if !normalized[idx..].contains('>') && !normalized[idx..].contains("---") {
        return None;
    }
    let mut normalized = normalized;
    if normalized[idx..].contains("---") {
        normalized = normalized[..idx].to_string() + &normalized[idx..].replacen("---", "-->", 1);
    }
    let arrow_re = Regex::new(r"[-.=]+>").unwrap();
    let normalized = arrow_re.replace_all(&normalized, "-->").to_string();
    let arrow_idx = normalized.rfind('>')?;
    let dst_start = skip_ws(&normalized, arrow_idx + 1);
    let (dst_spec, _) = parse_node_token(&normalized, dst_start, line_no).ok()?;
    Some((src_spec, label, dst_spec))
}

fn parse_node_token(
    line: &str,
    idx: usize,
    line_no: usize,
) -> Result<(NodeSpec, usize), FlowParseError> {
    let node_id_re = Regex::new(r"[A-Za-z0-9_][A-Za-z0-9_-]*").unwrap();
    let Some(mat) = node_id_re.find_at(line, idx) else {
        return Err(FlowParseError::new(line_error(line_no, "Expected node id")));
    };
    if mat.start() != idx {
        return Err(FlowParseError::new(line_error(line_no, "Expected node id")));
    }
    let node_id = mat.as_str().to_string();
    let mut idx = mat.end();

    let shapes = [('[', ']'), ('(', ')'), ('{', '}')];
    let close = if idx < line.len() {
        let ch = line.as_bytes()[idx] as char;
        shapes.iter().find(|(open, _)| *open == ch)
    } else {
        None
    };
    if close.is_none() {
        return Ok((
            NodeSpec {
                node_id,
                label: None,
            },
            idx,
        ));
    }
    let close_char = close.unwrap().1;
    idx += 1;
    let (label, idx) = parse_label(line, idx, close_char, line_no)?;
    Ok((
        NodeSpec {
            node_id,
            label: Some(label),
        },
        idx,
    ))
}

fn parse_label(
    line: &str,
    idx: usize,
    close_char: char,
    line_no: usize,
) -> Result<(String, usize), FlowParseError> {
    if idx >= line.len() {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Expected node label",
        )));
    }
    let bytes = line.as_bytes();
    if close_char == ')' && bytes[idx] == b'[' {
        let (label, mut idx) = parse_label(line, idx + 1, ']', line_no)?;
        while idx < line.len() && line.as_bytes()[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= line.len() || line.as_bytes()[idx] != b')' {
            return Err(FlowParseError::new(line_error(
                line_no,
                "Unclosed node label",
            )));
        }
        return Ok((label, idx + 1));
    }

    if bytes[idx] == b'"' {
        let mut idx = idx + 1;
        let mut buf = String::new();
        while idx < line.len() {
            let ch = line.as_bytes()[idx];
            if ch == b'"' {
                idx += 1;
                while idx < line.len() && line.as_bytes()[idx].is_ascii_whitespace() {
                    idx += 1;
                }
                if idx >= line.len() || line.as_bytes()[idx] != close_char as u8 {
                    return Err(FlowParseError::new(line_error(
                        line_no,
                        "Unclosed node label",
                    )));
                }
                return Ok((buf, idx + 1));
            }
            if ch == b'\\' && idx + 1 < line.len() {
                buf.push(line.as_bytes()[idx + 1] as char);
                idx += 2;
                continue;
            }
            buf.push(ch as char);
            idx += 1;
        }
        return Err(FlowParseError::new(line_error(
            line_no,
            "Unclosed quoted label",
        )));
    }

    let end = line[idx..]
        .find(close_char)
        .ok_or_else(|| FlowParseError::new(line_error(line_no, "Unclosed node label")))?;
    let label = line[idx..idx + end].trim().to_string();
    if label.is_empty() {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Node label cannot be empty",
        )));
    }
    Ok((label, idx + end + 1))
}

fn skip_ws(line: &str, mut idx: usize) -> usize {
    let bytes = line.as_bytes();
    while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
        idx += 1;
    }
    idx
}

fn add_node(
    nodes: &mut HashMap<String, NodeDef>,
    spec: &NodeSpec,
    line_no: usize,
) -> Result<FlowNode, FlowParseError> {
    let label = spec.label.clone().unwrap_or_else(|| spec.node_id.clone());
    let label_norm = label.trim().to_lowercase();
    if label.is_empty() {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Node label cannot be empty",
        )));
    }

    let mut kind = FlowNodeKind::Task;
    if label_norm == "begin" {
        kind = FlowNodeKind::Begin;
    } else if label_norm == "end" {
        kind = FlowNodeKind::End;
    }

    let node = FlowNode {
        id: spec.node_id.clone(),
        label: FlowLabel::Text(label),
        kind,
    };
    let explicit = spec.label.is_some();

    if let Some(existing) = nodes.get(&spec.node_id) {
        if existing.node == node {
            return Ok(existing.node.clone());
        }
        if !explicit && existing.explicit {
            return Ok(existing.node.clone());
        }
        if explicit && !existing.explicit {
            nodes.insert(
                spec.node_id.clone(),
                NodeDef {
                    node: node.clone(),
                    explicit: true,
                },
            );
            return Ok(node);
        }
        return Err(FlowParseError::new(line_error(
            line_no,
            &format!("Conflicting definition for node \"{}\"", spec.node_id),
        )));
    }

    nodes.insert(
        spec.node_id.clone(),
        NodeDef {
            node: node.clone(),
            explicit,
        },
    );
    Ok(node)
}

fn line_error(line_no: usize, message: &str) -> String {
    format!("Line {}: {}", line_no, message)
}

fn strip_comment(line: &str) -> String {
    if let Some(idx) = line.find("%%") {
        line[..idx].to_string()
    } else {
        line.to_string()
    }
}

fn is_style_line(line: &str) -> bool {
    let lowered = line.to_lowercase();
    if lowered == "end" {
        return true;
    }
    matches!(
        lowered.as_str(),
        _ if lowered.starts_with("classdef ")
            || lowered.starts_with("class ")
            || lowered.starts_with("style ")
            || lowered.starts_with("linkstyle ")
            || lowered.starts_with("click ")
            || lowered.starts_with("subgraph ")
            || lowered.starts_with("direction ")
    )
}

fn strip_style_tokens(line: &str) -> String {
    let re = Regex::new(r":::[A-Za-z0-9_-]+").unwrap();
    re.replace_all(line, "").to_string()
}

fn try_parse_node_line(line: &str, line_no: usize) -> Option<NodeSpec> {
    parse_node_token(line, 0, line_no)
        .ok()
        .map(|(spec, _)| spec)
}

fn normalize_edge_line(line: &str) -> (String, Option<String>) {
    let pipe_re = Regex::new(r"\|([^|]*)\|").unwrap();
    let edge_re = Regex::new(r"--\s*([^>-][^>]*)\s*-->").unwrap();
    let mut label = None;
    let mut normalized = line.to_string();

    if let Some(mat) = pipe_re.find(&normalized) {
        let caps = pipe_re.captures(&normalized).unwrap();
        label = caps.get(1).map(|m| m.as_str().trim().to_string());
        normalized.replace_range(mat.range(), "");
    }

    if label.is_none() {
        if let Some(caps) = edge_re.captures(&normalized) {
            label = caps.get(1).map(|m| m.as_str().trim().to_string());
            normalized = edge_re.replace(&normalized, "-->").to_string();
        }
    }
    if let Some(ref l) = label {
        if l.is_empty() {
            label = None;
        }
    }
    (normalized, label)
}

fn infer_decision_nodes(
    nodes: &HashMap<String, FlowNode>,
    outgoing: &HashMap<String, Vec<FlowEdge>>,
) -> HashMap<String, FlowNode> {
    let mut updated = HashMap::new();
    for (node_id, node) in nodes.iter() {
        let mut kind = node.kind.clone();
        if kind == FlowNodeKind::Task && outgoing.get(node_id).map(|v| v.len()).unwrap_or(0) > 1 {
            kind = FlowNodeKind::Decision;
        }
        if kind != node.kind {
            updated.insert(
                node_id.clone(),
                FlowNode {
                    id: node.id.clone(),
                    label: node.label.clone(),
                    kind,
                },
            );
        } else {
            updated.insert(node_id.clone(), node.clone());
        }
    }
    updated
}
