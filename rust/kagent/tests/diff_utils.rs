use kagent::utils::{build_diff_blocks, format_unified_diff};
use kosong::tooling::DiffDisplayBlock;

#[test]
fn test_build_diff_blocks_simple_change() {
    let old_text = "Line one\nLine two\nLine three\nLine four\nLine five";
    let new_text =
        "Line one 123\nLine two\nLine three\nLine four\nLine five modified\nLine six added";

    let blocks = build_diff_blocks("/tmp/simple.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new("/tmp/simple.txt", old_text, new_text)]
    );
}

#[test]
fn test_build_diff_blocks_insert_only() {
    let old_text = "Line one\nLine two";
    let new_text = "Line one\nLine two\nLine three\nLine four";

    let blocks = build_diff_blocks("/tmp/insert.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new("/tmp/insert.txt", old_text, new_text)]
    );
}

#[test]
fn test_build_diff_blocks_delete_only() {
    let old_text = "Line one\nLine two\nLine three\nLine four";
    let new_text = "Line one\nLine four";

    let blocks = build_diff_blocks("/tmp/delete.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new("/tmp/delete.txt", old_text, new_text)]
    );
}

#[test]
fn test_build_diff_blocks_multiline_replace() {
    let old_text = "Alpha\nBravo\nCharlie\nDelta\nEcho";
    let new_text = "Alpha\nXray\nYankee\nDelta\nEcho";

    let blocks = build_diff_blocks("/tmp/replace.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new(
            "/tmp/replace.txt",
            old_text,
            new_text
        )]
    );
}

#[test]
fn test_build_diff_blocks_complex_change() {
    let old_text = "Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight\nLine nine\nLine ten";
    let new_text = "Line one\nLine two updated\nLine three\nLine five\nLine six\nLine seven\nLine eight inserted A\nLine eight inserted B\nLine eight\nLine nine updated\nLine ten\nLine eleven";

    let blocks = build_diff_blocks("/tmp/complex.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new(
            "/tmp/complex.txt",
            old_text,
            new_text
        )]
    );
}

#[test]
fn test_build_diff_blocks_split_by_context_window() {
    let old_text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16";
    let new_text = "Line 1\nLine 2 updated\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14 updated\nLine 15\nLine 16";

    let blocks = build_diff_blocks("/tmp/context.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![
            DiffDisplayBlock::new(
                "/tmp/context.txt",
                "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
                "Line 1\nLine 2 updated\nLine 3\nLine 4\nLine 5"
            ),
            DiffDisplayBlock::new(
                "/tmp/context.txt",
                "Line 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16",
                "Line 11\nLine 12\nLine 13\nLine 14 updated\nLine 15\nLine 16"
            ),
        ]
    );
}

#[test]
fn test_build_diff_blocks_old_empty() {
    let old_text = "";
    let new_text = "Line 1\nLine 2";

    let blocks = build_diff_blocks("/tmp/old-empty.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new("/tmp/old-empty.txt", "", new_text)]
    );
}

#[test]
fn test_build_diff_blocks_new_empty() {
    let old_text = "Line 1\nLine 2";
    let new_text = "";

    let blocks = build_diff_blocks("/tmp/new-empty.txt", old_text, new_text);

    assert_eq!(
        blocks,
        vec![DiffDisplayBlock::new("/tmp/new-empty.txt", old_text, "")]
    );
}

#[test]
fn test_build_diff_blocks_both_empty() {
    let blocks = build_diff_blocks("/tmp/both-empty.txt", "", "");
    assert_eq!(blocks, Vec::<DiffDisplayBlock>::new());
}

#[test]
fn test_build_diff_blocks_equal_text() {
    let text = "Line 1\nLine 2";
    let blocks = build_diff_blocks("/tmp/equal.txt", text, text);
    assert_eq!(blocks, Vec::<DiffDisplayBlock>::new());
}

#[test]
fn test_format_unified_diff_with_path() {
    let old_text = "alpha\nbeta\n";
    let new_text = "alpha\nbravo\n";

    let diff_text = format_unified_diff(old_text, new_text, Some("demo.txt"), true);

    assert_eq!(
        diff_text,
        "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+bravo\n"
    );
}

#[test]
fn test_format_unified_diff_without_path() {
    let old_text = "alpha\nbeta\n";
    let new_text = "alpha\nbravo\n";

    let diff_text = format_unified_diff(old_text, new_text, None, true);

    assert_eq!(
        diff_text,
        "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+bravo\n"
    );
}

#[test]
fn test_format_unified_diff_without_header() {
    let old_text = "alpha\nbeta\n";
    let new_text = "alpha\nbravo\n";

    let diff_text = format_unified_diff(old_text, new_text, Some("demo.txt"), false);

    assert_eq!(diff_text, "@@ -1,2 +1,2 @@\n alpha\n-beta\n+bravo\n");
}
