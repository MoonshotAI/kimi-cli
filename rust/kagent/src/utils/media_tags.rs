use std::fmt::Write;

use kosong::message::{ContentPart, TextPart};

fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
    out
}

fn format_tag(tag: &str, attrs: &[(&str, Option<&str>)]) -> String {
    let mut pairs: Vec<(&str, &str)> = attrs
        .iter()
        .filter_map(|(key, value)| value.map(|value| (*key, value)))
        .filter(|(_, value)| !value.is_empty())
        .collect();
    if pairs.is_empty() {
        return format!("<{tag}>");
    }

    pairs.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut out = String::new();
    out.push('<');
    out.push_str(tag);
    for (key, value) in pairs {
        let escaped = escape_attr(value);
        let _ = write!(out, " {key}=\"{escaped}\"");
    }
    out.push('>');
    out
}

pub fn wrap_media_part(
    part: ContentPart,
    tag: &str,
    attrs: &[(&str, Option<&str>)],
) -> Vec<ContentPart> {
    vec![
        ContentPart::Text(TextPart::new(format_tag(tag, attrs))),
        part,
        ContentPart::Text(TextPart::new(format!("</{tag}>"))),
    ]
}
