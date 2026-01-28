use std::collections::HashSet;

use kagent::utils::next_available_rotation;

#[tokio::test]
async fn test_next_available_rotation_empty_dir() {
    let temp = tempfile::tempdir().expect("tempdir");
    let test_file = temp.path().join("test.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("test_1.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_no_existing_rotations() {
    let temp = tempfile::tempdir().expect("tempdir");
    let test_file = temp.path().join("test.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("test_1.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_with_existing_rotations() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("test_1.txt"), "content1").unwrap();
    std::fs::write(temp.path().join("test_2.txt"), "content2").unwrap();
    std::fs::write(temp.path().join("test_5.txt"), "content5").unwrap();

    let test_file = temp.path().join("test.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("test_6.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_mixed_files() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("test_1.txt"), "content1").unwrap();
    std::fs::write(temp.path().join("test_3.txt"), "content3").unwrap();
    std::fs::write(temp.path().join("other_file.txt"), "other").unwrap();
    std::fs::write(temp.path().join("test_backup.txt"), "backup").unwrap();
    std::fs::write(temp.path().join("different_2.txt"), "different").unwrap();

    let test_file = temp.path().join("test.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("test_4.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_different_extensions() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("document_1.pdf"), "pdf1").unwrap();
    std::fs::write(temp.path().join("document_2.pdf"), "pdf2").unwrap();
    std::fs::write(temp.path().join("document.txt"), "txt").unwrap();

    let test_file = temp.path().join("document.pdf");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("document_3.pdf")));
}

#[tokio::test]
async fn test_next_available_rotation_complex_name() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("my-backup_file.tar_1.gz"), "backup1").unwrap();
    std::fs::write(temp.path().join("my-backup_file.tar_3.gz"), "backup3").unwrap();

    let test_file = temp.path().join("my-backup_file.tar.gz");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("my-backup_file.tar_4.gz")));
}

#[tokio::test]
async fn test_next_available_rotation_parent_not_exists() {
    let temp = tempfile::tempdir().expect("tempdir");
    let missing_parent = temp.path().join("missing");
    let test_file = missing_parent.join("test.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, None);
}

#[tokio::test]
async fn test_next_available_rotation_zero_padding() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("test_01.txt"), "padded1").unwrap();
    std::fs::write(temp.path().join("test_007.txt"), "padded7").unwrap();
    std::fs::write(temp.path().join("test_5.txt"), "normal5").unwrap();

    let test_file = temp.path().join("test.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("test_8.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_large_numbers() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("log_999.txt"), "log999").unwrap();
    std::fs::write(temp.path().join("log_1000.txt"), "log1000").unwrap();
    std::fs::write(temp.path().join("log_1500.txt"), "log1500").unwrap();

    let test_file = temp.path().join("log.txt");
    let result = next_available_rotation(&test_file).await;

    assert_eq!(result, Some(temp.path().join("log_1501.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_directory_with_suffix() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(temp.path().join("backup_1")).unwrap();
    std::fs::create_dir(temp.path().join("backup_2")).unwrap();
    std::fs::create_dir(temp.path().join("backup_5")).unwrap();

    let test_dir = temp.path().join("backup");
    let result = next_available_rotation(&test_dir).await;

    assert_eq!(result, Some(temp.path().join("backup_6")));
}

#[tokio::test]
async fn test_next_available_rotation_directory_empty_suffix() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(temp.path().join("data_1")).unwrap();
    std::fs::create_dir(temp.path().join("data_3")).unwrap();

    let test_dir = temp.path().join("data");
    let result = next_available_rotation(&test_dir).await;

    assert_eq!(result, Some(temp.path().join("data_4")));
}

#[tokio::test]
async fn test_next_available_rotation_directory_with_extension() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(temp.path().join("config_1.backup")).unwrap();
    std::fs::create_dir(temp.path().join("config_2.backup")).unwrap();

    let test_dir = temp.path().join("config.backup");
    let result = next_available_rotation(&test_dir).await;

    assert_eq!(result, Some(temp.path().join("config_3.backup")));
}

#[tokio::test]
async fn test_next_available_rotation_mixed_files_and_dirs() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("archive_1.txt"), "file1").unwrap();
    std::fs::create_dir(temp.path().join("archive_2")).unwrap();
    std::fs::write(temp.path().join("archive_3.txt"), "file3").unwrap();

    let test_path = temp.path().join("archive.txt");
    let result = next_available_rotation(&test_path).await;

    assert_eq!(result, Some(temp.path().join("archive_4.txt")));
}

#[tokio::test]
async fn test_next_available_rotation_directory_pattern_with_extension() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(temp.path().join("my_1.data")).unwrap();
    std::fs::create_dir(temp.path().join("my_2.data")).unwrap();
    std::fs::create_dir(temp.path().join("my_3.data")).unwrap();

    let test_dir = temp.path().join("my.data");
    let result = next_available_rotation(&test_dir).await;

    assert_eq!(result, Some(temp.path().join("my_4.data")));
}

#[tokio::test]
async fn test_next_available_rotation_creates_placeholder() {
    let temp = tempfile::tempdir().expect("tempdir");
    let target = temp.path().join("log.txt");
    let reserved = next_available_rotation(&target).await;

    assert_eq!(reserved, Some(temp.path().join("log_1.txt")));
    assert!(reserved.unwrap().exists());
}

#[tokio::test]
async fn test_next_available_rotation_concurrent_calls() {
    let temp = tempfile::tempdir().expect("tempdir");
    let target = temp.path().join("events.log");

    let futures = (0..5).map(|_| next_available_rotation(&target));
    let results: Vec<_> = futures::future::join_all(futures).await;

    let mut names = HashSet::new();
    for item in results {
        let path = item.expect("rotation path");
        names.insert(path.file_name().unwrap().to_string_lossy().to_string());
    }

    assert_eq!(
        names,
        HashSet::from([
            "events_1.log".to_string(),
            "events_2.log".to_string(),
            "events_3.log".to_string(),
            "events_4.log".to_string(),
            "events_5.log".to_string(),
        ])
    );
}
