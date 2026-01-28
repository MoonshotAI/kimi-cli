use std::fs;

use kagent::utils::read_frontmatter;
use serde_yaml::{Number, Value};

#[tokio::test]
async fn test_read_frontmatter_parses_yaml() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let path = temp_dir.path().join("frontmatter.md");
    fs::write(
        &path,
        "---\nname: test-skill\ndescription: A test skill\nextra: 123\n---\n\n# Body\n",
    )
    .expect("write frontmatter");

    let data = read_frontmatter(&path)
        .await
        .expect("frontmatter parse")
        .expect("frontmatter data");

    assert_eq!(
        data.get("name"),
        Some(&Value::String("test-skill".to_string()))
    );
    assert_eq!(
        data.get("description"),
        Some(&Value::String("A test skill".to_string()))
    );
    assert_eq!(data.get("extra"), Some(&Value::Number(Number::from(123))));
}

#[tokio::test]
async fn test_read_frontmatter_invalid_yaml() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let path = temp_dir.path().join("frontmatter.md");
    fs::write(&path, "---\nname: \"unterminated\ndescription: oops\n---\n")
        .expect("write frontmatter");

    let err = read_frontmatter(&path)
        .await
        .expect_err("invalid frontmatter");
    assert_eq!(err, "Invalid frontmatter YAML.");
}
