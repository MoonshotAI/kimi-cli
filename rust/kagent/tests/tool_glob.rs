mod tool_test_utils;

use std::path::PathBuf;

use kagent::tools::file::{Glob, GlobParams, MAX_MATCHES};
use kaos::KaosPath;
use kosong::tooling::CallableTool2;
use tool_test_utils::RuntimeFixture;

async fn setup_test_files(work_dir: &KaosPath) {
    (work_dir.clone() / "src" / "main")
        .mkdir(true, true)
        .await
        .expect("mkdir");
    (work_dir.clone() / "src" / "test")
        .mkdir(true, true)
        .await
        .expect("mkdir");
    (work_dir.clone() / "docs")
        .mkdir(true, true)
        .await
        .expect("mkdir");

    (work_dir.clone() / "README.md")
        .write_text("# README")
        .await
        .expect("write file");
    (work_dir.clone() / "setup.py")
        .write_text("setup")
        .await
        .expect("write file");
    (work_dir.clone() / "src" / "main.py")
        .write_text("main")
        .await
        .expect("write file");
    (work_dir.clone() / "src" / "utils.py")
        .write_text("utils")
        .await
        .expect("write file");
    (work_dir.clone() / "src" / "main" / "app.py")
        .write_text("app")
        .await
        .expect("write file");
    (work_dir.clone() / "src" / "main" / "config.py")
        .write_text("config")
        .await
        .expect("write file");
    (work_dir.clone() / "src" / "test" / "test_app.py")
        .write_text("test app")
        .await
        .expect("write file");
    (work_dir.clone() / "src" / "test" / "test_config.py")
        .write_text("test config")
        .await
        .expect("write file");
    (work_dir.clone() / "docs" / "guide.md")
        .write_text("guide")
        .await
        .expect("write file");
    (work_dir.clone() / "docs" / "api.md")
        .write_text("api")
        .await
        .expect("write file");
}

fn params(pattern: &str, directory: Option<&KaosPath>, include_dirs: bool) -> GlobParams {
    GlobParams {
        pattern: pattern.to_string(),
        directory: directory.map(|dir| dir.to_string_lossy()),
        include_dirs,
    }
}

#[tokio::test]
async fn test_glob_simple_pattern() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool.call_typed(params("*.py", Some(&work_dir), true)).await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("setup.py"));
    assert!(result.message.contains("Found 1 matches"));
}

#[tokio::test]
async fn test_glob_multiple_matches() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool.call_typed(params("*.md", Some(&work_dir), true)).await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("README.md"));
    assert!(result.message.contains("Found 1 matches"));
}

#[tokio::test]
async fn test_glob_recursive_pattern_prohibited() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("**/*.py", Some(&work_dir), true))
        .await;

    assert!(result.is_error);
    assert!(
        result
            .message
            .contains("starts with '**' which is not allowed")
    );
    assert_eq!(result.brief(), "Unsafe pattern");
}

#[tokio::test]
async fn test_glob_safe_recursive_pattern() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("src/**/*.py", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text.replace("\\", "/"),
        _ => String::new(),
    };
    assert!(output.contains("src/main.py"));
    assert!(output.contains("src/utils.py"));
    assert!(output.contains("src/main/app.py"));
    assert!(output.contains("src/main/config.py"));
    assert!(output.contains("src/test/test_app.py"));
    assert!(output.contains("src/test/test_config.py"));
    assert!(result.message.contains("Found 6 matches"));
}

#[tokio::test]
async fn test_glob_specific_directory() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);
    let src_dir = work_dir.clone() / "src";

    let result = tool.call_typed(params("*.py", Some(&src_dir), true)).await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("main.py"));
    assert!(output.contains("utils.py"));
    assert!(result.message.contains("Found 2 matches"));
}

#[tokio::test]
async fn test_glob_recursive_in_subdirectory() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);
    let src_dir = work_dir.clone() / "src";

    let result = tool
        .call_typed(params("main/**/*.py", Some(&src_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text.replace("\\", "/"),
        _ => String::new(),
    };
    assert!(output.contains("main/app.py"));
    assert!(output.contains("main/config.py"));
    assert!(result.message.contains("Found 2 matches"));
}

#[tokio::test]
async fn test_glob_test_files() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("src/**/*test*.py", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text.replace("\\", "/"),
        _ => String::new(),
    };
    assert!(output.contains("src/test/test_app.py"));
    assert!(output.contains("src/test/test_config.py"));
    assert!(result.message.contains("Found 2 matches"));
}

#[tokio::test]
async fn test_glob_no_matches() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("*.xyz", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert_eq!(output, "");
    assert!(result.message.contains("No matches found"));
}

#[tokio::test]
async fn test_glob_exclude_directories() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);

    (work_dir.clone() / "test_file.txt")
        .write_text("content")
        .await
        .expect("write file");
    (work_dir.clone() / "test_dir")
        .mkdir(false, true)
        .await
        .expect("mkdir");

    let result = tool
        .call_typed(GlobParams {
            pattern: "test_*".to_string(),
            directory: Some(work_dir.to_string_lossy()),
            include_dirs: false,
        })
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("test_file.txt"));
    assert!(!output.contains("test_dir"));
    assert!(result.message.contains("Found 1 matches"));
}

#[tokio::test]
async fn test_glob_with_relative_path() {
    let fixture = RuntimeFixture::new();
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(GlobParams {
            pattern: "*.py".to_string(),
            directory: Some("relative/path".to_string()),
            include_dirs: true,
        })
        .await;

    assert!(result.is_error);
    assert!(result.message.contains("not an absolute path"));
}

#[tokio::test]
async fn test_glob_outside_work_directory() {
    let fixture = RuntimeFixture::new();
    let tool = Glob::new(&fixture.runtime);

    let outside = if cfg!(windows) {
        "C:/tmp/outside"
    } else {
        "/tmp/outside"
    };

    let result = tool
        .call_typed(GlobParams {
            pattern: "*.py".to_string(),
            directory: Some(outside.to_string()),
            include_dirs: true,
        })
        .await;

    assert!(result.is_error);
    assert!(result.message.contains("outside the working directory"));
}

#[tokio::test]
async fn test_glob_outside_work_directory_with_prefix() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);

    let base = PathBuf::from(work_dir.to_string_lossy());
    let sneaky_dir = base.parent().expect("parent").join(format!(
        "{}-sneaky",
        base.file_name().unwrap().to_string_lossy()
    ));
    std::fs::create_dir_all(&sneaky_dir).expect("create sneaky dir");

    let result = tool
        .call_typed(params(
            "*.py",
            Some(&KaosPath::from(sneaky_dir.clone())),
            true,
        ))
        .await;

    assert!(result.is_error);
    assert!(result.message.contains("outside the working directory"));
}

#[tokio::test]
async fn test_glob_nonexistent_directory() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);
    let missing = work_dir.clone() / "nonexistent";

    let result = tool.call_typed(params("*.py", Some(&missing), true)).await;

    assert!(result.is_error);
    assert!(result.message.contains("does not exist"));
}

#[tokio::test]
async fn test_glob_not_a_directory() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);
    let test_file = work_dir.clone() / "test.txt";
    test_file.write_text("content").await.expect("write file");

    let result = tool
        .call_typed(params("*.py", Some(&test_file), true))
        .await;

    assert!(result.is_error);
    assert!(result.message.contains("is not a directory"));
}

#[tokio::test]
async fn test_glob_single_character_wildcard() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool.call_typed(params("?.md", Some(&work_dir), true)).await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert_eq!(output, "");
}

#[tokio::test]
async fn test_glob_max_matches_limit() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);

    for i in 0..MAX_MATCHES + 50 {
        let filename = format!("file_{i}.txt");
        let file = work_dir.clone() / filename.as_str();
        file.write_text(&format!("content {i}"))
            .await
            .expect("write file");
    }

    let result = tool
        .call_typed(params("*.txt", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    let output_lines: Vec<&str> = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    assert_eq!(output_lines.len(), MAX_MATCHES);
    assert!(result.message.contains(&format!(
        "Only the first {MAX_MATCHES} matches are returned"
    )));
}

#[tokio::test]
async fn test_glob_enhanced_double_star_validation() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);

    (work_dir.clone() / "file1.txt")
        .write_text("content1")
        .await
        .expect("write file");
    (work_dir.clone() / "file2.py")
        .write_text("content2")
        .await
        .expect("write file");
    (work_dir.clone() / "src")
        .mkdir(false, true)
        .await
        .expect("mkdir");
    (work_dir.clone() / "docs")
        .mkdir(false, true)
        .await
        .expect("mkdir");

    let result = tool
        .call_typed(params("**/*.txt", Some(&work_dir), true))
        .await;

    assert!(result.is_error);
    assert!(
        result
            .message
            .contains("starts with '**' which is not allowed")
    );
    assert!(
        result
            .message
            .contains("Use more specific patterns instead")
    );
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("file1.txt"));
    assert!(output.contains("file2.py"));
    assert!(output.contains("src"));
    assert!(output.contains("docs"));
}

#[tokio::test]
async fn test_glob_exactly_max_matches() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);

    for i in 0..MAX_MATCHES {
        let filename = format!("test_{i}.py");
        let file = work_dir.clone() / filename.as_str();
        file.write_text(&format!("code {i}"))
            .await
            .expect("write file");
    }

    let result = tool.call_typed(params("*.py", Some(&work_dir), true)).await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    let output_lines: Vec<&str> = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    assert_eq!(output_lines.len(), MAX_MATCHES);
    assert!(!result.message.contains("Only the first"));
    assert!(
        result
            .message
            .contains(&format!("Found {MAX_MATCHES} matches"))
    );
}

#[tokio::test]
async fn test_glob_character_class() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    let tool = Glob::new(&fixture.runtime);

    (work_dir.clone() / "file1.py")
        .write_text("content1")
        .await
        .expect("write file");
    (work_dir.clone() / "file2.py")
        .write_text("content2")
        .await
        .expect("write file");
    (work_dir.clone() / "file3.txt")
        .write_text("content3")
        .await
        .expect("write file");

    let result = tool
        .call_typed(params("file[1-2].py", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert!(output.contains("file1.py"));
    assert!(output.contains("file2.py"));
    assert!(!output.contains("file3.txt"));
}

#[tokio::test]
async fn test_glob_complex_pattern() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("docs/**/main/*.py", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text,
        _ => String::new(),
    };
    assert_eq!(output, "");
}

#[tokio::test]
async fn test_glob_wildcard_with_double_star_patterns() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("**/main/*.py", Some(&work_dir), true))
        .await;

    assert!(result.is_error);
    assert!(
        result
            .message
            .contains("starts with '**' which is not allowed")
    );

    let result = tool
        .call_typed(params("src/**/test_*.py", Some(&work_dir), true))
        .await;

    assert!(!result.is_error);
    let output = match result.output {
        kosong::tooling::ToolOutput::Text(text) => text.replace("\\", "/"),
        _ => String::new(),
    };
    assert!(output.contains("src/test/test_app.py"));
    assert!(output.contains("src/test/test_config.py"));
}

#[tokio::test]
async fn test_glob_pattern_edge_cases() {
    let fixture = RuntimeFixture::new();
    let work_dir = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone();
    setup_test_files(&work_dir).await;
    let tool = Glob::new(&fixture.runtime);

    let result = tool
        .call_typed(params("src/**", Some(&work_dir), true))
        .await;
    assert!(!result.is_error);

    let result = tool.call_typed(params("*.py", Some(&work_dir), true)).await;
    assert!(!result.is_error);

    let result = tool
        .call_typed(params("**/*.txt", Some(&work_dir), true))
        .await;
    assert!(result.is_error);
    assert!(
        result
            .message
            .contains("starts with '**' which is not allowed")
    );
}
