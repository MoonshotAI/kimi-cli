use kagent::tools::utils::ToolResultBuilder;
use kosong::tooling::ToolOutput;

fn output_text(output: &ToolOutput) -> String {
    match output {
        ToolOutput::Text(text) => text.clone(),
        ToolOutput::Parts(_) => panic!("expected text output"),
    }
}

#[test]
fn test_basic_functionality() {
    let mut builder = ToolResultBuilder::new(50, None);

    let written1 = builder.write("Hello");
    let written2 = builder.write(" world");

    assert_eq!(written1, 5);
    assert_eq!(written2, 6);

    let result = builder.ok("Operation completed", "");
    assert_eq!(output_text(&result.output), "Hello world");
    assert_eq!(result.message, "Operation completed.");
    assert!(!builder.is_full());
}

#[test]
fn test_char_limit_truncation() {
    let mut builder = ToolResultBuilder::new(10, None);

    let written1 = builder.write("Hello");
    let written2 = builder.write(" world!");

    assert_eq!(written1, 5);
    assert_eq!(written2, 14);
    assert!(builder.is_full());

    let result = builder.ok("Operation completed", "");
    assert_eq!(output_text(&result.output), "Hello[...truncated]");
    assert!(result.message.contains("Operation completed."));
    assert!(result.message.contains("Output is truncated"));
}

#[test]
fn test_line_length_limit() {
    let mut builder = ToolResultBuilder::new(100, Some(20));

    let written = builder.write("This is a very long line that should be truncated\n");

    assert_eq!(written, 20);

    let result = builder.ok("", "");
    assert!(output_text(&result.output).contains("[...truncated]"));
    assert!(result.message.contains("Output is truncated"));
}

#[test]
fn test_both_limits() {
    let mut builder = ToolResultBuilder::new(40, Some(20));

    let w1 = builder.write("Line 1\n");
    let w2 = builder.write("This is a very long line that exceeds limit\n");
    let w3 = builder.write("This would exceed char limit");

    assert_eq!(w1, 7);
    assert_eq!(w2, 20);
    assert_eq!(w3, 14);
    assert!(builder.is_full());

    let result = builder.ok("", "");
    assert!(output_text(&result.output).contains("[...truncated]"));
    assert!(result.message.contains("Output is truncated"));
}

#[test]
fn test_error_result() {
    let mut builder = ToolResultBuilder::new(20, None);
    builder.write("Some output");
    let result = builder.error("Something went wrong", "Error occurred");

    assert_eq!(output_text(&result.output), "Some output");
    assert_eq!(result.message, "Something went wrong");
    assert_eq!(result.brief(), "Error occurred");
}

#[test]
fn test_error_with_truncation() {
    let mut builder = ToolResultBuilder::new(10, None);
    builder.write("Very long output that exceeds limit");
    let result = builder.error("Command failed", "Failed");

    assert!(output_text(&result.output).contains("[...truncated]"));
    assert!(result.message.contains("Command failed"));
    assert!(result.message.contains("Output is truncated"));
    assert_eq!(result.brief(), "Failed");
}

#[test]
fn test_properties() {
    let mut builder = ToolResultBuilder::new(20, Some(30));

    assert_eq!(builder.n_chars(), 0);
    assert_eq!(builder.n_lines(), 0);
    assert!(!builder.is_full());

    builder.write("Short\n");
    assert_eq!(builder.n_chars(), 6);
    assert_eq!(builder.n_lines(), 1);

    builder.write("1\n2\n");
    assert_eq!(builder.n_chars(), 10);
    assert_eq!(builder.n_lines(), 3);

    builder.write("More text that exceeds");
    assert!(builder.is_full());
}

#[test]
fn test_write_when_full() {
    let mut builder = ToolResultBuilder::new(5, None);

    let written1 = builder.write("Hello");
    let written2 = builder.write(" world");

    assert_eq!(written1, 5);
    assert_eq!(written2, 0);
    assert!(builder.is_full());

    let result = builder.ok("", "");
    assert_eq!(output_text(&result.output), "Hello");
}

#[test]
fn test_multiline_handling() {
    let mut builder = ToolResultBuilder::new(100, None);

    let written = builder.write("Line 1\nLine 2\nLine 3");

    assert_eq!(written, 20);
    assert_eq!(builder.n_lines(), 2);

    let result = builder.ok("", "");
    assert_eq!(output_text(&result.output), "Line 1\nLine 2\nLine 3");
}

#[test]
fn test_empty_write() {
    let mut builder = ToolResultBuilder::new(50, None);

    let written = builder.write("");

    assert_eq!(written, 0);
    assert_eq!(builder.n_chars(), 0);
    assert!(!builder.is_full());
}
