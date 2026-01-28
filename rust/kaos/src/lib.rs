//! KAOS (Kimi Agent Operating System) core abstractions.

pub mod local;
pub mod path;

mod current;

pub use current::{
    CurrentKaosToken, get_current_kaos, reset_current_kaos, set_current_kaos,
    with_current_kaos_scope,
};
pub use local::LocalKaos;
pub use path::KaosPath;

use std::path::PathBuf;
use std::pin::Pin;

use anyhow::Result;
use futures::stream::Stream;

/// A path-like argument accepted by Kaos operations.
pub enum StrOrKaosPath<'a> {
    Str(&'a str),
    KaosPath(&'a KaosPath),
}

/// Async readable stream interface for Kaos process IO.
#[async_trait::async_trait]
pub trait AsyncReadable: Send + Sync {
    async fn read(&mut self, n: usize) -> Result<Vec<u8>>;
    async fn readline(&mut self) -> Result<Vec<u8>>;
    fn is_eof(&self) -> bool;
}

/// Async writable stream interface for Kaos process IO.
#[async_trait::async_trait]
pub trait AsyncWritable: Send + Sync {
    async fn write(&mut self, data: &[u8]) -> Result<()>;
    async fn flush(&mut self) -> Result<()>;
    async fn close(&mut self) -> Result<()>;
}

/// Process handle returned by Kaos exec.
#[async_trait::async_trait]
pub trait KaosProcess: Send + Sync {
    fn pid(&self) -> u32;
    fn returncode(&mut self) -> Option<i32>;
    async fn wait(&mut self) -> Result<i32>;
    async fn kill(&mut self) -> Result<()>;
    fn stdin(&mut self) -> &mut dyn AsyncWritable;
    fn stdout(&mut self) -> &mut dyn AsyncReadable;
    fn stderr(&mut self) -> &mut dyn AsyncReadable;
    fn take_stdout(&mut self) -> Option<Box<dyn AsyncReadable>> {
        None
    }
    fn take_stderr(&mut self) -> Option<Box<dyn AsyncReadable>> {
        None
    }
}

/// Kaos filesystem/process abstraction.
#[async_trait::async_trait]
pub trait Kaos: Send + Sync {
    fn name(&self) -> &str;
    fn normpath(&self, path: &StrOrKaosPath<'_>) -> KaosPath;
    fn home(&self) -> KaosPath;
    fn cwd(&self) -> KaosPath;
    async fn chdir(&self, path: &KaosPath) -> Result<()>;
    async fn stat(&self, path: &KaosPath, follow_symlinks: bool) -> Result<StatResult>;
    async fn iterdir(&self, path: &KaosPath) -> Result<Vec<KaosPath>>;
    async fn glob(
        &self,
        path: &KaosPath,
        pattern: &str,
        case_sensitive: bool,
    ) -> Result<Vec<KaosPath>>;
    async fn read_bytes(&self, path: &KaosPath, limit: Option<usize>) -> Result<Vec<u8>>;
    async fn read_text(&self, path: &KaosPath) -> Result<String>;
    async fn read_lines(&self, path: &KaosPath) -> Result<Vec<String>>;
    async fn read_lines_stream(&self, path: &KaosPath) -> Result<LineStream>;
    async fn write_bytes(&self, path: &KaosPath, data: &[u8]) -> Result<usize>;
    async fn write_text(&self, path: &KaosPath, data: &str, append: bool) -> Result<usize>;
    async fn mkdir(&self, path: &KaosPath, parents: bool, exist_ok: bool) -> Result<()>;
    async fn exec(&self, args: &[String]) -> Result<Box<dyn KaosProcess>>;
}

/// Stat result compatible with Python fields.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct StatResult {
    pub st_mode: u32,
    pub st_ino: u64,
    pub st_dev: u64,
    pub st_nlink: u64,
    pub st_uid: u32,
    pub st_gid: u32,
    pub st_size: u64,
    pub st_atime: f64,
    pub st_mtime: f64,
    pub st_ctime: f64,
}

pub type LineStream = Pin<Box<dyn Stream<Item = Result<String>> + Send>>;

/// Helper to map string/KaosPath to KaosPath.
pub fn normalize_path_arg(arg: &StrOrKaosPath<'_>) -> KaosPath {
    match arg {
        StrOrKaosPath::Str(s) => KaosPath::from(PathBuf::from(s)),
        StrOrKaosPath::KaosPath(p) => (*p).clone(),
    }
}

pub fn normpath(path: &StrOrKaosPath<'_>) -> KaosPath {
    get_current_kaos().normpath(path)
}

pub fn gethome() -> KaosPath {
    get_current_kaos().home()
}

pub fn getcwd() -> KaosPath {
    get_current_kaos().cwd()
}

pub async fn chdir(path: &KaosPath) -> Result<()> {
    get_current_kaos().chdir(path).await
}

pub async fn stat(path: &KaosPath, follow_symlinks: bool) -> Result<StatResult> {
    get_current_kaos().stat(path, follow_symlinks).await
}

pub async fn iterdir(path: &KaosPath) -> Result<Vec<KaosPath>> {
    get_current_kaos().iterdir(path).await
}

pub async fn glob(path: &KaosPath, pattern: &str, case_sensitive: bool) -> Result<Vec<KaosPath>> {
    get_current_kaos().glob(path, pattern, case_sensitive).await
}

pub async fn read_bytes(path: &KaosPath, limit: Option<usize>) -> Result<Vec<u8>> {
    get_current_kaos().read_bytes(path, limit).await
}

pub async fn read_text(path: &KaosPath) -> Result<String> {
    get_current_kaos().read_text(path).await
}

pub async fn read_lines(path: &KaosPath) -> Result<Vec<String>> {
    get_current_kaos().read_lines(path).await
}

pub async fn read_lines_stream(path: &KaosPath) -> Result<LineStream> {
    get_current_kaos().read_lines_stream(path).await
}

pub async fn write_bytes(path: &KaosPath, data: &[u8]) -> Result<usize> {
    get_current_kaos().write_bytes(path, data).await
}

pub async fn write_text(path: &KaosPath, data: &str, append: bool) -> Result<usize> {
    get_current_kaos().write_text(path, data, append).await
}

pub async fn mkdir(path: &KaosPath, parents: bool, exist_ok: bool) -> Result<()> {
    get_current_kaos().mkdir(path, parents, exist_ok).await
}

pub async fn exec(args: &[String]) -> Result<Box<dyn KaosProcess>> {
    get_current_kaos().exec(args).await
}
