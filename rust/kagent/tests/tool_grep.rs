mod tool_test_utils;

use std::path::PathBuf;

use kagent::tools::file::{Grep, GrepParams};
use kagent::tools::utils::DEFAULT_MAX_CHARS;
use kosong::tooling::CallableTool2;
use tool_test_utils::RuntimeFixture;

fn base_params(pattern: &str, path: &str, output_mode: &str) -> GrepParams {
    GrepParams {
        pattern: pattern.to_string(),
        path: path.to_string(),
        glob: None,
        output_mode: output_mode.to_string(),
        before_context: None,
        after_context: None,
        context: None,
        line_number: false,
        ignore_case: false,
        file_type: None,
        head_limit: None,
        multiline: false,
    }
}

fn write_fixture_files(dir: &PathBuf) {
    let test_file1 = dir.join("test1.py");
    std::fs::write(
        &test_file1,
        "def hello_world():\n    print(\"Hello, World!\")\n    return \"hello\"\n\nclass TestClass:\n    def __init__(self):\n        self.message = \"hello there\"\n",
    )
    .expect("write test1");

    let test_file2 = dir.join("test2.js");
    std::fs::write(
        &test_file2,
        "function helloWorld() {\n    console.log(\"Hello, World!\");\n    return \"hello\";\n}\n\nclass TestClass {\n    constructor() {\n        this.message = \"hello there\";\n    }\n}\n",
    )
    .expect("write test2");

    let test_file3 = dir.join("readme.txt");
    std::fs::write(
        &test_file3,
        "This is a readme file.\nIt contains some text.\nHello world example is here.\n",
    )
    .expect("write test3");

    let subdir = dir.join("subdir");
    std::fs::create_dir_all(&subdir).expect("mkdir subdir");
    let subfile = subdir.join("subtest.py");
    std::fs::write(
        &subfile,
        "def sub_hello():\n    return 'hello from subdir'\n",
    )
    .expect("write subfile");
}

#[tokio::test]
async fn test_grep_files_with_matches() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let params = base_params(
        "Hello",
        dir_path.to_string_lossy().as_ref(),
        "files_with_matches",
    );
    let result = tool.call_typed(params).await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("test1.py"));
    assert!(output.contains("test2.js"));
    assert!(output.contains("readme.txt"));
}

#[tokio::test]
async fn test_grep_content_mode() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params("hello", dir_path.to_string_lossy().as_ref(), "content");
    params.line_number = true;
    params.ignore_case = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.to_lowercase().contains("hello"));
    assert!(output.contains(":"));
}

#[tokio::test]
async fn test_grep_case_insensitive() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params(
        "HELLO",
        dir_path.to_string_lossy().as_ref(),
        "files_with_matches",
    );
    params.ignore_case = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("test1.py"));
}

#[tokio::test]
async fn test_grep_with_context() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params("TestClass", dir_path.to_string_lossy().as_ref(), "content");
    params.context = Some(1);
    params.line_number = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    let lines: Vec<&str> = output.lines().collect();
    assert!(lines.len() > 2);
}

#[tokio::test]
async fn test_grep_count_matches() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params(
        "hello",
        dir_path.to_string_lossy().as_ref(),
        "count_matches",
    );
    params.ignore_case = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("test1.py"));
    assert!(output.contains("test2.js"));
}

#[tokio::test]
async fn test_grep_with_glob_pattern() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params(
        "hello",
        dir_path.to_string_lossy().as_ref(),
        "files_with_matches",
    );
    params.glob = Some("*.py".to_string());
    params.ignore_case = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("test1.py"));
    assert!(output.contains("subtest.py"));
    assert!(!output.contains("test2.js"));
    assert!(!output.contains("readme.txt"));
}

#[tokio::test]
async fn test_grep_with_type_filter() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params(
        "hello",
        dir_path.to_string_lossy().as_ref(),
        "files_with_matches",
    );
    params.file_type = Some("py".to_string());
    params.ignore_case = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("test1.py"));
    assert!(output.contains("subtest.py"));
    assert!(!output.contains("test2.js"));
    assert!(!output.contains("readme.txt"));
}

#[tokio::test]
async fn test_grep_head_limit() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params(
        "hello",
        dir_path.to_string_lossy().as_ref(),
        "files_with_matches",
    );
    params.head_limit = Some(2);
    params.ignore_case = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    let lines: Vec<&str> = output
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with("..."))
        .collect();
    assert!(lines.len() <= 2);
    assert!(output.contains("results truncated to 2 lines"));
}

#[tokio::test]
async fn test_grep_output_truncation() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let file_path = temp_dir.path().join("big.txt");
    std::fs::write(
        &file_path,
        "match line with filler content that keeps growing for truncation purposes\n".repeat(2000),
    )
    .expect("write file");

    let mut params = base_params("match", file_path.to_string_lossy().as_ref(), "content");
    params.line_number = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert_eq!(result.message, "Output is truncated to fit in the message.");
    assert!(output.len() < DEFAULT_MAX_CHARS + 100);
}

#[tokio::test]
async fn test_grep_multiline_mode() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let file_path = temp_dir.path().join("multiline.py");
    std::fs::write(
        &file_path,
        "def function():\n    '''This is a\n    multiline docstring'''\n    pass\n",
    )
    .expect("write file");

    let mut params = base_params(
        "This is a\n    multiline",
        file_path.to_string_lossy().as_ref(),
        "content",
    );
    params.multiline = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("This is a"));
    assert!(output.contains("multiline"));
}

#[tokio::test]
async fn test_grep_no_matches() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let file_path = temp_dir.path().join("empty.py");
    std::fs::write(&file_path, "# This file has no matching content\n").expect("write file");

    let params = base_params(
        "nonexistent_pattern",
        temp_dir.path().to_string_lossy().as_ref(),
        "files_with_matches",
    );
    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert_eq!(output, "");
    assert!(result.message.contains("No matches found"));
}

#[tokio::test]
async fn test_grep_invalid_pattern() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);

    let params = base_params("[invalid", ".", "files_with_matches");
    let result = tool.call_typed(params).await;

    assert!(result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.is_empty());
}

#[tokio::test]
async fn test_grep_single_file() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_file = tempfile::NamedTempFile::new().expect("temp file");
    std::fs::write(
        temp_file.path(),
        "def test_function():\n    return 'hello world'\n",
    )
    .expect("write file");

    let mut params = base_params(
        "hello",
        temp_file.path().to_string_lossy().as_ref(),
        "content",
    );
    params.line_number = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("hello"));
    assert!(!output.trim().is_empty());
}

#[tokio::test]
async fn test_grep_before_after_context() {
    let fixture = RuntimeFixture::new();
    let tool = Grep::new(&fixture.runtime);
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let dir_path = temp_dir.path().to_path_buf();
    write_fixture_files(&dir_path);

    let mut params = base_params("TestClass", dir_path.to_string_lossy().as_ref(), "content");
    params.before_context = Some(2);
    params.line_number = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("TestClass"));
    assert!(output.contains("}"));
    assert!(output.contains("return \"hello\""));
    assert!(!output.contains("Hello, World!"));

    let mut params = base_params("TestClass", dir_path.to_string_lossy().as_ref(), "content");
    params.after_context = Some(2);
    params.line_number = true;

    let result = tool.call_typed(params).await;
    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("TestClass"));
    assert!(output.contains("constructor()"));
    assert!(output.contains("this.message"));
    assert!(!output.contains("}"));
}
