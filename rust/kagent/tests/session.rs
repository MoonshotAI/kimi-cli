use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use filetime::FileTime;
use serde_json::json;
use tempfile::TempDir;

use kagent::session::Session;
use kagent::wire::{
    TextPart, TurnBegin, UserInput, WIRE_PROTOCOL_VERSION, WireFileMetadata, WireMessage,
    WireMessageRecord,
};
use kaos::KaosPath;
use kosong::message::ContentPart;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    key: &'static str,
    prev: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let prev = std::env::var(key).ok();
        // SAFETY: tests serialize env access via ENV_LOCK to avoid races.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(prev) = &self.prev {
            // SAFETY: tests serialize env access via ENV_LOCK to avoid races.
            unsafe {
                std::env::set_var(self.key, prev);
            }
        } else {
            // SAFETY: tests serialize env access via ENV_LOCK to avoid races.
            unsafe {
                std::env::remove_var(self.key);
            }
        }
    }
}

fn set_home_env(path: &Path) -> Vec<EnvGuard> {
    let share_dir = path.join(".kimi");
    vec![
        EnvGuard::set("HOME", path.to_str().expect("home path")),
        EnvGuard::set("USERPROFILE", path.to_str().expect("home path")),
        EnvGuard::set(
            "KIMI_SHARE_DIR",
            share_dir.to_str().expect("share dir path"),
        ),
    ]
}

fn write_wire_turn(session_dir: &Path, text: &str) {
    let wire_file = session_dir.join("wire.jsonl");
    if let Some(parent) = wire_file.parent() {
        std::fs::create_dir_all(parent).expect("create wire dir");
    }
    let metadata = WireFileMetadata::new(WIRE_PROTOCOL_VERSION);
    let msg = WireMessage::TurnBegin(TurnBegin {
        user_input: UserInput::Parts(vec![ContentPart::Text(TextPart::new(text))]),
    });
    let record = WireMessageRecord::from_wire_message(&msg, 1.0).expect("wire record");
    let meta_line = serde_json::to_string(&metadata).expect("serialize metadata");
    let line = serde_json::to_string(&record).expect("serialize wire record");
    std::fs::write(&wire_file, format!("{meta_line}\n{line}\n")).expect("write wire file");
}

fn write_wire_metadata(session_dir: &Path) {
    let wire_file = session_dir.join("wire.jsonl");
    if let Some(parent) = wire_file.parent() {
        std::fs::create_dir_all(parent).expect("create wire dir");
    }
    let metadata = WireFileMetadata::new(WIRE_PROTOCOL_VERSION);
    let meta_line = serde_json::to_string(&metadata).expect("serialize metadata");
    std::fs::write(&wire_file, format!("{meta_line}\n")).expect("write wire file");
}

fn write_context_message(context_file: &Path, text: &str) {
    if let Some(parent) = context_file.parent() {
        std::fs::create_dir_all(parent).expect("create context dir");
    }
    let line = json!({
        "role": "user",
        "content": [{"type": "text", "text": text}]
    })
    .to_string();
    std::fs::write(context_file, format!("{line}\n")).expect("write context file");
}

#[tokio::test]
async fn test_create_sets_fallback_title() {
    let _lock = ENV_LOCK.lock().unwrap();
    let home_dir = TempDir::new().expect("home dir");
    let _env = set_home_env(home_dir.path());

    let work_dir = TempDir::new().expect("work dir");
    let work_path = KaosPath::from(work_dir.path().to_path_buf());

    let session = Session::create(work_path, None, None).await;
    assert!(session.title.starts_with("Untitled ("));
    assert!(session.context_file.exists());
}

#[tokio::test]
async fn test_find_uses_wire_title() {
    let _lock = ENV_LOCK.lock().unwrap();
    let home_dir = TempDir::new().expect("home dir");
    let _env = set_home_env(home_dir.path());

    let work_dir = TempDir::new().expect("work dir");
    let work_path = KaosPath::from(work_dir.path().to_path_buf());

    let session = Session::create(work_path.clone(), None, None).await;
    write_wire_turn(&session.dir(), "hello world from wire file");

    let found = Session::find(work_path, &session.id).await;
    assert!(found.is_some());
    assert!(
        found
            .expect("session")
            .title
            .starts_with("hello world from wire file")
    );
}

#[tokio::test]
async fn test_list_sorts_by_updated_and_titles() {
    let _lock = ENV_LOCK.lock().unwrap();
    let home_dir = TempDir::new().expect("home dir");
    let _env = set_home_env(home_dir.path());

    let work_dir = TempDir::new().expect("work dir");
    let work_path = KaosPath::from(work_dir.path().to_path_buf());

    let first = Session::create(work_path.clone(), None, None).await;
    let second = Session::create(work_path.clone(), None, None).await;

    write_context_message(&first.context_file, "old context message");
    write_context_message(&second.context_file, "new context message");
    write_wire_turn(&first.dir(), "old session title");
    write_wire_turn(&second.dir(), "new session title that is slightly longer");

    let now = SystemTime::now();
    let old = now - Duration::from_secs(10);
    filetime::set_file_mtime(&first.context_file, FileTime::from_system_time(old))
        .expect("set old mtime");
    filetime::set_file_mtime(&second.context_file, FileTime::from_system_time(now))
        .expect("set new mtime");

    let sessions = Session::list(work_path).await;

    assert_eq!(sessions[0].id, second.id);
    assert_eq!(sessions[1].id, first.id);
    assert!(sessions[0].title.starts_with("new session title"));
    assert!(sessions[1].title.starts_with("old session title"));
}

#[tokio::test]
async fn test_continue_without_last_returns_none() {
    let _lock = ENV_LOCK.lock().unwrap();
    let home_dir = TempDir::new().expect("home dir");
    let _env = set_home_env(home_dir.path());

    let work_dir = TempDir::new().expect("work dir");
    let work_path = KaosPath::from(work_dir.path().to_path_buf());

    let result = Session::continue_(work_path).await;
    assert!(result.is_none());
}

#[tokio::test]
async fn test_list_ignores_empty_sessions() {
    let _lock = ENV_LOCK.lock().unwrap();
    let home_dir = TempDir::new().expect("home dir");
    let _env = set_home_env(home_dir.path());

    let work_dir = TempDir::new().expect("work dir");
    let work_path = KaosPath::from(work_dir.path().to_path_buf());

    let empty = Session::create(work_path.clone(), None, None).await;
    let populated = Session::create(work_path.clone(), None, None).await;

    write_wire_metadata(&empty.dir());
    write_context_message(&populated.context_file, "persisted user message");
    write_wire_turn(&populated.dir(), "populated session");

    let sessions = Session::list(work_path).await;

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, populated.id);
    assert!(sessions.iter().all(|session| session.id != empty.id));
}

#[tokio::test]
async fn test_create_named_session() {
    let _lock = ENV_LOCK.lock().unwrap();
    let home_dir = TempDir::new().expect("home dir");
    let _env = set_home_env(home_dir.path());

    let work_dir = TempDir::new().expect("work dir");
    let work_path = KaosPath::from(work_dir.path().to_path_buf());

    let session_id = "my-named-session".to_string();
    let session = Session::create(work_path.clone(), Some(session_id.clone()), None).await;

    assert_eq!(session.id, session_id);
    let dir_name = session
        .dir()
        .file_name()
        .expect("session dir")
        .to_string_lossy()
        .to_string();
    assert_eq!(dir_name, session.id);

    let found = Session::find(work_path, &session.id).await;
    assert!(found.is_some());
    assert_eq!(found.expect("session").id, session.id);
}
