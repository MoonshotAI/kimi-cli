mod tool_test_utils;

use std::future::Future;
use std::path::PathBuf;

use kagent::soul::toolset::with_current_tool_call;
use kagent::tools::file::{WriteFile, WriteMode, WriteParams};
use kaos::with_current_kaos_scope;
use kosong::message::ToolCall;
use kosong::tooling::{CallableTool, CallableTool2, DisplayBlock, ToolReturnValue};
use serde_json::json;
use tempfile::TempDir;

use tool_test_utils::{RuntimeFixture, TestKaosGuard};

async fn call_with_tool_call<F>(name: &str, fut: F) -> ToolReturnValue
where
    F: Future<Output = ToolReturnValue>,
{
    let call = ToolCall::new("test-call-id", name);
    with_current_tool_call(call, fut).await
}

fn diff_block(result: &ToolReturnValue) -> &kosong::tooling::DiffDisplayBlock {
    result
        .display
        .iter()
        .find_map(|block| match block {
            DisplayBlock::Diff(diff) => Some(diff),
            _ => None,
        })
        .expect("diff block")
}

#[tokio::test]
async fn test_write_new_file() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "new_file.txt";
    let content = "Hello, World!";

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: content.to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully overwritten"));
    let diff = diff_block(&result);
    assert_eq!(diff.path, file_path.to_string_lossy());
    assert_eq!(diff.old_text, "");
    assert_eq!(diff.new_text, content);
    assert!(file_path.exists(true).await);
    assert_eq!(file_path.read_text().await.expect("read file"), content);
}

#[tokio::test]
async fn test_overwrite_existing_file() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "existing.txt";
    file_path
        .write_text("Original content")
        .await
        .expect("write file");

    let new_content = "New content";
    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: new_content.to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully overwritten"));
    assert_eq!(file_path.read_text().await.expect("read file"), new_content);
}

#[tokio::test]
async fn test_append_to_file() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "append_test.txt";
    let original_content = "First line\n";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let append_content = "Second line\n";
    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: append_content.to_string(),
            mode: WriteMode::Append,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully appended to"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        format!("{original_content}{append_content}")
    );
}

#[tokio::test]
async fn test_write_unicode_content() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "unicode.txt";
    let content = "Hello 世界 🌍\nUnicode: café, naïve, résumé";

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: content.to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(file_path.exists(true).await);
    assert_eq!(file_path.read_text().await.expect("read file"), content);
}

#[tokio::test]
async fn test_write_empty_content() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "empty.txt";

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: "".to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(file_path.exists(true).await);
    assert_eq!(file_path.read_text().await.expect("read file"), "");
}

#[tokio::test]
async fn test_write_multiline_content() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "multiline.txt";
    let content = "Line 1\nLine 2\nLine 3\n";

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: content.to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert_eq!(file_path.read_text().await.expect("read file"), content);
}

#[tokio::test]
async fn test_write_with_relative_path() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = WriteFile::new(&fixture.runtime);

    with_current_kaos_scope(async move {
        let _guard = TestKaosGuard::new(work_dir.clone());

        let relative_dir = work_dir.clone() / "relative" / "path";
        relative_dir.mkdir(true, true).await.expect("mkdir");

        let result = call_with_tool_call(
            "WriteFile",
            tool.call_typed(WriteParams {
                path: "relative/path/file.txt".to_string(),
                content: "content".to_string(),
                mode: WriteMode::Overwrite,
            }),
        )
        .await;

        assert!(!result.is_error);
        let written = work_dir / "relative" / "path" / "file.txt";
        assert_eq!(written.read_text().await.expect("read file"), "content");
    })
    .await;
}

#[tokio::test]
async fn test_write_outside_work_directory() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let temp_dir = TempDir::new().expect("temp dir");
    let outside_file = PathBuf::from(temp_dir.path()).join("outside.txt");

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: outside_file.to_string_lossy().to_string(),
            content: "content".to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert_eq!(
        std::fs::read_to_string(&outside_file).expect("read file"),
        "content"
    );
}

#[tokio::test]
async fn test_write_outside_work_directory_with_prefix() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);

    let base = PathBuf::from(fixture.runtime.builtin_args.KIMI_WORK_DIR.to_string_lossy());
    let sneaky_dir = base.parent().expect("parent").join(format!(
        "{}-sneaky",
        base.file_name().unwrap().to_string_lossy()
    ));
    std::fs::create_dir_all(&sneaky_dir).expect("create sneaky dir");
    let sneaky_file = sneaky_dir.join("file.txt");

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: sneaky_file.to_string_lossy().to_string(),
            content: "content".to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert_eq!(
        std::fs::read_to_string(&sneaky_file).expect("read file"),
        "content"
    );
}

#[tokio::test]
async fn test_write_to_nonexistent_directory() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "nonexistent" / "file.txt";

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: "content".to_string(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(result.is_error);
    assert!(result.message.contains("parent directory does not exist"));
}

#[tokio::test]
async fn test_write_with_invalid_mode() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";

    let result = tool
        .call(json!({
            "path": file_path.to_string_lossy(),
            "content": "content",
            "mode": "invalid"
        }))
        .await;

    assert!(result.is_error);
    assert_eq!(result.brief(), "Invalid arguments");
}

#[tokio::test]
async fn test_append_to_nonexistent_file() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "new_append.txt";

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: "New content\n".to_string(),
            mode: WriteMode::Append,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully appended to"));
    assert!(file_path.exists(true).await);
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "New content\n"
    );
}

#[tokio::test]
async fn test_write_large_content() {
    let fixture = RuntimeFixture::new();
    let tool = WriteFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "large.txt";
    let content = "Large content line\n".repeat(1000);

    let result = call_with_tool_call(
        "WriteFile",
        tool.call_typed(WriteParams {
            path: file_path.to_string_lossy(),
            content: content.clone(),
            mode: WriteMode::Overwrite,
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(file_path.exists(true).await);
    assert_eq!(file_path.read_text().await.expect("read file"), content);
}
