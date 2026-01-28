use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

use anyhow::{Result, anyhow};

use crate::{
    LineStream, StatResult, StrOrKaosPath, get_current_kaos, normalize_path_arg, normpath,
};

#[derive(Clone, Eq, PartialEq, Hash)]
pub struct KaosPath {
    path: PathBuf,
}

impl KaosPath {
    pub fn new<P: Into<PathBuf>>(path: P) -> Self {
        Self { path: path.into() }
    }

    pub fn from(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn unsafe_from_local_path(path: &Path) -> Self {
        Self::from(path.to_path_buf())
    }

    pub fn unsafe_to_local_path(&self) -> PathBuf {
        self.path.clone()
    }

    pub fn as_path(&self) -> &Path {
        &self.path
    }

    pub fn name(&self) -> String {
        self.path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    pub fn parent(&self) -> KaosPath {
        if let Some(parent) = self.path.parent() {
            return KaosPath::from(parent.to_path_buf());
        }
        if self.is_absolute() {
            return self.clone();
        }
        KaosPath::from(PathBuf::from("."))
    }

    pub fn is_absolute(&self) -> bool {
        self.path.is_absolute()
    }

    pub fn joinpath(&self, other: &str) -> Self {
        Self::from(self.path.join(other))
    }

    pub fn canonical(&self) -> KaosPath {
        let abs = if self.is_absolute() {
            self.clone()
        } else {
            let cwd = get_current_kaos().cwd();
            KaosPath::from(cwd.as_path().join(&self.path))
        };
        normpath(&StrOrKaosPath::KaosPath(&abs))
    }

    pub fn relative_to(&self, other: &KaosPath) -> Result<KaosPath> {
        let relative = self
            .path
            .strip_prefix(&other.path)
            .map_err(|err| anyhow!(err))?;
        Ok(KaosPath::from(relative.to_path_buf()))
    }

    pub fn home() -> KaosPath {
        get_current_kaos().home()
    }

    pub fn cwd() -> KaosPath {
        get_current_kaos().cwd()
    }

    pub fn expanduser(&self) -> KaosPath {
        let mut components = self.path.components();
        match components.next() {
            Some(Component::Normal(part)) if part == OsStr::new("~") => {
                let mut expanded = KaosPath::home().path;
                for comp in components {
                    expanded.push(comp.as_os_str());
                }
                KaosPath::from(expanded)
            }
            _ => self.clone(),
        }
    }

    pub async fn stat(&self, follow_symlinks: bool) -> Result<StatResult> {
        get_current_kaos().stat(self, follow_symlinks).await
    }

    pub async fn exists(&self, follow_symlinks: bool) -> bool {
        self.stat(follow_symlinks).await.is_ok()
    }

    pub async fn is_file(&self, follow_symlinks: bool) -> bool {
        match self.stat(follow_symlinks).await {
            Ok(stat) => mode_is_file(stat.st_mode),
            Err(_) => false,
        }
    }

    pub async fn is_dir(&self, follow_symlinks: bool) -> bool {
        match self.stat(follow_symlinks).await {
            Ok(stat) => mode_is_dir(stat.st_mode),
            Err(_) => false,
        }
    }

    pub async fn iterdir(&self) -> Result<Vec<KaosPath>> {
        get_current_kaos().iterdir(self).await
    }

    pub async fn glob(&self, pattern: &str, case_sensitive: bool) -> Result<Vec<KaosPath>> {
        get_current_kaos().glob(self, pattern, case_sensitive).await
    }

    pub async fn read_bytes(&self, limit: Option<usize>) -> Result<Vec<u8>> {
        get_current_kaos().read_bytes(self, limit).await
    }

    pub async fn read_text(&self) -> Result<String> {
        get_current_kaos().read_text(self).await
    }

    pub async fn read_lines(&self) -> Result<Vec<String>> {
        get_current_kaos().read_lines(self).await
    }

    pub async fn read_lines_stream(&self) -> Result<LineStream> {
        get_current_kaos().read_lines_stream(self).await
    }

    pub async fn write_bytes(&self, data: &[u8]) -> Result<usize> {
        get_current_kaos().write_bytes(self, data).await
    }

    pub async fn write_text(&self, data: &str) -> Result<usize> {
        get_current_kaos().write_text(self, data, false).await
    }

    pub async fn append_text(&self, data: &str) -> Result<usize> {
        get_current_kaos().write_text(self, data, true).await
    }

    pub async fn mkdir(&self, parents: bool, exist_ok: bool) -> Result<()> {
        get_current_kaos().mkdir(self, parents, exist_ok).await
    }

    pub fn to_string_lossy(&self) -> String {
        self.path.to_string_lossy().to_string()
    }
}

impl fmt::Debug for KaosPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "KaosPath({:?})", self.path)
    }
}

impl fmt::Display for KaosPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.path.to_string_lossy())
    }
}

impl From<&str> for KaosPath {
    fn from(value: &str) -> Self {
        KaosPath::new(PathBuf::from(value))
    }
}

impl From<PathBuf> for KaosPath {
    fn from(value: PathBuf) -> Self {
        KaosPath::new(value)
    }
}

impl From<&Path> for KaosPath {
    fn from(value: &Path) -> Self {
        KaosPath::new(value.to_path_buf())
    }
}

impl std::ops::Div<&str> for KaosPath {
    type Output = KaosPath;

    fn div(self, rhs: &str) -> Self::Output {
        self.joinpath(rhs)
    }
}

impl std::ops::Div<&KaosPath> for KaosPath {
    type Output = KaosPath;

    fn div(self, rhs: &KaosPath) -> Self::Output {
        self.joinpath(&rhs.to_string_lossy())
    }
}

pub fn normalize_path(arg: &crate::StrOrKaosPath<'_>) -> KaosPath {
    normalize_path_arg(arg)
}

fn mode_is_dir(mode: u32) -> bool {
    (mode & 0o170000) == 0o040000
}

fn mode_is_file(mode: u32) -> bool {
    (mode & 0o170000) == 0o100000
}
