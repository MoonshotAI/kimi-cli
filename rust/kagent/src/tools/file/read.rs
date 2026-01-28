use futures::StreamExt;
use kaos::KaosPath;
use schemars::JsonSchema;
use serde::Deserialize;

use kosong::tooling::error::tool_validate_error;
use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error, tool_ok};

use crate::soul::agent::Runtime;
use crate::tools::utils::{load_desc, truncate_line};

use super::{
    FileKind, MAX_BYTES, MAX_LINE_LENGTH, MAX_LINES, MEDIA_SNIFF_BYTES, READ_DESC,
    detect_file_type, resolve_tool_path, validate_absolute_path,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadParams {
    #[schemars(
        description = "The path to the file to read. Absolute paths are required when reading files outside the working directory."
    )]
    pub path: String,
    #[serde(default = "default_line_offset")]
    #[schemars(
        description = "The line number to start reading from. By default read from the beginning of the file. Set this when the file is too large to read at once.",
        range(min = 1),
        default = "default_line_offset"
    )]
    pub line_offset: i64,
    #[serde(default = "default_n_lines")]
    #[schemars(
        description = "The number of lines to read. By default read up to 1000 lines, which is the max allowed value. Set this value when the file is too large to read at once.",
        range(min = 1),
        default = "default_n_lines"
    )]
    pub n_lines: i64,
}

fn default_line_offset() -> i64 {
    1
}

fn default_n_lines() -> i64 {
    MAX_LINES as i64
}

pub struct ReadFile {
    description: String,
    work_dir: KaosPath,
}

impl ReadFile {
    pub fn new(runtime: &Runtime) -> Self {
        let desc = load_desc(
            READ_DESC,
            &[
                ("MAX_LINES", MAX_LINES.to_string()),
                ("MAX_LINE_LENGTH", MAX_LINE_LENGTH.to_string()),
                ("MAX_BYTES", MAX_BYTES.to_string()),
            ],
        );
        Self {
            description: desc,
            work_dir: runtime.builtin_args.KIMI_WORK_DIR.clone(),
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for ReadFile {
    type Params = ReadParams;

    fn name(&self) -> &str {
        "ReadFile"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        if params.line_offset < 1 {
            return tool_validate_error("line_offset must be >= 1");
        }
        if params.n_lines < 1 {
            return tool_validate_error("n_lines must be >= 1");
        }
        if params.path.is_empty() {
            return tool_error("", "File path cannot be empty.", "Empty file path");
        }

        let mut path = KaosPath::new(params.path.as_str()).expanduser();
        if let Some(err) = validate_absolute_path(&path, &self.work_dir, "read") {
            return err;
        }
        path = resolve_tool_path(&path, &self.work_dir);

        if !path.exists(true).await {
            return tool_error(
                "",
                format!("`{}` does not exist.", params.path),
                "File not found",
            );
        }
        if !path.is_file(true).await {
            return tool_error(
                "",
                format!("`{}` is not a file.", params.path),
                "Invalid path",
            );
        }

        let header = match path.read_bytes(Some(MEDIA_SNIFF_BYTES)).await {
            Ok(bytes) => bytes,
            Err(err) => {
                return tool_error(
                    "",
                    format!("Failed to read {}. Error: {err}", params.path),
                    "Failed to read file",
                );
            }
        };
        let file_type = detect_file_type(&path.to_string_lossy(), Some(&header));
        match file_type.kind {
            FileKind::Image => {
                return tool_error(
                    "",
                    format!(
                        "`{}` is a image file. Use other appropriate tools to read image or video files.",
                        params.path
                    ),
                    "Unsupported file type",
                );
            }
            FileKind::Video => {
                return tool_error(
                    "",
                    format!(
                        "`{}` is a video file. Use other appropriate tools to read image or video files.",
                        params.path
                    ),
                    "Unsupported file type",
                );
            }
            FileKind::Unknown => {
                return tool_error(
                    "",
                    format!(
                        "`{}` seems not readable. You may need to read it with proper shell commands, Python tools or MCP tools if available. If you read/operate it with Python, you MUST ensure that any third-party packages are installed in a virtual environment (venv).",
                        params.path
                    ),
                    "File not readable",
                );
            }
            FileKind::Text => {}
        }

        let mut lines = Vec::new();
        let mut truncated_lines = Vec::new();
        let mut n_bytes = 0usize;
        let mut max_lines_reached = false;
        let mut max_bytes_reached = false;
        let mut current_line = 0usize;

        let mut stream = match path.read_lines_stream().await {
            Ok(stream) => stream,
            Err(err) => {
                return tool_error(
                    "",
                    format!("Failed to read {}. Error: {err}", params.path),
                    "Failed to read file",
                );
            }
        };

        while let Some(line) = stream.next().await {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    return tool_error(
                        "",
                        format!("Failed to read {}. Error: {err}", params.path),
                        "Failed to read file",
                    );
                }
            };
            if line.is_empty() {
                continue;
            }
            current_line += 1;
            if current_line < params.line_offset as usize {
                continue;
            }
            let truncated = truncate_line(&line, MAX_LINE_LENGTH, "...");
            if truncated != line {
                truncated_lines.push(current_line);
            }
            lines.push(truncated.clone());
            n_bytes += truncated.as_bytes().len();
            if lines.len() >= params.n_lines as usize {
                break;
            }
            if lines.len() >= MAX_LINES {
                max_lines_reached = true;
                break;
            }
            if n_bytes >= MAX_BYTES {
                max_bytes_reached = true;
                break;
            }
        }

        let mut numbered = Vec::new();
        for (idx, line) in lines.iter().enumerate() {
            let line_no = params.line_offset as usize + idx;
            numbered.push(format!("{line_no:6}\t{line}"));
        }

        let mut message = if lines.is_empty() {
            "No lines read from file.".to_string()
        } else {
            format!(
                "{} lines read from file starting from line {}.",
                lines.len(),
                params.line_offset
            )
        };

        if max_lines_reached {
            message.push_str(&format!(" Max {MAX_LINES} lines reached."));
        } else if max_bytes_reached {
            message.push_str(&format!(" Max {MAX_BYTES} bytes reached."));
        } else if lines.len() < params.n_lines as usize {
            message.push_str(" End of file reached.");
        }
        if !truncated_lines.is_empty() {
            message.push_str(&format!(" Lines {:?} were truncated.", truncated_lines));
        }

        tool_ok(numbered.join(""), message, "")
    }
}
