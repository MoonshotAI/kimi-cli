use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use futures::StreamExt;
use schemars::JsonSchema;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::{debug, error, info};

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error};

use crate::share::get_share_dir;
use crate::soul::agent::Runtime;
use crate::tools::utils::ToolResultBuilder;

use super::GREP_DESC;

const RG_VERSION: &str = "15.0.0";
const RG_BASE_URL: &str = "http://cdn.kimi.com/binaries/kimi-cli/rg";

static RG_DOWNLOAD_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GrepParams {
    #[schemars(description = "The regular expression pattern to search for in file contents")]
    pub pattern: String,
    #[serde(default = "default_grep_path")]
    #[schemars(
        description = "File or directory to search in. Defaults to current working directory. If specified, it must be an absolute path.",
        default = "default_grep_path"
    )]
    pub path: String,
    #[serde(default)]
    #[schemars(
        description = "Glob pattern to filter files (e.g. `*.js`, `*.{ts,tsx}`). No filter by default."
    )]
    pub glob: Option<String>,
    #[serde(default = "default_output_mode")]
    #[schemars(
        description = "`content`: Show matching lines (supports `-B`, `-A`, `-C`, `-n`, `head_limit`); `files_with_matches`: Show file paths (supports `head_limit`); `count_matches`: Show total number of matches. Defaults to `files_with_matches`.",
        default = "default_output_mode"
    )]
    pub output_mode: String,
    #[serde(default, rename = "-B")]
    #[schemars(
        description = "Number of lines to show before each match (the `-B` option). Requires `output_mode` to be `content`."
    )]
    pub before_context: Option<i64>,
    #[serde(default, rename = "-A")]
    #[schemars(
        description = "Number of lines to show after each match (the `-A` option). Requires `output_mode` to be `content`."
    )]
    pub after_context: Option<i64>,
    #[serde(default, rename = "-C")]
    #[schemars(
        description = "Number of lines to show before and after each match (the `-C` option). Requires `output_mode` to be `content`."
    )]
    pub context: Option<i64>,
    #[serde(default, rename = "-n")]
    #[schemars(
        description = "Show line numbers in output (the `-n` option). Requires `output_mode` to be `content`."
    )]
    pub line_number: bool,
    #[serde(default, rename = "-i")]
    #[schemars(description = "Case insensitive search (the `-i` option).")]
    pub ignore_case: bool,
    #[serde(default, rename = "type")]
    #[schemars(
        description = "File type to search. Examples: py, rust, js, ts, go, java, etc. More efficient than `glob` for standard file types."
    )]
    pub file_type: Option<String>,
    #[serde(default)]
    #[schemars(
        description = "Limit output to first N lines, equivalent to `| head -N`. Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count_matches (limits count entries). By default, no limit is applied."
    )]
    pub head_limit: Option<i64>,
    #[serde(default)]
    #[schemars(
        description = "Enable multiline mode where `.` matches newlines and patterns can span lines (the `-U` and `--multiline-dotall` options). By default, multiline mode is disabled."
    )]
    pub multiline: bool,
}

fn default_grep_path() -> String {
    ".".to_string()
}

fn default_output_mode() -> String {
    "files_with_matches".to_string()
}

pub struct Grep {
    description: String,
}

impl Grep {
    pub fn new(_runtime: &Runtime) -> Self {
        Self {
            description: GREP_DESC.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for Grep {
    type Params = GrepParams;

    fn name(&self) -> &str {
        "Grep"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let mut builder = ToolResultBuilder::default();
        let rg_path = match ensure_rg_path().await {
            Ok(path) => path,
            Err(err) => {
                return tool_error(
                    "",
                    format!("Failed to locate ripgrep binary. Error: {err}"),
                    "Failed to grep",
                );
            }
        };

        let mut command = Command::new(&rg_path);
        if params.ignore_case {
            command.arg("-i");
        }
        if params.multiline {
            command.arg("-U");
            command.arg("--multiline-dotall");
        }
        if params.output_mode == "content" {
            if let Some(before) = params.before_context {
                command.arg("-B").arg(before.to_string());
            }
            if let Some(after) = params.after_context {
                command.arg("-A").arg(after.to_string());
            }
            if let Some(context) = params.context {
                command.arg("-C").arg(context.to_string());
            }
            if params.line_number {
                command.arg("-n");
            }
        }
        if let Some(glob) = &params.glob {
            command.arg("-g").arg(glob);
        }
        if let Some(file_type) = &params.file_type {
            command.arg("--type").arg(file_type);
        }

        if params.output_mode == "files_with_matches" {
            command.arg("-l");
        } else if params.output_mode == "count_matches" {
            command.arg("-c");
        }

        if params.pattern.starts_with('-') {
            command.arg("--");
        }
        command.arg(&params.pattern);
        command.arg(&params.path);

        let output = match command.output().await {
            Ok(output) => output,
            Err(err) => {
                return tool_error(
                    "",
                    format!("Failed to grep. Error: {err}"),
                    "Failed to grep",
                );
            }
        };

        if !output.status.success() && output.status.code() != Some(1) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = if stderr.trim().is_empty() {
                format!(
                    "Failed to grep. Exit status: {}",
                    output.status.code().unwrap_or(-1)
                )
            } else {
                format!("Failed to grep. Error: {stderr}")
            };
            return tool_error("", message, "Failed to grep");
        }

        let mut output_text = String::from_utf8_lossy(&output.stdout).to_string();
        if output_text.is_empty() {
            return builder.ok("No matches found", "");
        }

        let mut message = String::new();
        if let Some(limit) = params.head_limit {
            let limit = limit.max(0) as usize;
            let lines: Vec<&str> = output_text.split('\n').collect();
            if lines.len() > limit {
                let mut truncated = lines[..limit].join("\n");
                truncated.push_str(&format!("\n... (results truncated to {limit} lines)"));
                output_text = truncated;
                message = format!("Results truncated to first {limit} lines");
            }
        }

        builder.write(&output_text);
        builder.ok(&message, "")
    }
}

fn rg_download_lock() -> &'static tokio::sync::Mutex<()> {
    RG_DOWNLOAD_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn rg_binary_name() -> &'static str {
    if cfg!(windows) { "rg.exe" } else { "rg" }
}

fn find_existing_rg(bin_name: &str) -> Option<PathBuf> {
    let share_bin = get_share_dir().join("bin").join(bin_name);
    if share_bin.is_file() {
        return Some(share_bin);
    }

    if let Some(local_dep) = find_local_dep(bin_name) {
        return Some(local_dep);
    }

    find_on_path(bin_name)
}

fn find_local_dep(bin_name: &str) -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let local_dep = manifest_dir
        .join("src")
        .join("deps")
        .join("bin")
        .join(bin_name);
    if local_dep.is_file() {
        return Some(local_dep);
    }

    let exe_dep = std::env::current_exe().ok().and_then(|exe| {
        exe.parent()
            .map(|parent| parent.join("deps").join("bin").join(bin_name))
    });
    if let Some(path) = exe_dep {
        if path.is_file() {
            return Some(path);
        }
    }

    None
}

fn find_on_path(bin_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_var) {
        let candidate = path.join(bin_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn detect_target() -> Option<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" | "amd64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        other => {
            error!("Unsupported architecture for ripgrep: {}", other);
            return None;
        }
    };

    let os = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => {
            if arch == "x86_64" {
                "unknown-linux-musl"
            } else {
                "unknown-linux-gnu"
            }
        }
        "windows" => "pc-windows-msvc",
        other => {
            error!("Unsupported operating system for ripgrep: {}", other);
            return None;
        }
    };

    Some(format!("{arch}-{os}"))
}

async fn ensure_rg_path() -> Result<PathBuf, String> {
    let bin_name = rg_binary_name();
    if let Some(existing) = find_existing_rg(bin_name) {
        debug!("Using ripgrep binary: {}", existing.display());
        return Ok(existing);
    }

    let _guard = rg_download_lock().lock().await;
    if let Some(existing) = find_existing_rg(bin_name) {
        debug!("Using ripgrep binary: {}", existing.display());
        return Ok(existing);
    }

    download_and_install_rg(bin_name).await
}

async fn download_and_install_rg(bin_name: &str) -> Result<PathBuf, String> {
    let target =
        detect_target().ok_or_else(|| "Unsupported platform for ripgrep download".to_string())?;
    let is_windows = target.contains("windows");
    let archive_ext = if is_windows { "zip" } else { "tar.gz" };
    let filename = format!("ripgrep-{RG_VERSION}-{target}.{archive_ext}");
    let url = format!("{RG_BASE_URL}/{filename}");
    info!("Downloading ripgrep from {}", url);

    let temp_dir = std::env::temp_dir().join(format!("kimi-rg-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;
    let archive_path = temp_dir.join(&filename);

    let response = reqwest::get(&url)
        .await
        .map_err(|err| format!("Failed to download ripgrep: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download ripgrep: HTTP {}",
            response.status()
        ));
    }

    let mut file = tokio::fs::File::create(&archive_path)
        .await
        .map_err(|err| format!("Failed to create download file: {err}"))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("Failed to download ripgrep: {err}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("Failed to write download: {err}"))?;
    }

    let share_bin = get_share_dir().join("bin");
    tokio::fs::create_dir_all(&share_bin)
        .await
        .map_err(|err| format!("Failed to create share bin dir: {err}"))?;
    let destination = share_bin.join(bin_name);

    let bin_name_owned = bin_name.to_string();
    let archive_bytes = tokio::fs::read(&archive_path)
        .await
        .map_err(|err| format!("Failed to read ripgrep archive: {err}"))?;
    let bin_bytes = tokio::task::spawn_blocking(move || {
        if is_windows {
            extract_zip_bytes(&archive_bytes, &bin_name_owned)
        } else {
            extract_tar_bytes(&archive_bytes, &bin_name_owned)
        }
    })
    .await
    .map_err(|err| format!("Failed to extract ripgrep: {err}"))?
    .map_err(|err| format!("Failed to extract ripgrep: {err}"))?;

    tokio::fs::write(&destination, bin_bytes)
        .await
        .map_err(|err| format!("Failed to write ripgrep binary: {err}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&destination)
            .await
            .map_err(|err| format!("Failed to read permissions: {err}"))?
            .permissions();
        perms.set_mode(perms.mode() | 0o111);
        tokio::fs::set_permissions(&destination, perms)
            .await
            .map_err(|err| format!("Failed to set permissions: {err}"))?;
    }

    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    info!("Installed ripgrep to {}", destination.display());

    Ok(destination)
}

fn extract_zip_bytes(archive_bytes: &[u8], bin_name: &str) -> Result<Vec<u8>, String> {
    let reader = std::io::Cursor::new(archive_bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|err| format!("Failed to read zip archive: {err}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|err| format!("Failed to read zip entry: {err}"))?;
        let entry_name = entry.name();
        if Path::new(entry_name)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(bin_name)
        {
            let mut buf = Vec::new();
            std::io::copy(&mut entry, &mut buf)
                .map_err(|err| format!("Failed to extract ripgrep: {err}"))?;
            return Ok(buf);
        }
    }

    Err("Ripgrep binary not found in archive".to_string())
}

fn extract_tar_bytes(archive_bytes: &[u8], bin_name: &str) -> Result<Vec<u8>, String> {
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(archive_bytes));
    let mut archive = tar::Archive::new(decoder);

    let mut entries = archive
        .entries()
        .map_err(|err| format!("Failed to read tar archive: {err}"))?;
    while let Some(entry) = entries.next() {
        let mut entry = entry.map_err(|err| format!("Failed to read tar entry: {err}"))?;
        let path = entry
            .path()
            .map_err(|err| format!("Failed to read tar entry path: {err}"))?;
        if path.file_name().and_then(|name| name.to_str()) == Some(bin_name) {
            let mut buf = Vec::new();
            std::io::copy(&mut entry, &mut buf)
                .map_err(|err| format!("Failed to extract ripgrep: {err}"))?;
            return Ok(buf);
        }
    }

    Err("Ripgrep binary not found in archive".to_string())
}
