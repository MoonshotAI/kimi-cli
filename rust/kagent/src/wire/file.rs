use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use async_stream::stream;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::error;

use crate::wire::protocol::{WIRE_PROTOCOL_LEGACY_VERSION, WIRE_PROTOCOL_VERSION};
use crate::wire::{WireError, WireMessage, WireMessageEnvelope};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireFileMetadata {
    #[serde(rename = "type")]
    pub kind: String,
    pub protocol_version: String,
}

impl WireFileMetadata {
    pub fn new(protocol_version: &str) -> Self {
        Self {
            kind: "metadata".to_string(),
            protocol_version: protocol_version.to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireMessageRecord {
    pub timestamp: f64,
    pub message: WireMessageEnvelope,
}

impl WireMessageRecord {
    pub fn from_wire_message(msg: &WireMessage, timestamp: f64) -> Result<Self, WireError> {
        Ok(Self {
            timestamp,
            message: WireMessageEnvelope::from_wire_message(msg)?,
        })
    }

    pub fn to_wire_message(&self) -> Result<WireMessage, WireError> {
        self.message.to_wire_message()
    }
}

fn parse_wire_file_metadata(line: &str) -> Option<WireFileMetadata> {
    let metadata: WireFileMetadata = serde_json::from_str(line).ok()?;
    if metadata.kind == "metadata" {
        Some(metadata)
    } else {
        None
    }
}

#[derive(Clone, Debug)]
pub struct WireFile {
    path: PathBuf,
    protocol_version: String,
}

impl WireFile {
    pub fn new(path: PathBuf) -> Self {
        let protocol_version = if path.exists() {
            load_protocol_version(&path).unwrap_or_else(|| WIRE_PROTOCOL_LEGACY_VERSION.to_string())
        } else {
            WIRE_PROTOCOL_VERSION.to_string()
        };
        Self {
            path,
            protocol_version,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn version(&self) -> &str {
        &self.protocol_version
    }

    pub async fn is_empty(&self) -> bool {
        let file = match tokio::fs::File::open(&self.path).await {
            Ok(file) => file,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return true;
                }
                error!(
                    error = ?err,
                    "Failed to read wire file {}:",
                    self.path.display()
                );
                return false;
            }
        };

        let mut lines = BufReader::new(file).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if parse_wire_file_metadata(line).is_some() {
                continue;
            }
            return false;
        }
        true
    }

    pub fn iter_records(&self) -> BoxStream<'static, WireMessageRecord> {
        let path = self.path.clone();
        Box::pin(stream! {
            let file = match tokio::fs::File::open(&path).await {
                Ok(file) => file,
                Err(err) => {
                    if err.kind() == std::io::ErrorKind::NotFound {
                        return;
                    }
                    error!(
                        error = ?err,
                        "Failed to read wire file {}:",
                        path.display()
                    );
                    return;
                }
            };
            let mut lines = BufReader::new(file).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if parse_wire_file_metadata(line).is_some() {
                    continue;
                }
                let record: WireMessageRecord = match serde_json::from_str(line) {
                    Ok(record) => record,
                    Err(err) => {
                        error!(
                            error = ?err,
                            "Failed to parse line in wire file {}:",
                            path.display()
                        );
                        continue;
                    }
                };
                yield record;
            }
        })
    }

    pub async fn append_message(
        &self,
        msg: &WireMessage,
        timestamp: Option<f64>,
    ) -> Result<(), String> {
        let record =
            WireMessageRecord::from_wire_message(msg, timestamp.unwrap_or_else(now_timestamp))
                .map_err(|err| err.to_string())?;
        self.append_record(&record).await?;
        Ok(())
    }

    async fn append_record(&self, record: &WireMessageRecord) -> Result<(), String> {
        let needs_header = match tokio::fs::metadata(&self.path).await {
            Ok(metadata) => metadata.len() == 0,
            Err(_) => true,
        };

        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| err.to_string())?;
        }

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(|err| err.to_string())?;

        if needs_header {
            let metadata = WireFileMetadata::new(&self.protocol_version);
            let line = serde_json::to_string(&metadata).map_err(|err| err.to_string())?;
            file.write_all(line.as_bytes())
                .await
                .map_err(|err| err.to_string())?;
            file.write_all(b"\n").await.map_err(|err| err.to_string())?;
        }

        let line = serde_json::to_string(record).map_err(|err| err.to_string())?;
        file.write_all(line.as_bytes())
            .await
            .map_err(|err| err.to_string())?;
        file.write_all(b"\n").await.map_err(|err| err.to_string())?;
        Ok(())
    }
}

impl std::fmt::Display for WireFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.path.display())
    }
}

fn load_protocol_version(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().flatten() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        return parse_wire_file_metadata(line).map(|meta| meta.protocol_version);
    }
    None
}

fn now_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
