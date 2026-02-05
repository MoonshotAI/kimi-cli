use kaos::KaosPath;
use schemars::JsonSchema;
use serde::Deserialize;

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error, tool_ok};

use crate::soul::agent::Runtime;
use crate::tools::utils::load_desc;
use crate::utils::{is_within_directory, list_directory};

use super::{GLOB_DESC, MAX_MATCHES};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GlobParams {
    #[schemars(description = "Glob pattern to match files/directories.")]
    pub pattern: String,
    #[serde(default)]
    #[schemars(
        description = "Absolute path to the directory to search in (defaults to working directory)."
    )]
    pub directory: Option<String>,
    #[serde(default = "default_include_dirs")]
    #[schemars(
        description = "Whether to include directories in results.",
        default = "default_include_dirs"
    )]
    pub include_dirs: bool,
}

fn default_include_dirs() -> bool {
    true
}

pub struct Glob {
    description: String,
    work_dir: KaosPath,
}

impl Glob {
    pub fn new(runtime: &Runtime) -> Self {
        let desc = load_desc(GLOB_DESC, &[("MAX_MATCHES", MAX_MATCHES.to_string())]);
        Self {
            description: desc,
            work_dir: runtime.builtin_args.KIMI_WORK_DIR.clone(),
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for Glob {
    type Params = GlobParams;

    fn name(&self) -> &str {
        "Glob"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        if params.pattern.starts_with("**") {
            let listing = list_directory(&self.work_dir).await;
            return tool_error(
                listing,
                format!(
                    "Pattern `{}` starts with '**' which is not allowed. This would recursively search all directories and may include large directories like `node_modules`. Use more specific patterns instead. For your convenience, a list of all files and directories in the top level of the working directory is provided below.",
                    params.pattern
                ),
                "Unsafe pattern",
            );
        }

        let dir = if let Some(directory) = params.directory.as_deref() {
            KaosPath::new(directory).expanduser()
        } else {
            self.work_dir.clone()
        };

        if !dir.is_absolute() {
            return tool_error(
                "",
                format!(
                    "`{}` is not an absolute path. You must provide an absolute path to search.",
                    params.directory.unwrap_or_default()
                ),
                "Invalid directory",
            );
        }

        let resolved = dir.canonical();
        if !is_within_directory(&resolved, &self.work_dir) {
            return tool_error(
                "",
                format!(
                    "`{}` is outside the working directory. You can only search within the working directory.",
                    dir
                ),
                "Directory outside working directory",
            );
        }

        if !dir.exists(true).await {
            return tool_error(
                "",
                format!("`{}` does not exist.", params.directory.unwrap_or_default()),
                "Directory not found",
            );
        }
        if !dir.is_dir(true).await {
            return tool_error(
                "",
                format!(
                    "`{}` is not a directory.",
                    params.directory.unwrap_or_default()
                ),
                "Invalid directory",
            );
        }

        let matches = match dir.glob(&params.pattern, true).await {
            Ok(matches) => matches,
            Err(err) => {
                return tool_error(
                    "",
                    format!(
                        "Failed to search for pattern {}. Error: {err}",
                        params.pattern
                    ),
                    "Glob failed",
                );
            }
        };

        let mut filtered = Vec::new();
        for entry in matches {
            if params.include_dirs || entry.is_file(true).await {
                filtered.push(entry);
            }
        }
        filtered.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));

        let mut message = if filtered.is_empty() {
            format!("No matches found for pattern `{}`.", params.pattern)
        } else {
            format!(
                "Found {} matches for pattern `{}`.",
                filtered.len(),
                params.pattern
            )
        };

        if filtered.len() > MAX_MATCHES {
            filtered.truncate(MAX_MATCHES);
            message.push_str(&format!(
                " Only the first {MAX_MATCHES} matches are returned. You may want to use a more specific pattern."
            ));
        }

        let mut output_lines = Vec::new();
        for entry in filtered {
            if let Ok(relative) = entry.relative_to(&dir) {
                output_lines.push(relative.to_string_lossy());
            } else {
                output_lines.push(entry.to_string_lossy());
            }
        }

        tool_ok(output_lines.join("\n"), message, "")
    }
}
