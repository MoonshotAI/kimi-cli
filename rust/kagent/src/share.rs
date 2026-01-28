use std::path::PathBuf;

pub fn get_share_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("KIMI_SHARE_DIR") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    dirs::home_dir()
        .expect("HOME directory is not available")
        .join(".kimi")
}

pub async fn ensure_share_dir() -> PathBuf {
    let dir = get_share_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .unwrap_or_else(|err| panic!("Failed to create share dir {}: {err}", dir.display()));
    dir
}
