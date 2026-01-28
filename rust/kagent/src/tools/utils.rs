use std::collections::BTreeMap;

use regex::Regex;

use kosong::tooling::{BriefDisplayBlock, DisplayBlock, ToolOutput, ToolReturnValue};
use kosong::utils::typing::JsonValue;

pub fn load_desc(template: &str, substitutions: &[(&str, String)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in substitutions {
        let token = format!("${{{key}}}");
        rendered = rendered.replace(&token, value);
    }
    rendered
}

pub const DEFAULT_MAX_CHARS: usize = 50_000;
pub const DEFAULT_MAX_LINE_LENGTH: usize = 2_000;

pub fn truncate_line(line: &str, max_length: usize, marker: &str) -> String {
    if line.len() <= max_length {
        return line.to_string();
    }
    let re = Regex::new(r"[\r\n]+$").unwrap();
    let linebreak = re.find(line).map(|m| m.as_str()).unwrap_or("");
    let end = format!("{}{}", marker, linebreak);
    let max_length = max_length.max(end.len());
    format!("{}{}", &line[..max_length - end.len()], end)
}

fn split_lines_keepends(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut iter = text.char_indices().peekable();
    while let Some((idx, ch)) = iter.next() {
        if is_line_break(ch) {
            let mut end = idx + ch.len_utf8();
            if ch == '\r' {
                if let Some(&(next_idx, next_ch)) = iter.peek() {
                    if next_ch == '\n' {
                        iter.next();
                        end = next_idx + next_ch.len_utf8();
                    }
                }
            }
            lines.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

fn is_line_break(ch: char) -> bool {
    matches!(
        ch,
        '\n' | '\r'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{001C}'
            | '\u{001D}'
            | '\u{001E}'
            | '\u{0085}'
            | '\u{2028}'
            | '\u{2029}'
    )
}

pub struct ToolResultBuilder {
    pub max_chars: usize,
    pub max_line_length: Option<usize>,
    marker: String,
    buffer: Vec<String>,
    n_chars: usize,
    n_lines: usize,
    truncation: bool,
    display: Vec<DisplayBlock>,
    extras: Option<BTreeMap<String, JsonValue>>,
}

impl ToolResultBuilder {
    pub fn new(max_chars: usize, max_line_length: Option<usize>) -> Self {
        let marker = "[...truncated]".to_string();
        if let Some(limit) = max_line_length {
            assert!(limit > marker.len());
        }
        Self {
            max_chars,
            max_line_length,
            marker,
            buffer: Vec::new(),
            n_chars: 0,
            n_lines: 0,
            truncation: false,
            display: Vec::new(),
            extras: None,
        }
    }

    pub fn is_full(&self) -> bool {
        self.n_chars >= self.max_chars
    }

    pub fn n_chars(&self) -> usize {
        self.n_chars
    }

    pub fn n_lines(&self) -> usize {
        self.n_lines
    }

    pub fn write(&mut self, text: &str) -> usize {
        if self.is_full() {
            return 0;
        }

        let lines = split_lines_keepends(text);
        if lines.is_empty() {
            return 0;
        }

        let mut written = 0usize;
        for line in lines {
            if self.is_full() {
                break;
            }
            let remaining = self.max_chars - self.n_chars;
            let limit = match self.max_line_length {
                Some(max_line) => remaining.min(max_line),
                None => remaining,
            };
            let truncated = truncate_line(line, limit, &self.marker);
            if truncated.len() != line.len() {
                self.truncation = true;
            }
            self.buffer.push(truncated.clone());
            written += truncated.len();
            self.n_chars += truncated.len();
            if truncated.ends_with('\n') {
                self.n_lines += 1;
            }
        }
        written
    }

    pub fn display(&mut self, blocks: impl IntoIterator<Item = DisplayBlock>) {
        self.display.extend(blocks);
    }

    pub fn extras(&mut self, extras: BTreeMap<String, JsonValue>) {
        if let Some(existing) = &mut self.extras {
            existing.extend(extras);
        } else {
            self.extras = Some(extras);
        }
    }

    pub fn ok(&self, message: &str, brief: &str) -> ToolReturnValue {
        let output = ToolOutput::Text(self.buffer.join(""));
        let mut final_message = message.to_string();
        if !final_message.is_empty() && !final_message.ends_with('.') {
            final_message.push('.');
        }
        if self.truncation {
            let truncation_msg = "Output is truncated to fit in the message.";
            if final_message.is_empty() {
                final_message = truncation_msg.to_string();
            } else {
                final_message = format!("{final_message} {truncation_msg}");
            }
        }
        let mut display = Vec::new();
        if !brief.is_empty() {
            display.push(DisplayBlock::Brief(BriefDisplayBlock::new(brief)));
        }
        display.extend(self.display.clone());
        ToolReturnValue {
            is_error: false,
            output,
            message: final_message,
            display,
            extras: self.extras.clone(),
        }
    }

    pub fn error(&self, message: &str, brief: &str) -> ToolReturnValue {
        let output = ToolOutput::Text(self.buffer.join(""));
        let mut final_message = message.to_string();
        if self.truncation {
            let truncation_msg = "Output is truncated to fit in the message.";
            if final_message.is_empty() {
                final_message = truncation_msg.to_string();
            } else {
                final_message = format!("{final_message} {truncation_msg}");
            }
        }
        let mut display = Vec::new();
        if !brief.is_empty() {
            display.push(DisplayBlock::Brief(BriefDisplayBlock::new(brief)));
        }
        display.extend(self.display.clone());
        ToolReturnValue {
            is_error: true,
            output,
            message: final_message,
            display,
            extras: self.extras.clone(),
        }
    }
}

impl Default for ToolResultBuilder {
    fn default() -> Self {
        ToolResultBuilder::new(DEFAULT_MAX_CHARS, Some(DEFAULT_MAX_LINE_LENGTH))
    }
}

pub fn tool_rejected_error() -> ToolReturnValue {
    ToolReturnValue {
        is_error: true,
        output: ToolOutput::Text(String::new()),
        message: "The tool call is rejected by the user. Please follow the new instructions from the user.".to_string(),
        display: vec![DisplayBlock::Brief(BriefDisplayBlock::new("Rejected by user"))],
        extras: None,
    }
}

pub fn is_tool_rejected(return_value: &ToolReturnValue) -> bool {
    return_value.is_error && return_value.brief() == "Rejected by user"
}
