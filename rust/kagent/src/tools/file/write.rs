use kaos::KaosPath;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use kosong::tooling::{CallableTool2, DisplayBlock, ToolOutput, ToolReturnValue, tool_error};

use crate::soul::agent::Runtime;
use crate::tools::utils::tool_rejected_error;
use crate::utils::{build_diff_blocks, is_within_directory};

use super::{
    FILE_ACTION_EDIT, FILE_ACTION_EDIT_OUTSIDE, WRITE_DESC, read_text_lossy, resolve_tool_path,
    validate_absolute_path,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WriteParams {
    #[schemars(
        description = "The path to the file to write. Absolute paths are required when writing files outside the working directory."
    )]
    pub path: String,
    #[schemars(description = "The content to write to the file")]
    pub content: String,
    #[serde(default = "default_write_mode")]
    #[schemars(
        description = "The mode to use to write to the file. Two modes are supported: `overwrite` for overwriting the whole file and `append` for appending to the end of an existing file.",
        default = "default_write_mode"
    )]
    pub mode: WriteMode,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WriteMode {
    Overwrite,
    Append,
}

fn default_write_mode() -> WriteMode {
    WriteMode::Overwrite
}

pub struct WriteFile {
    description: String,
    work_dir: KaosPath,
    approval: std::sync::Arc<crate::soul::approval::Approval>,
}

impl WriteFile {
    pub fn new(runtime: &Runtime) -> Self {
        Self {
            description: WRITE_DESC.to_string(),
            work_dir: runtime.builtin_args.KIMI_WORK_DIR.clone(),
            approval: runtime.approval.clone(),
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for WriteFile {
    type Params = WriteParams;

    fn name(&self) -> &str {
        "WriteFile"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        if params.path.is_empty() {
            return tool_error("", "File path cannot be empty.", "Empty file path");
        }

        let mut path = KaosPath::new(params.path.as_str()).expanduser();
        if let Some(err) = validate_absolute_path(&path, &self.work_dir, "write") {
            return err;
        }
        path = resolve_tool_path(&path, &self.work_dir);

        if !path.parent().exists(true).await {
            return tool_error(
                "",
                format!("`{}` parent directory does not exist.", params.path),
                "Parent directory not found",
            );
        }

        let append = matches!(params.mode, WriteMode::Append);

        let file_existed = path.exists(true).await;
        let old_text = if file_existed {
            read_text_lossy(&path).await.ok()
        } else {
            None
        };

        let new_text = if append {
            format!("{}{}", old_text.clone().unwrap_or_default(), params.content)
        } else {
            params.content.clone()
        };

        let diff_blocks: Vec<DisplayBlock> = build_diff_blocks(
            &path.to_string_lossy(),
            &old_text.unwrap_or_default(),
            &new_text,
        )
        .into_iter()
        .map(DisplayBlock::Diff)
        .collect();

        let action = if is_within_directory(&path, &self.work_dir) {
            FILE_ACTION_EDIT
        } else {
            FILE_ACTION_EDIT_OUTSIDE
        };

        let approved = match self
            .approval
            .request(
                self.name(),
                action,
                &format!("Write file `{}`", path),
                Some(diff_blocks.clone()),
            )
            .await
        {
            Ok(value) => value,
            Err(_) => false,
        };
        if !approved {
            return tool_rejected_error();
        }

        let write_result = if append {
            path.append_text(&params.content).await
        } else {
            path.write_text(&params.content).await
        };
        if let Err(err) = write_result {
            return tool_error(
                "",
                format!("Failed to write to {}. Error: {err}", params.path),
                "Failed to write file",
            );
        }

        let size = path.stat(true).await.map(|s| s.st_size).unwrap_or(0);
        let action = if append { "appended to" } else { "overwritten" };
        ToolReturnValue {
            is_error: false,
            output: ToolOutput::Text(String::new()),
            message: format!("File successfully {action}. Current size: {size} bytes."),
            display: diff_blocks,
            extras: None,
        }
    }
}
