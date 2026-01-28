use std::collections::HashMap;

use regex::Regex;

use super::{Flow, FlowEdge, FlowLabel, FlowNode, FlowNodeKind, FlowParseError, validate_flow};

#[derive(Clone, Debug)]
struct NodeDef {
    node: FlowNode,
    explicit: bool,
}

const PROPERTY_SEGMENTS: &[&str] = &[
    "shape",
    "style",
    "label",
    "link",
    "icon",
    "near",
    "width",
    "height",
    "direction",
    "grid-rows",
    "grid-columns",
    "grid-gap",
    "font-size",
    "font-family",
    "font-color",
    "stroke",
    "fill",
    "opacity",
    "padding",
    "border-radius",
    "shadow",
    "sketch",
    "animated",
    "multiple",
    "constraint",
    "tooltip",
];

pub fn parse_d2_flowchart(text: &str) -> Result<Flow, FlowParseError> {
    let text = normalize_markdown_blocks(text)?;
    let mut nodes: HashMap<String, NodeDef> = HashMap::new();
    let mut outgoing: HashMap<String, Vec<FlowEdge>> = HashMap::new();

    for (line_no, statement) in iter_top_level_statements(&text)? {
        if has_unquoted_token(&statement, "->") {
            parse_edge_statement(&statement, line_no, &mut nodes, &mut outgoing)?;
        } else {
            parse_node_statement(&statement, line_no, &mut nodes)?;
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

fn normalize_markdown_blocks(text: &str) -> Result<String, FlowParseError> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let block_tag_re = Regex::new(r"^\|md$").unwrap();

    let mut out_lines = Vec::new();
    let mut i = 0usize;
    let mut line_no = 1usize;

    while i < lines.len() {
        let line = lines[i];
        let (prefix, suffix) = split_unquoted_once(line, ':');
        if suffix.is_none() {
            out_lines.push(line.to_string());
            i += 1;
            line_no += 1;
            continue;
        }

        let suffix = suffix.unwrap();
        let suffix_clean = strip_unquoted_comment(&suffix).trim().to_string();
        if !block_tag_re.is_match(&suffix_clean) {
            out_lines.push(line.to_string());
            i += 1;
            line_no += 1;
            continue;
        }

        let start_line = line_no;
        let mut block_lines = Vec::new();
        i += 1;
        line_no += 1;
        while i < lines.len() {
            let block_line = lines[i];
            if block_line.trim() == "|" {
                break;
            }
            block_lines.push(block_line.to_string());
            i += 1;
            line_no += 1;
        }
        if i >= lines.len() {
            return Err(FlowParseError::new(line_error(
                start_line,
                "Unclosed markdown block",
            )));
        }

        let dedented = dedent_block(&block_lines);
        if !dedented.is_empty() {
            let escaped: Vec<String> = dedented
                .iter()
                .map(|line| escape_quoted_line(line))
                .collect();
            out_lines.push(format!("{}: \"{}", prefix, escaped[0]));
            for line in escaped.iter().skip(1) {
                out_lines.push(line.clone());
            }
            if let Some(last) = out_lines.last_mut() {
                *last = format!("{}\"", last);
            }
            out_lines.push(String::new());
            out_lines.push(String::new());
        } else {
            out_lines.push(format!("{}: \"\"", prefix));
            out_lines.push(String::new());
        }

        i += 1;
        line_no += 1;
    }

    Ok(out_lines.join("\n"))
}

fn strip_unquoted_comment(text: &str) -> String {
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    for (idx, ch) in text.chars().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if ch == '\\' && (in_single || in_double) {
            escape = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch == '#' && !in_single && !in_double {
            return text[..idx].to_string();
        }
    }
    text.to_string()
}

fn dedent_block(lines: &[String]) -> Vec<String> {
    let mut indent: Option<usize> = None;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let stripped = line.trim_start_matches([' ', '\t']);
        let lead = line.len() - stripped.len();
        indent = Some(indent.map(|val| val.min(lead)).unwrap_or(lead));
    }
    let Some(indent) = indent else {
        return vec![String::new(); lines.len()];
    };
    lines
        .iter()
        .map(|line| {
            if line.len() >= indent {
                line[indent..].to_string()
            } else {
                String::new()
            }
        })
        .collect()
}

fn escape_quoted_line(line: &str) -> String {
    line.replace('\\', "\\\\").replace('\"', "\\\"")
}

fn iter_top_level_statements(text: &str) -> Result<Vec<(usize, String)>, FlowParseError> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut statements = Vec::new();
    let mut brace_depth = 0i64;
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    let mut drop_line = false;
    let mut buf = String::new();
    let mut line_no = 1usize;
    let mut stmt_line = 1usize;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        let next_ch = if i + 1 < chars.len() {
            chars[i + 1]
        } else {
            '\0'
        };

        if ch == '\\' && next_ch == '\n' {
            i += 2;
            line_no += 1;
            continue;
        }

        if ch == '\n' {
            if (in_single || in_double) && brace_depth == 0 && !drop_line {
                buf.push('\n');
                line_no += 1;
                i += 1;
                continue;
            }
            if brace_depth == 0 && !in_single && !in_double && !drop_line {
                let statement = buf.trim().to_string();
                if !statement.is_empty() {
                    statements.push((stmt_line, statement));
                }
            }
            buf.clear();
            drop_line = false;
            stmt_line = line_no + 1;
            line_no += 1;
            i += 1;
            continue;
        }

        if !in_single && !in_double {
            if ch == '#' {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if ch == '{' {
                if brace_depth == 0 {
                    let statement = buf.trim().to_string();
                    if !statement.is_empty() {
                        statements.push((stmt_line, statement));
                    }
                    drop_line = true;
                    buf.clear();
                }
                brace_depth += 1;
                i += 1;
                continue;
            }
            if ch == '}' && brace_depth > 0 {
                brace_depth -= 1;
                i += 1;
                continue;
            }
            if ch == '}' && brace_depth == 0 {
                return Err(FlowParseError::new(line_error(line_no, "Unmatched '}'")));
            }
        }

        if ch == '\'' && !in_double && !escape {
            in_single = !in_single;
        } else if ch == '"' && !in_single && !escape {
            in_double = !in_double;
        }

        if escape {
            escape = false;
        } else if ch == '\\' && (in_single || in_double) {
            escape = true;
        }

        if brace_depth == 0 && !drop_line {
            buf.push(ch);
        }

        i += 1;
    }

    if brace_depth != 0 {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Unclosed '{' block",
        )));
    }
    if in_single || in_double {
        return Err(FlowParseError::new(line_error(line_no, "Unclosed string")));
    }

    let statement = buf.trim().to_string();
    if !statement.is_empty() {
        statements.push((stmt_line, statement));
    }
    Ok(statements)
}

fn has_unquoted_token(text: &str, token: &str) -> bool {
    split_on_token(text, token).len() > 1
}

fn parse_edge_statement(
    statement: &str,
    line_no: usize,
    nodes: &mut HashMap<String, NodeDef>,
    outgoing: &mut HashMap<String, Vec<FlowEdge>>,
) -> Result<(), FlowParseError> {
    let mut parts = split_on_token(statement, "->");
    if parts.len() < 2 {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Expected edge arrow",
        )));
    }

    let last = parts.pop().unwrap();
    let (target_text, edge_label) = split_unquoted_once(&last, ':');
    parts.push(target_text);

    let mut node_ids = Vec::new();
    for (idx, part) in parts.iter().enumerate() {
        let node_id = parse_node_id(part, line_no, idx < parts.len() - 1)?;
        node_ids.push(node_id);
    }

    if node_ids.iter().any(|id| is_property_path(id)) {
        return Ok(());
    }
    if node_ids.len() < 2 {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Edge must have at least two nodes",
        )));
    }

    let label = if let Some(label) = edge_label {
        Some(parse_label(&label, line_no)?)
    } else {
        None
    };

    for idx in 0..node_ids.len() - 1 {
        let edge = FlowEdge {
            src: node_ids[idx].clone(),
            dst: node_ids[idx + 1].clone(),
            label: if idx == node_ids.len() - 2 {
                label.clone()
            } else {
                None
            },
        };
        outgoing
            .entry(edge.src.clone())
            .or_default()
            .push(edge.clone());
        outgoing.entry(edge.dst.clone()).or_default();
    }

    for node_id in node_ids {
        add_node(nodes, &node_id, None, false, line_no)?;
    }
    Ok(())
}

fn parse_node_statement(
    statement: &str,
    line_no: usize,
    nodes: &mut HashMap<String, NodeDef>,
) -> Result<(), FlowParseError> {
    let (node_text, label_text) = split_unquoted_once(statement, ':');
    if let Some(label) = &label_text {
        if is_property_path(&node_text) {
            return Ok(());
        }
        if label.trim().is_empty() {
            return Ok(());
        }
        let node_id = parse_node_id(&node_text, line_no, false)?;
        let label = parse_label(label, line_no)?;
        add_node(nodes, &node_id, Some(label), true, line_no)?;
        return Ok(());
    }

    let node_id = parse_node_id(&node_text, line_no, false)?;
    add_node(nodes, &node_id, None, false, line_no)?;
    Ok(())
}

fn parse_node_id(
    text: &str,
    line_no: usize,
    allow_inline_label: bool,
) -> Result<String, FlowParseError> {
    let mut cleaned = text.trim().to_string();
    if allow_inline_label && cleaned.contains(':') {
        cleaned = split_unquoted_once(&cleaned, ':').0;
    }
    if cleaned.is_empty() {
        return Err(FlowParseError::new(line_error(line_no, "Expected node id")));
    }
    let re = Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*$").unwrap();
    if !re.is_match(&cleaned) {
        return Err(FlowParseError::new(line_error(
            line_no,
            &format!("Invalid node id \"{}\"", cleaned),
        )));
    }
    Ok(cleaned)
}

fn is_property_path(node_id: &str) -> bool {
    if !node_id.contains('.') {
        return false;
    }
    let parts: Vec<&str> = node_id.split('.').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return false;
    }
    for part in parts.iter().skip(1) {
        if PROPERTY_SEGMENTS.contains(part) || part.starts_with("style") {
            return true;
        }
    }
    PROPERTY_SEGMENTS.contains(parts.last().unwrap())
}

fn parse_label(text: &str, line_no: usize) -> Result<String, FlowParseError> {
    let label = text.trim().to_string();
    if label.is_empty() {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Label cannot be empty",
        )));
    }
    let first = label.chars().next().unwrap();
    if first == '\'' || first == '"' {
        return parse_quoted_label(&label, line_no);
    }
    Ok(label)
}

fn parse_quoted_label(text: &str, line_no: usize) -> Result<String, FlowParseError> {
    let quote = text.chars().next().unwrap();
    let mut buf = String::new();
    let mut escape = false;
    let mut chars = text.char_indices().peekable();
    chars.next();
    while let Some((idx, ch)) = chars.next() {
        if escape {
            buf.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' {
            escape = true;
            continue;
        }
        if ch == quote {
            let trailing = text[idx + ch.len_utf8()..].trim();
            if !trailing.is_empty() {
                return Err(FlowParseError::new(line_error(
                    line_no,
                    "Unexpected trailing content",
                )));
            }
            return Ok(buf);
        }
        buf.push(ch);
    }
    Err(FlowParseError::new(line_error(
        line_no,
        "Unclosed quoted label",
    )))
}

fn split_on_token(text: &str, token: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut buf = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    let bytes = text.as_bytes();
    let token_bytes = token.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if !in_single && !in_double && bytes[i..].starts_with(token_bytes) {
            parts.push(buf.trim().to_string());
            buf.clear();
            i += token_bytes.len();
            continue;
        }
        let ch = bytes[i] as char;
        if escape {
            escape = false;
        } else if ch == '\\' && (in_single || in_double) {
            escape = true;
        } else if ch == '\'' && !in_double {
            in_single = !in_single;
        } else if ch == '"' && !in_single {
            in_double = !in_double;
        }
        buf.push(ch);
        i += 1;
    }

    if in_single || in_double {
        return vec![];
    }
    parts.push(buf.trim().to_string());
    parts
}

fn split_unquoted_once(text: &str, token: char) -> (String, Option<String>) {
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    for (idx, ch) in text.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if ch == '\\' && (in_single || in_double) {
            escape = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch == token && !in_single && !in_double {
            let left = text[..idx].trim().to_string();
            let right = text[idx + ch.len_utf8()..].trim().to_string();
            return (left, Some(right));
        }
    }
    (text.trim().to_string(), None)
}

fn add_node(
    nodes: &mut HashMap<String, NodeDef>,
    node_id: &str,
    label: Option<String>,
    explicit: bool,
    line_no: usize,
) -> Result<FlowNode, FlowParseError> {
    let label = label.unwrap_or_else(|| node_id.to_string());
    if label.is_empty() {
        return Err(FlowParseError::new(line_error(
            line_no,
            "Node label cannot be empty",
        )));
    }
    let label_norm = label.trim().to_lowercase();
    let mut kind = FlowNodeKind::Task;
    if label_norm == "begin" {
        kind = FlowNodeKind::Begin;
    } else if label_norm == "end" {
        kind = FlowNodeKind::End;
    }

    let node = FlowNode {
        id: node_id.to_string(),
        label: FlowLabel::Text(label),
        kind,
    };
    if let Some(existing) = nodes.get(node_id) {
        if existing.node == node {
            return Ok(existing.node.clone());
        }
        if !explicit && existing.explicit {
            return Ok(existing.node.clone());
        }
        if explicit && !existing.explicit {
            nodes.insert(
                node_id.to_string(),
                NodeDef {
                    node: node.clone(),
                    explicit: true,
                },
            );
            return Ok(node);
        }
        return Err(FlowParseError::new(line_error(
            line_no,
            &format!("Conflicting definition for node \"{}\"", node_id),
        )));
    }
    nodes.insert(
        node_id.to_string(),
        NodeDef {
            node: node.clone(),
            explicit,
        },
    );
    Ok(node)
}

fn infer_decision_nodes(
    nodes: &HashMap<String, FlowNode>,
    outgoing: &HashMap<String, Vec<FlowEdge>>,
) -> HashMap<String, FlowNode> {
    let mut updated = HashMap::new();
    for (node_id, node) in nodes {
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

fn line_error(line_no: usize, message: &str) -> String {
    format!("Line {}: {}", line_no, message)
}
