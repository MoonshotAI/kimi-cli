use std::collections::{HashMap, HashSet};

use regex::Regex;
use thiserror::Error;

use kosong::message::ContentPart;

pub mod d2;
pub mod mermaid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlowNodeKind {
    Begin,
    End,
    Task,
    Decision,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FlowLabel {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowNode {
    pub id: String,
    pub label: FlowLabel,
    pub kind: FlowNodeKind,
}

impl FlowNode {
    pub fn new(id: impl Into<String>, label: impl Into<FlowLabel>, kind: FlowNodeKind) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            kind,
        }
    }

    pub fn label_as_string(&self) -> String {
        match &self.label {
            FlowLabel::Text(text) => text.clone(),
            FlowLabel::Parts(parts) => content_parts_to_text(parts),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlowEdge {
    pub src: String,
    pub dst: String,
    pub label: Option<String>,
}

impl FlowEdge {
    pub fn new(src: impl Into<String>, dst: impl Into<String>, label: Option<String>) -> Self {
        Self {
            src: src.into(),
            dst: dst.into(),
            label,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Flow {
    pub nodes: HashMap<String, FlowNode>,
    pub outgoing: HashMap<String, Vec<FlowEdge>>,
    pub begin_id: String,
    pub end_id: String,
}

impl Flow {
    pub fn new(
        nodes: HashMap<String, FlowNode>,
        outgoing: HashMap<String, Vec<FlowEdge>>,
        begin_id: impl Into<String>,
        end_id: impl Into<String>,
    ) -> Self {
        Self {
            nodes,
            outgoing,
            begin_id: begin_id.into(),
            end_id: end_id.into(),
        }
    }
}

impl From<String> for FlowLabel {
    fn from(value: String) -> Self {
        FlowLabel::Text(value)
    }
}

impl From<&str> for FlowLabel {
    fn from(value: &str) -> Self {
        FlowLabel::Text(value.to_string())
    }
}

impl From<Vec<ContentPart>> for FlowLabel {
    fn from(value: Vec<ContentPart>) -> Self {
        FlowLabel::Parts(value)
    }
}

fn content_parts_to_text(parts: &[ContentPart]) -> String {
    let mut segments = Vec::new();
    for part in parts {
        if let ContentPart::Text(text) = part {
            segments.push(text.text.clone());
        }
    }
    segments.join(" ")
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct FlowError {
    message: String,
}

impl FlowError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct FlowParseError {
    message: String,
}

impl FlowParseError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct FlowValidationError {
    message: String,
}

impl FlowValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn parse_choice(text: &str) -> Option<String> {
    let re = Regex::new(r"<choice>([^<]*)</choice>").ok()?;
    let mut result = None;
    for capture in re.captures_iter(text) {
        if let Some(m) = capture.get(1) {
            result = Some(m.as_str().trim().to_string());
        }
    }
    result
}

pub fn validate_flow(
    nodes: &HashMap<String, FlowNode>,
    outgoing: &HashMap<String, Vec<FlowEdge>>,
) -> Result<(String, String), FlowValidationError> {
    let begin_ids: Vec<String> = nodes
        .values()
        .filter(|node| node.kind == FlowNodeKind::Begin)
        .map(|node| node.id.clone())
        .collect();
    let end_ids: Vec<String> = nodes
        .values()
        .filter(|node| node.kind == FlowNodeKind::End)
        .map(|node| node.id.clone())
        .collect();

    if begin_ids.len() != 1 {
        return Err(FlowValidationError::new(format!(
            "Expected exactly one BEGIN node, found {}",
            begin_ids.len()
        )));
    }
    if end_ids.len() != 1 {
        return Err(FlowValidationError::new(format!(
            "Expected exactly one END node, found {}",
            end_ids.len()
        )));
    }

    let begin_id = begin_ids[0].clone();
    let end_id = end_ids[0].clone();

    let mut reachable: HashSet<String> = HashSet::new();
    let mut queue = vec![begin_id.clone()];
    while let Some(node_id) = queue.pop() {
        if reachable.contains(&node_id) {
            continue;
        }
        reachable.insert(node_id.clone());
        for edge in outgoing.get(&node_id).unwrap_or(&Vec::new()) {
            if !reachable.contains(&edge.dst) {
                queue.push(edge.dst.clone());
            }
        }
    }

    for node in nodes.values() {
        if !reachable.contains(&node.id) {
            continue;
        }
        let edges = outgoing.get(&node.id).cloned().unwrap_or_default();
        if edges.len() <= 1 {
            continue;
        }
        let mut labels = Vec::new();
        for edge in edges.iter() {
            let label = edge.label.as_ref().map(|s| s.trim()).unwrap_or("");
            if label.is_empty() {
                return Err(FlowValidationError::new(format!(
                    "Node \"{}\" has an unlabeled edge",
                    node.id
                )));
            }
            labels.push(label.to_string());
        }
        let unique: HashSet<String> = labels.iter().cloned().collect();
        if unique.len() != labels.len() {
            return Err(FlowValidationError::new(format!(
                "Node \"{}\" has duplicate edge labels",
                node.id
            )));
        }
    }

    if !reachable.contains(&end_id) {
        return Err(FlowValidationError::new(
            "END node is not reachable from BEGIN",
        ));
    }

    Ok((begin_id, end_id))
}
