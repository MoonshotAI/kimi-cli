use similar::TextDiff;

use kosong::tooling::DiffDisplayBlock;

const N_CONTEXT_LINES: usize = 3;

pub fn build_diff_blocks(path: &str, old_text: &str, new_text: &str) -> Vec<DiffDisplayBlock> {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();

    let diff = TextDiff::from_slices(&old_lines, &new_lines);
    let mut blocks = Vec::new();

    for group in diff.grouped_ops(N_CONTEXT_LINES) {
        if group.is_empty() {
            continue;
        }
        let old_start = group.first().map(|op| op.old_range().start).unwrap_or(0);
        let old_end = group
            .last()
            .map(|op| op.old_range().end)
            .unwrap_or(old_start);
        let new_start = group.first().map(|op| op.new_range().start).unwrap_or(0);
        let new_end = group
            .last()
            .map(|op| op.new_range().end)
            .unwrap_or(new_start);

        let old_chunk = old_lines.get(old_start..old_end).unwrap_or(&[]).join("\n");
        let new_chunk = new_lines.get(new_start..new_end).unwrap_or(&[]).join("\n");

        blocks.push(DiffDisplayBlock::new(path, old_chunk, new_chunk));
    }

    blocks
}

pub fn format_unified_diff(
    old_text: &str,
    new_text: &str,
    path: Option<&str>,
    include_file_header: bool,
) -> String {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();
    let diff = TextDiff::from_slices(&old_lines, &new_lines);

    let path = path.unwrap_or("");
    let fromfile = if path.is_empty() {
        "a/file".to_string()
    } else {
        format!("a/{path}")
    };
    let tofile = if path.is_empty() {
        "b/file".to_string()
    } else {
        format!("b/{path}")
    };

    let mut unified = diff.unified_diff().header(&fromfile, &tofile).to_string();
    if !include_file_header {
        let lines: Vec<&str> = unified.split_inclusive('\n').collect();
        if lines.len() >= 2 && lines[0].starts_with("--- ") && lines[1].starts_with("+++ ") {
            unified = lines[2..].concat();
        }
    }
    unified
}
