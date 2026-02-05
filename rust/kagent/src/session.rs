use std::collections::HashSet;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use futures::StreamExt;

use kaos::KaosPath;
use kosong::message::{Message, Role};
use tracing::{debug, error, info, warn};

use crate::metadata::{WorkDirMeta, load_metadata, save_metadata};
use crate::wire::{TurnBegin, UserInput, WireFile, WireMessage};

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub work_dir: KaosPath,
    pub work_dir_meta: WorkDirMeta,
    pub context_file: PathBuf,
    pub wire_file: WireFile,
    pub title: String,
    pub updated_at: f64,
}

impl Session {
    pub fn dir(&self) -> PathBuf {
        self.work_dir_meta.sessions_dir().join(&self.id)
    }

    pub fn wire_file(&self) -> WireFile {
        self.wire_file.clone()
    }

    pub async fn is_empty(&self) -> bool {
        if !self.wire_file.is_empty().await {
            return false;
        }
        match tokio::fs::metadata(&self.context_file).await {
            Ok(metadata) => metadata.len() == 0,
            Err(_) => true,
        }
    }

    pub async fn delete(&self) {
        let dir = self.work_dir_meta.sessions_dir().join(&self.id);
        if tokio::fs::metadata(&dir).await.is_ok() {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }

    pub async fn refresh(&mut self) {
        self.title = format!("Untitled ({})", self.id);
        self.updated_at = file_mtime(&self.context_file).await.unwrap_or(0.0);

        let mut records = self.wire_file.iter_records();
        while let Some(record) = records.next().await {
            let wire_msg = match record.to_wire_message() {
                Ok(msg) => msg,
                Err(err) => {
                    error!(
                        error = ?err,
                        "Failed to parse line in wire file {}:",
                        self.wire_file.path().display()
                    );
                    continue;
                }
            };
            if let WireMessage::TurnBegin(TurnBegin { user_input }) = wire_msg {
                let text = user_input_to_text(&user_input);
                let title = shorten_text(&text, 50);
                self.title = format!("{title} ({})", self.id);
                return;
            }
        }
    }

    pub async fn create(
        work_dir: KaosPath,
        session_id: Option<String>,
        context_file: Option<PathBuf>,
    ) -> Session {
        let work_dir = work_dir.canonical();
        debug!(
            "Creating new session for work directory: {}",
            work_dir.to_string_lossy()
        );
        let mut metadata = load_metadata().await;
        let work_dir_meta = metadata
            .get_work_dir_meta(&work_dir)
            .unwrap_or_else(|| metadata.new_work_dir_meta(&work_dir));

        let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let sessions_dir = work_dir_meta.ensure_sessions_dir().await;
        let session_dir = sessions_dir.join(&session_id);
        tokio::fs::create_dir_all(&session_dir)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "Failed to create session dir {}: {err}",
                    session_dir.display()
                )
            });

        let context_file = if let Some(context_file) = context_file {
            warn!("Using provided context file: {}", context_file.display());
            let parent = context_file
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            tokio::fs::create_dir_all(parent)
                .await
                .unwrap_or_else(|err| {
                    panic!("Failed to create context dir {}: {err}", parent.display())
                });
            if tokio::fs::metadata(&context_file).await.is_ok() {
                warn!(
                    "Context file already exists, truncating: {}",
                    context_file.display()
                );
                tokio::fs::remove_file(&context_file)
                    .await
                    .unwrap_or_else(|err| {
                        panic!(
                            "Failed to remove context file {}: {err}",
                            context_file.display()
                        )
                    });
            }
            context_file
        } else {
            session_dir.join("context.jsonl")
        };
        tokio::fs::File::create(&context_file)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "Failed to create context file {}: {err}",
                    context_file.display()
                )
            });

        save_metadata(&metadata).await;

        let mut session = Session {
            id: session_id,
            work_dir,
            work_dir_meta,
            context_file,
            wire_file: WireFile::new(session_dir.join("wire.jsonl")),
            title: String::new(),
            updated_at: 0.0,
        };
        session.refresh().await;
        session
    }

    pub async fn find(work_dir: KaosPath, session_id: &str) -> Option<Session> {
        let work_dir = work_dir.canonical();
        debug!(
            "Finding session for work directory: {}, session ID: {}",
            work_dir.to_string_lossy(),
            session_id
        );
        let metadata = load_metadata().await;
        let work_dir_meta = match metadata.get_work_dir_meta(&work_dir) {
            Some(meta) => meta,
            None => {
                debug!("Work directory never been used");
                return None;
            }
        };

        let sessions_dir = work_dir_meta.ensure_sessions_dir().await;
        migrate_session_context_file(&sessions_dir, session_id).await;

        let session_dir = sessions_dir.join(session_id);
        if tokio::fs::metadata(&session_dir)
            .await
            .map(|meta| !meta.is_dir())
            .unwrap_or(true)
        {
            debug!("Session directory not found: {}", session_dir.display());
            return None;
        }
        let context_file = session_dir.join("context.jsonl");
        if tokio::fs::metadata(&context_file).await.is_err() {
            debug!("Session context file not found: {}", context_file.display());
            return None;
        }

        let mut session = Session {
            id: session_id.to_string(),
            work_dir,
            work_dir_meta,
            context_file,
            wire_file: WireFile::new(session_dir.join("wire.jsonl")),
            title: String::new(),
            updated_at: 0.0,
        };
        session.refresh().await;
        Some(session)
    }

    pub async fn list(work_dir: KaosPath) -> Vec<Session> {
        let work_dir = work_dir.canonical();
        debug!(
            "Listing sessions for work directory: {}",
            work_dir.to_string_lossy()
        );
        let metadata = load_metadata().await;
        let work_dir_meta = match metadata.get_work_dir_meta(&work_dir) {
            Some(meta) => meta,
            None => {
                debug!("Work directory never been used");
                return Vec::new();
            }
        };

        let sessions_dir = work_dir_meta.ensure_sessions_dir().await;
        let mut session_ids = HashSet::new();
        let mut entries = tokio::fs::read_dir(&sessions_dir)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "Failed to read sessions dir {}: {err}",
                    sessions_dir.display()
                )
            });
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    let path = entry.path();
                    let file_type = match entry.file_type().await {
                        Ok(file_type) => file_type,
                        Err(_) => continue,
                    };
                    if file_type.is_dir() {
                        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                            session_ids.insert(name.to_string());
                        }
                    } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                        if ext == "jsonl" {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                session_ids.insert(stem.to_string());
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    panic!(
                        "Failed to read sessions dir {}: {err}",
                        sessions_dir.display()
                    )
                }
            }
        }

        let mut sessions = Vec::new();
        for session_id in session_ids {
            migrate_session_context_file(&sessions_dir, &session_id).await;
            let session_dir = sessions_dir.join(&session_id);
            if tokio::fs::metadata(&session_dir)
                .await
                .map(|meta| !meta.is_dir())
                .unwrap_or(true)
            {
                debug!("Session directory not found: {}", session_dir.display());
                continue;
            }
            let context_file = session_dir.join("context.jsonl");
            if tokio::fs::metadata(&context_file).await.is_err() {
                debug!("Session context file not found: {}", context_file.display());
                continue;
            }
            let mut session = Session {
                id: session_id,
                work_dir: work_dir.clone(),
                work_dir_meta: work_dir_meta.clone(),
                context_file,
                wire_file: WireFile::new(session_dir.join("wire.jsonl")),
                title: String::new(),
                updated_at: 0.0,
            };
            if session.is_empty().await {
                debug!(
                    "Session context file is empty: {}",
                    session.context_file.display()
                );
                continue;
            }
            session.refresh().await;
            sessions.push(session);
        }

        sessions.sort_by(|a, b| b.updated_at.partial_cmp(&a.updated_at).unwrap());
        sessions
    }

    pub async fn continue_(work_dir: KaosPath) -> Option<Session> {
        let work_dir = work_dir.canonical();
        debug!(
            "Continuing session for work directory: {}",
            work_dir.to_string_lossy()
        );
        let metadata = load_metadata().await;
        let work_dir_meta = match metadata.get_work_dir_meta(&work_dir) {
            Some(meta) => meta,
            None => {
                debug!("Work directory never been used");
                return None;
            }
        };
        let session_id = match work_dir_meta.last_session_id {
            Some(session_id) => session_id,
            None => {
                debug!("Work directory never had a session");
                return None;
            }
        };
        debug!("Found last session for work directory: {}", session_id);
        Session::find(work_dir, &session_id).await
    }
}

async fn migrate_session_context_file(sessions_dir: &PathBuf, session_id: &str) {
    let old_context_file = sessions_dir.join(format!("{session_id}.jsonl"));
    let new_context_file = sessions_dir.join(session_id).join("context.jsonl");
    if tokio::fs::metadata(&old_context_file).await.is_ok()
        && tokio::fs::metadata(&new_context_file).await.is_err()
    {
        if let Some(parent) = new_context_file.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .unwrap_or_else(|err| {
                    panic!(
                        "Failed to create session context dir {}: {err}",
                        parent.display()
                    )
                });
        }
        tokio::fs::rename(&old_context_file, &new_context_file)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "Failed to migrate session context file {}: {err}",
                    old_context_file.display()
                )
            });
        info!(
            "Migrated session context file from {} to {}",
            old_context_file.display(),
            new_context_file.display()
        );
    }
}

fn user_input_to_text(user_input: &UserInput) -> String {
    match user_input {
        UserInput::Text(text) => text.clone(),
        UserInput::Parts(parts) => {
            let message = Message::new(Role::User, parts.clone());
            message.extract_text(" ")
        }
    }
}

fn shorten_text(text: &str, width: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    if collapsed.len() <= width {
        return collapsed;
    }
    let placeholder = "...";
    if width <= placeholder.len() {
        return placeholder.to_string();
    }
    let target = width - placeholder.len();
    let mut last_space = None;
    for (idx, ch) in collapsed.char_indices() {
        if idx > target {
            break;
        }
        if ch.is_whitespace() {
            last_space = Some(idx);
        }
    }
    let cut = last_space.unwrap_or(0);
    if cut == 0 {
        return placeholder.to_string();
    }
    format!("{}{}", &collapsed[..cut], placeholder)
}

async fn file_mtime(path: &PathBuf) -> Option<f64> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let modified = metadata.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
    )
}
