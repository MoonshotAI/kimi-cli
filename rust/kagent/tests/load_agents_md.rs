use tempfile::TempDir;

use kagent::soul::agent::load_agents_md;
use kaos::KaosPath;

#[tokio::test]
async fn test_load_agents_md_found() {
    let dir = TempDir::new().expect("temp dir");
    let work_dir = KaosPath::unsafe_from_local_path(dir.path());
    let agents_md = work_dir.clone() / "AGENTS.md";
    agents_md
        .write_text("Test agents content")
        .await
        .expect("write agents md");

    let content = load_agents_md(&work_dir).await;

    assert_eq!(content.as_deref(), Some("Test agents content"));
}

#[tokio::test]
async fn test_load_agents_md_not_found() {
    let dir = TempDir::new().expect("temp dir");
    let work_dir = KaosPath::unsafe_from_local_path(dir.path());

    let content = load_agents_md(&work_dir).await;

    assert!(content.is_none());
}

#[tokio::test]
async fn test_load_agents_md_lowercase() {
    let dir = TempDir::new().expect("temp dir");
    let work_dir = KaosPath::unsafe_from_local_path(dir.path());
    let agents_md = work_dir.clone() / "agents.md";
    agents_md
        .write_text("Lowercase agents content")
        .await
        .expect("write agents md");

    let content = load_agents_md(&work_dir).await;

    assert_eq!(content.as_deref(), Some("Lowercase agents content"));
}
