mod tool_test_utils;

use std::future::Future;
use std::path::PathBuf;

use kagent::soul::toolset::with_current_tool_call;
use kagent::tools::file::{EditParams, StrReplaceFile, StrReplaceParams};
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
async fn test_replace_single_occurrence() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "Hello world! This is a test.";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call(json!({
            "path": file_path.to_string_lossy(),
            "edit": {"old": "world", "new": "universe"}
        })),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    let diff = diff_block(&result);
    assert_eq!(diff.path, file_path.to_string_lossy());
    assert_eq!(diff.old_text, original_content);
    assert_eq!(diff.new_text, "Hello universe! This is a test.");
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "Hello universe! This is a test."
    );
}

#[tokio::test]
async fn test_replace_all_occurrences() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "apple banana apple cherry apple";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "apple".to_string(),
                new: "fruit".to_string(),
                replace_all: true,
            }],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "fruit banana fruit cherry fruit"
    );
}

#[tokio::test]
async fn test_replace_multiple_edits() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "Hello world! Goodbye world!";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![
                EditParams {
                    old: "Hello".to_string(),
                    new: "Hi".to_string(),
                    replace_all: false,
                },
                EditParams {
                    old: "Goodbye".to_string(),
                    new: "See you".to_string(),
                    replace_all: false,
                },
            ],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "Hi world! See you world!"
    );
}

#[tokio::test]
async fn test_replace_multiline_content() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "Line 1\nLine 2\nLine 3\n";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "Line 2\nLine 3".to_string(),
                new: "Modified line 2\nModified line 3".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "Line 1\nModified line 2\nModified line 3\n"
    );
}

#[tokio::test]
async fn test_replace_unicode_content() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "Hello 世界! café";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "世界".to_string(),
                new: "地球".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "Hello 地球! café"
    );
}

#[tokio::test]
async fn test_replace_no_match() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "Hello world!";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "notfound".to_string(),
                new: "replacement".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(result.is_error);
    assert!(result.message.contains("No replacements were made"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        original_content
    );
}

#[tokio::test]
async fn test_replace_with_relative_path() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = StrReplaceFile::new(&fixture.runtime);

    with_current_kaos_scope(async move {
        let _guard = TestKaosGuard::new(work_dir.clone());

        let relative_dir = work_dir.clone() / "relative" / "path";
        relative_dir.mkdir(true, true).await.expect("mkdir");
        let file_path = relative_dir.clone() / "file.txt";
        file_path.write_text("old content").await.expect("write");

        let result = call_with_tool_call(
            "StrReplaceFile",
            tool.call_typed(StrReplaceParams {
                path: "relative/path/file.txt".to_string(),
                edit: vec![EditParams {
                    old: "old".to_string(),
                    new: "new".to_string(),
                    replace_all: false,
                }],
            }),
        )
        .await;

        assert!(!result.is_error);
        assert_eq!(
            file_path.read_text().await.expect("read file"),
            "new content"
        );
    })
    .await;
}

#[tokio::test]
async fn test_replace_outside_work_directory() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let temp_dir = TempDir::new().expect("temp dir");
    let outside_file = PathBuf::from(temp_dir.path()).join("outside.txt");
    std::fs::write(&outside_file, "old content").expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: outside_file.to_string_lossy().to_string(),
            edit: vec![EditParams {
                old: "old".to_string(),
                new: "new".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert_eq!(
        std::fs::read_to_string(&outside_file).expect("read file"),
        "new content"
    );
}

#[tokio::test]
async fn test_replace_outside_work_directory_with_prefix() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);

    let base = PathBuf::from(fixture.runtime.builtin_args.KIMI_WORK_DIR.to_string_lossy());
    let sneaky_dir = base.parent().expect("parent").join(format!(
        "{}-sneaky",
        base.file_name().unwrap().to_string_lossy()
    ));
    std::fs::create_dir_all(&sneaky_dir).expect("create sneaky dir");
    let sneaky_file = sneaky_dir.join("test.txt");
    std::fs::write(&sneaky_file, "content").expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: sneaky_file.to_string_lossy().to_string(),
            edit: vec![EditParams {
                old: "content".to_string(),
                new: "new".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert_eq!(
        std::fs::read_to_string(&sneaky_file).expect("read file"),
        "new"
    );
}

#[tokio::test]
async fn test_replace_nonexistent_file() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "nonexistent.txt";

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "old".to_string(),
                new: "new".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(result.is_error);
    assert!(result.message.contains("does not exist"));
}

#[tokio::test]
async fn test_replace_directory_instead_of_file() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let dir_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "directory";
    dir_path.mkdir(false, false).await.expect("mkdir");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: dir_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "old".to_string(),
                new: "new".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(result.is_error);
    assert!(result.message.contains("is not a file"));
}

#[tokio::test]
async fn test_replace_mixed_multiple_edits() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "apple apple banana apple cherry";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![
                EditParams {
                    old: "apple".to_string(),
                    new: "fruit".to_string(),
                    replace_all: false,
                },
                EditParams {
                    old: "banana".to_string(),
                    new: "tasty".to_string(),
                    replace_all: true,
                },
            ],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    assert_eq!(
        file_path.read_text().await.expect("read file"),
        "fruit apple tasty apple cherry"
    );
}

#[tokio::test]
async fn test_replace_empty_strings() {
    let fixture = RuntimeFixture::new();
    let tool = StrReplaceFile::new(&fixture.runtime);
    let file_path = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "test.txt";
    let original_content = "Hello world!";
    file_path
        .write_text(original_content)
        .await
        .expect("write file");

    let result = call_with_tool_call(
        "StrReplaceFile",
        tool.call_typed(StrReplaceParams {
            path: file_path.to_string_lossy(),
            edit: vec![EditParams {
                old: "world".to_string(),
                new: "".to_string(),
                replace_all: false,
            }],
        }),
    )
    .await;

    assert!(!result.is_error);
    assert!(result.message.contains("successfully edited"));
    assert_eq!(file_path.read_text().await.expect("read file"), "Hello !");
}
