mod tool_test_utils;

use std::path::Path;

use kagent::tools::file::{MAX_BYTES, MAX_LINE_LENGTH, MAX_LINES, ReadFile, ReadParams};
use kaos::KaosPath;
use kaos::with_current_kaos_scope;
use kosong::tooling::{CallableTool, CallableTool2, ToolOutput};
use serde_json::json;

use tool_test_utils::{RuntimeFixture, TestKaosGuard};

fn output_text(result: &kosong::tooling::ToolReturnValue) -> &str {
    match &result.output {
        ToolOutput::Text(text) => text,
        _ => panic!("expected text output"),
    }
}

async fn write_sample_file(work_dir: &KaosPath) -> KaosPath {
    let file_path = work_dir.clone() / "sample.txt";
    let content = "Line 1: Hello World\n\
Line 2: This is a test file\n\
Line 3: With multiple lines\n\
Line 4: For testing purposes\n\
Line 5: End of file";
    file_path
        .write_text(content)
        .await
        .expect("write sample file");
    file_path
}

#[tokio::test]
async fn test_read_entire_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     1\tLine 1: Hello World\n     2\tLine 2: This is a test file\n     3\tLine 3: With multiple lines\n     4\tLine 4: For testing purposes\n     5\tLine 5: End of file"
    );
    assert_eq!(
        result.message,
        "5 lines read from file starting from line 1. End of file reached."
    );
}

#[tokio::test]
async fn test_read_with_line_offset() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 3,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     3\tLine 3: With multiple lines\n     4\tLine 4: For testing purposes\n     5\tLine 5: End of file"
    );
    assert_eq!(
        result.message,
        "3 lines read from file starting from line 3. End of file reached."
    );
}

#[tokio::test]
async fn test_read_with_n_lines() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 1,
            n_lines: 2,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     1\tLine 1: Hello World\n     2\tLine 2: This is a test file\n"
    );
    assert_eq!(
        result.message,
        "2 lines read from file starting from line 1."
    );
}

#[tokio::test]
async fn test_read_with_line_offset_and_n_lines() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 2,
            n_lines: 2,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     2\tLine 2: This is a test file\n     3\tLine 3: With multiple lines\n"
    );
    assert_eq!(
        result.message,
        "2 lines read from file starting from line 2."
    );
}

#[tokio::test]
async fn test_read_nonexistent_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let missing = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "missing.txt";

    let result = tool
        .call_typed(ReadParams {
            path: missing.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(result.is_error);
    assert_eq!(result.message, format!("`{}` does not exist.", missing));
    assert_eq!(result.brief(), "File not found");
}

#[tokio::test]
async fn test_read_directory_instead_of_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();

    let result = tool
        .call_typed(ReadParams {
            path: dir.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(result.is_error);
    assert_eq!(result.message, format!("`{}` is not a file.", dir));
    assert_eq!(result.brief(), "Invalid path");
}

#[tokio::test]
async fn test_read_with_relative_path() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = ReadFile::new(&fixture.runtime);

    with_current_kaos_scope(async move {
        let _guard = TestKaosGuard::new(work_dir.clone());
        let file_path = write_sample_file(&work_dir).await;

        let relative = file_path.relative_to(&work_dir).expect("relative path");
        let result = tool
            .call_typed(ReadParams {
                path: relative.to_string_lossy(),
                line_offset: 1,
                n_lines: MAX_LINES as i64,
            })
            .await;

        assert!(!result.is_error);
        assert_eq!(
            result.message,
            "5 lines read from file starting from line 1. End of file reached."
        );
        assert_eq!(
            output_text(&result),
            "     1\tLine 1: Hello World\n     2\tLine 2: This is a test file\n     3\tLine 3: With multiple lines\n     4\tLine 4: For testing purposes\n     5\tLine 5: End of file"
        );
    })
    .await;
}

#[tokio::test]
async fn test_read_with_relative_path_outside_work_dir() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = ReadFile::new(&fixture.runtime);

    with_current_kaos_scope(async move {
        let _guard = TestKaosGuard::new(work_dir);

        let path = Path::new("..").join("outside_file.txt");
        let result = tool
            .call_typed(ReadParams {
                path: path.to_string_lossy().to_string(),
                line_offset: 1,
                n_lines: MAX_LINES as i64,
            })
            .await;

        assert!(result.is_error);
        assert_eq!(
            result.message,
            format!(
                "`{}` is not an absolute path. You must provide an absolute path to read a file outside the working directory.",
                path.to_string_lossy()
            )
        );
        assert_eq!(output_text(&result), "");
    })
    .await;
}

#[tokio::test]
async fn test_read_empty_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let empty_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "empty.txt";
    empty_file.write_text("").await.expect("write empty file");

    let result = tool
        .call_typed(ReadParams {
            path: empty_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(output_text(&result), "");
    assert_eq!(
        result.message,
        "No lines read from file. End of file reached."
    );
}

#[tokio::test]
async fn test_read_image_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let image_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample.png";
    let data = b"\x89PNG\r\n\x1a\n"
        .iter()
        .copied()
        .chain(b"pngdata".iter().copied())
        .collect::<Vec<_>>();
    image_file
        .write_bytes(&data)
        .await
        .expect("write image file");

    let result = tool
        .call_typed(ReadParams {
            path: image_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        format!(
            "`{}` is a image file. Use other appropriate tools to read image or video files.",
            image_file
        )
    );
    assert_eq!(result.brief(), "Unsupported file type");
}

#[tokio::test]
async fn test_read_extensionless_image_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let image_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample";
    let data = b"\x89PNG\r\n\x1a\n"
        .iter()
        .copied()
        .chain(b"pngdata".iter().copied())
        .collect::<Vec<_>>();
    image_file
        .write_bytes(&data)
        .await
        .expect("write image file");

    let result = tool
        .call_typed(ReadParams {
            path: image_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        format!(
            "`{}` is a image file. Use other appropriate tools to read image or video files.",
            image_file
        )
    );
    assert_eq!(result.brief(), "Unsupported file type");
}

#[tokio::test]
async fn test_read_video_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let video_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample.mp4";
    let data = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom".to_vec();
    video_file
        .write_bytes(&data)
        .await
        .expect("write video file");

    let result = tool
        .call_typed(ReadParams {
            path: video_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        format!(
            "`{}` is a video file. Use other appropriate tools to read image or video files.",
            video_file
        )
    );
    assert_eq!(result.brief(), "Unsupported file type");
}

#[tokio::test]
async fn test_read_line_offset_beyond_file_length() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 10,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(output_text(&result), "");
    assert_eq!(
        result.message,
        "No lines read from file. End of file reached."
    );
}

#[tokio::test]
async fn test_read_unicode_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let unicode_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "unicode.txt";
    let content = "Hello 世界 🌍\nUnicode test: café, naïve, résumé";
    unicode_file
        .write_text(content)
        .await
        .expect("write unicode file");

    let result = tool
        .call_typed(ReadParams {
            path: unicode_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     1\tHello 世界 🌍\n     2\tUnicode test: café, naïve, résumé"
    );
    assert_eq!(
        result.message,
        "2 lines read from file starting from line 1. End of file reached."
    );
}

#[tokio::test]
async fn test_read_edge_cases() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     1\tLine 1: Hello World\n     2\tLine 2: This is a test file\n     3\tLine 3: With multiple lines\n     4\tLine 4: For testing purposes\n     5\tLine 5: End of file"
    );
    assert_eq!(
        result.message,
        "5 lines read from file starting from line 1. End of file reached."
    );

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 5,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(output_text(&result), "     5\tLine 5: End of file");
    assert_eq!(
        result.message,
        "1 lines read from file starting from line 5. End of file reached."
    );

    let result = tool
        .call_typed(ReadParams {
            path: file_path.to_string_lossy(),
            line_offset: 2,
            n_lines: 1,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        output_text(&result),
        "     2\tLine 2: This is a test file\n"
    );
    assert_eq!(
        result.message,
        "1 lines read from file starting from line 2."
    );
}

#[tokio::test]
async fn test_line_truncation_and_messaging() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();

    let single_line_file = work_dir.clone() / "single_long_line.txt";
    let long_content = format!("{} This should be truncated", "A".repeat(2500));
    single_line_file
        .write_text(&long_content)
        .await
        .expect("write long line");

    let result = tool
        .call_typed(ReadParams {
            path: single_line_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert!(result.message.contains("1 lines read from"));
    assert!(output_text(&result).ends_with("..."));

    let content_line = output_text(&result)
        .lines()
        .find(|line| !line.trim().is_empty())
        .expect("content line");
    let actual_content = content_line.splitn(2, '\t').nth(1).unwrap_or(content_line);
    assert_eq!(actual_content.len(), MAX_LINE_LENGTH);

    let multi_line_file = work_dir / "multi_truncation_test.txt";
    let long_line_1 = "A".repeat(2500);
    let long_line_2 = "B".repeat(3000);
    let normal_line = "Short line";
    let content = format!("{long_line_1}\n{normal_line}\n{long_line_2}");
    multi_line_file
        .write_text(&content)
        .await
        .expect("write multi line");

    let result = tool
        .call_typed(ReadParams {
            path: multi_line_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        result.message,
        "3 lines read from file starting from line 1. End of file reached. Lines [1, 3] were truncated."
    );

    let lines: Vec<&str> = output_text(&result).lines().collect();
    let endings: Vec<&str> = lines
        .iter()
        .map(|line| {
            if line.len() > 20 {
                &line[line.len() - 20..]
            } else {
                *line
            }
        })
        .collect();
    assert_eq!(
        endings,
        vec![
            "AAAAAAAAAAAAAAAAA...",
            "     2\tShort line",
            "BBBBBBBBBBBBBBBBB..."
        ]
    );
}

#[tokio::test]
async fn test_parameter_validation_line_offset() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call(json!({"path": file_path.to_string_lossy(), "line_offset": 0}))
        .await;
    assert!(result.is_error);
    assert!(result.message.contains("line_offset"));
    assert_eq!(result.brief(), "Invalid arguments");

    let result = tool
        .call(json!({"path": file_path.to_string_lossy(), "line_offset": -1}))
        .await;
    assert!(result.is_error);
    assert!(result.message.contains("line_offset"));
    assert_eq!(result.brief(), "Invalid arguments");
}

#[tokio::test]
async fn test_parameter_validation_n_lines() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let file_path = write_sample_file(&fixture.runtime.builtin_args.KIMI_WORK_DIR).await;

    let result = tool
        .call(json!({"path": file_path.to_string_lossy(), "n_lines": 0}))
        .await;
    assert!(result.is_error);
    assert!(result.message.contains("n_lines"));
    assert_eq!(result.brief(), "Invalid arguments");

    let result = tool
        .call(json!({"path": file_path.to_string_lossy(), "n_lines": -1}))
        .await;
    assert!(result.is_error);
    assert!(result.message.contains("n_lines"));
    assert_eq!(result.brief(), "Invalid arguments");
}

#[tokio::test]
async fn test_max_lines_boundary() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let large_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "large_file.txt";
    let content = (1..=MAX_LINES + 10)
        .map(|i| format!("Line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    large_file
        .write_text(&content)
        .await
        .expect("write large file");

    let result = tool
        .call_typed(ReadParams {
            path: large_file.to_string_lossy(),
            line_offset: 1,
            n_lines: (MAX_LINES + 5) as i64,
        })
        .await;

    assert!(!result.is_error);
    assert!(
        result
            .message
            .contains(&format!("Max {MAX_LINES} lines reached."))
    );
    let output_lines: Vec<&str> = output_text(&result)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    assert_eq!(output_lines.len(), MAX_LINES);
}

#[tokio::test]
async fn test_max_bytes_boundary() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);
    let large_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "large_bytes.txt";
    let line_content = "A".repeat(1000);
    let num_lines = (MAX_BYTES / 1000) + 5;
    let content = vec![line_content; num_lines].join("\n");
    large_file
        .write_text(&content)
        .await
        .expect("write large file");

    let result = tool
        .call_typed(ReadParams {
            path: large_file.to_string_lossy(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert!(
        result
            .message
            .contains(&format!("Max {MAX_BYTES} bytes reached."))
    );
}

#[tokio::test]
async fn test_read_with_tilde_path_expansion() {
    let fixture = RuntimeFixture::new();
    let tool = ReadFile::new(&fixture.runtime);

    let home = dirs::home_dir().expect("home dir");
    let test_file = home.join(".kimi_test_expanduser_temp");
    let test_content = "Test content for tilde expansion";

    std::fs::write(&test_file, test_content).expect("write test file");

    let result = tool
        .call_typed(ReadParams {
            path: "~/.kimi_test_expanduser_temp".to_string(),
            line_offset: 1,
            n_lines: MAX_LINES as i64,
        })
        .await;

    assert!(!result.is_error);
    assert!(output_text(&result).contains(test_content));
    assert_eq!(
        result.message,
        "1 lines read from file starting from line 1. End of file reached."
    );

    let _ = std::fs::remove_file(&test_file);
}
