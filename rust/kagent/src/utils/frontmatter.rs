use std::collections::HashMap;
use std::path::Path;

use serde_yaml::Value;

pub fn parse_frontmatter(text: &str) -> Result<Option<HashMap<String, Value>>, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return Ok(None);
    }

    let mut frontmatter_lines = Vec::new();
    let mut found_end = false;
    for line in lines.iter().skip(1) {
        if line.trim() == "---" {
            found_end = true;
            break;
        }
        frontmatter_lines.push(*line);
    }
    if !found_end {
        return Ok(None);
    }

    let frontmatter = frontmatter_lines.join("\n").trim().to_string();
    if frontmatter.is_empty() {
        return Ok(None);
    }

    let raw: Value =
        serde_yaml::from_str(&frontmatter).map_err(|_| "Invalid frontmatter YAML.".to_string())?;
    let mapping = match raw {
        Value::Mapping(mapping) => mapping,
        _ => return Err("Frontmatter YAML must be a mapping.".to_string()),
    };

    let mut out = HashMap::new();
    for (key, value) in mapping {
        if let Value::String(key) = key {
            out.insert(key, value);
        }
    }
    Ok(Some(out))
}

pub async fn read_frontmatter(path: &Path) -> Result<Option<HashMap<String, Value>>, String> {
    let bytes = tokio::fs::read(path).await.map_err(|err| err.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    parse_frontmatter(&text)
}
