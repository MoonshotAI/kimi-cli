use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tracing::debug;

use kaos::{Kaos, KaosPath, LocalKaos, get_current_kaos};

use crate::share::{ensure_share_dir, get_share_dir};

pub fn get_metadata_file() -> PathBuf {
    get_share_dir().join("kimi.json")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkDirMeta {
    pub path: String,
    #[serde(default = "default_kaos_name")]
    pub kaos: String,
    #[serde(default)]
    pub last_session_id: Option<String>,
}

impl WorkDirMeta {
    pub fn sessions_dir(&self) -> PathBuf {
        let hash = md5::compute(self.path.as_bytes());
        let hash_hex = format!("{:x}", hash);
        let dir_basename = if self.kaos == default_kaos_name() {
            hash_hex
        } else {
            format!("{}_{}", self.kaos, hash_hex)
        };
        get_share_dir().join("sessions").join(dir_basename)
    }

    pub async fn ensure_sessions_dir(&self) -> PathBuf {
        let dir = self.sessions_dir();
        tokio::fs::create_dir_all(&dir)
            .await
            .unwrap_or_else(|err| panic!("Failed to create sessions dir {}: {err}", dir.display()));
        dir
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Metadata {
    #[serde(default)]
    pub work_dirs: Vec<WorkDirMeta>,
}

impl Metadata {
    pub fn get_work_dir_meta(&self, path: &KaosPath) -> Option<WorkDirMeta> {
        let kaos_name = get_current_kaos().name().to_string();
        self.work_dirs
            .iter()
            .find(|wd| wd.path == path.to_string() && wd.kaos == kaos_name)
            .cloned()
    }

    pub fn new_work_dir_meta(&mut self, path: &KaosPath) -> WorkDirMeta {
        let meta = WorkDirMeta {
            path: path.to_string(),
            kaos: get_current_kaos().name().to_string(),
            last_session_id: None,
        };
        self.work_dirs.push(meta.clone());
        meta
    }
}

pub async fn load_metadata() -> Metadata {
    let _ = ensure_share_dir().await;
    let metadata_file = get_metadata_file();
    debug!("Loading metadata from file: {}", metadata_file.display());
    if tokio::fs::metadata(&metadata_file).await.is_err() {
        debug!("No metadata file found, creating empty metadata");
        return Metadata::default();
    }
    let text = tokio::fs::read_to_string(&metadata_file)
        .await
        .unwrap_or_else(|err| {
            panic!(
                "Failed to read metadata file {}: {err}",
                metadata_file.display()
            )
        });
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("Invalid metadata file {}: {err}", metadata_file.display()))
}

pub async fn save_metadata(metadata: &Metadata) {
    let metadata_file = get_metadata_file();
    debug!("Saving metadata to file: {}", metadata_file.display());
    if let Some(parent) = metadata_file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .unwrap_or_else(|err| {
                panic!("Failed to create metadata dir {}: {err}", parent.display())
            });
    }
    let text = serde_json::to_string_pretty(metadata).unwrap_or_else(|err| {
        panic!(
            "Failed to serialize metadata file {}: {err}",
            metadata_file.display()
        )
    });
    tokio::fs::write(&metadata_file, text)
        .await
        .unwrap_or_else(|err| {
            panic!(
                "Failed to write metadata file {}: {err}",
                metadata_file.display()
            )
        });
}

fn default_kaos_name() -> String {
    LocalKaos::new().name().to_string()
}
