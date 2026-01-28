use std::path::PathBuf;

use kagent::utils::list_directory;
use kaos::KaosPath;

#[cfg(unix)]
#[tokio::test]
async fn test_list_directory_unix() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("tempdir");
    let temp_path = KaosPath::from(PathBuf::from(temp.path()));

    (temp_path.clone() / "regular.txt")
        .write_text("hello")
        .await
        .unwrap();
    (temp_path.clone() / "adir")
        .mkdir(true, true)
        .await
        .unwrap();
    (temp_path.clone() / "adir" / "inside.txt")
        .write_text("world")
        .await
        .unwrap();
    (temp_path.clone() / "emptydir")
        .mkdir(true, true)
        .await
        .unwrap();
    let large_path = temp_path.clone() / "largefile.bin";
    large_path
        .write_bytes(&vec![b'x'; 10_000_000])
        .await
        .unwrap();

    let regular = (temp_path.clone() / "regular.txt").unsafe_to_local_path();
    let link_to_regular = (temp_path.clone() / "link_to_regular").unsafe_to_local_path();
    symlink(regular, link_to_regular).unwrap();
    let missing = (temp_path.clone() / "missing.txt").unsafe_to_local_path();
    let link_missing = (temp_path.clone() / "link_to_regular_missing").unsafe_to_local_path();
    symlink(missing, link_missing).unwrap();

    let out = list_directory(&temp_path).await;
    let mut lines: Vec<String> = out
        .lines()
        .map(|line| {
            let mut parts = line.split_whitespace();
            let mode = parts.next().unwrap_or("");
            let _size = parts.next().unwrap_or("");
            let rest = parts.collect::<Vec<_>>().join(" ");
            format!("{mode} {rest}")
        })
        .collect();
    lines.sort();
    let joined = lines.join("\n");

    assert_eq!(
        joined,
        "\
-rw-r--r-- largefile.bin
-rw-r--r-- link_to_regular
-rw-r--r-- regular.txt
?--------- link_to_regular_missing [stat failed]
drwxr-xr-x adir
drwxr-xr-x emptydir"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn test_list_directory_windows() {
    let temp = tempfile::tempdir().expect("tempdir");
    let temp_path = KaosPath::from(PathBuf::from(temp.path()));

    (temp_path.clone() / "regular.txt")
        .write_text("hello")
        .await
        .unwrap();
    (temp_path.clone() / "adir")
        .mkdir(true, true)
        .await
        .unwrap();
    (temp_path.clone() / "adir" / "inside.txt")
        .write_text("world")
        .await
        .unwrap();
    (temp_path.clone() / "emptydir")
        .mkdir(true, true)
        .await
        .unwrap();
    let large_path = temp_path.clone() / "largefile.bin";
    large_path
        .write_bytes(&vec![b'x'; 10_000_000])
        .await
        .unwrap();

    let out = list_directory(&temp_path).await;
    let mut lines: Vec<String> = out.lines().map(|line| line.to_string()).collect();
    lines.sort_by_key(|line| {
        line.split_whitespace()
            .last()
            .unwrap_or_default()
            .to_string()
    });
    let joined = lines.join("\n");

    assert_eq!(
        joined,
        "\
drwxrwxrwx          0 adir
drwxrwxrwx          0 emptydir
-rw-rw-rw-   10000000 largefile.bin
-rw-rw-rw-          5 regular.txt"
    );
}
