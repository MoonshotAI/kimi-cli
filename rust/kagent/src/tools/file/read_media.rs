use std::collections::HashSet;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::GenericImageView;
use schemars::JsonSchema;
use serde::Deserialize;

use kaos::KaosPath;
use kosong::chat_provider::kimi::Kimi;
use kosong::message::{ContentPart, ImageURLPart, VideoURLPart};
use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error, tool_ok};

use crate::config::ModelCapability;
use crate::llm::LLM;
use crate::soul::agent::Runtime;
use crate::tools::SkipThisTool;
use crate::utils::wrap_media_part;

use super::{
    FileKind, FileType, MAX_MEDIA_MEGABYTES, MEDIA_SNIFF_BYTES, READ_MEDIA_DESC, detect_file_type,
    resolve_tool_path, validate_absolute_path,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadMediaParams {
    #[schemars(
        description = "The path to the file to read. Absolute paths are required when reading files outside the working directory."
    )]
    pub path: String,
}

pub struct ReadMediaFile {
    description: String,
    work_dir: KaosPath,
    capabilities: HashSet<ModelCapability>,
    llm: Option<std::sync::Arc<LLM>>,
}

impl ReadMediaFile {
    pub fn new(runtime: &Runtime) -> Result<Self, SkipThisTool> {
        let llm = runtime.llm.clone();
        let capabilities = llm
            .as_ref()
            .map(|llm| llm.capabilities.clone())
            .unwrap_or_default();
        if !capabilities.contains(&ModelCapability::ImageIn)
            && !capabilities.contains(&ModelCapability::VideoIn)
        {
            return Err(SkipThisTool);
        }

        let desc = render_read_media_description(MAX_MEDIA_MEGABYTES, &capabilities);
        Ok(Self {
            description: desc,
            work_dir: runtime.builtin_args.KIMI_WORK_DIR.clone(),
            capabilities,
            llm,
        })
    }

    async fn read_media(&self, path: &KaosPath, file_type: &FileType) -> ToolReturnValue {
        let media_path = path.to_string_lossy();
        let attrs = [("path", Some(media_path.as_ref()))];
        let stat = match path.stat(true).await {
            Ok(stat) => stat,
            Err(err) => {
                return tool_error(
                    "",
                    format!("Failed to read {}. Error: {err}", path),
                    "Failed to read file",
                );
            }
        };
        let size = stat.st_size as usize;
        if size == 0 {
            return tool_error("", format!("`{}` is empty.", path), "Empty file");
        }
        if size > (MAX_MEDIA_MEGABYTES << 20) {
            return tool_error(
                "",
                format!(
                    "`{}` is {} bytes, which exceeds the max {}MB bytes for media files.",
                    path, size, MAX_MEDIA_MEGABYTES
                ),
                "File too large",
            );
        }

        match file_type.kind {
            FileKind::Image => {
                let data = match path.read_bytes(None).await {
                    Ok(bytes) => bytes,
                    Err(err) => {
                        return tool_error(
                            "",
                            format!("Failed to read {}. Error: {err}", path),
                            "Failed to read file",
                        );
                    }
                };
                let data_url = to_data_url(&file_type.mime_type, &data);
                let part = ImageURLPart::new(data_url);
                let wrapped = wrap_media_part(ContentPart::from(part), "image", &attrs);
                let image_size = extract_image_size(&data);
                let size_hint = image_size
                    .map(|(w, h)| format!(", original size {w}x{h}px"))
                    .unwrap_or_default();
                let note = " If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size; if you generate or edit images/videos via commands or scripts, read the result back immediately before continuing.";
                let message = format!(
                    "Loaded image file `{}` ({}, {} bytes{}).{}",
                    path, file_type.mime_type, size, size_hint, note
                );
                return tool_ok(wrapped, message, "");
            }
            FileKind::Video => {
                let data = match path.read_bytes(None).await {
                    Ok(bytes) => bytes,
                    Err(err) => {
                        return tool_error(
                            "",
                            format!("Failed to read {}. Error: {err}", path),
                            "Failed to read file",
                        );
                    }
                };

                let video_part = if let Some(llm) = &self.llm {
                    if let Some(kimi) = llm.chat_provider.as_any().downcast_ref::<Kimi>() {
                        match kimi
                            .files()
                            .upload_video(data.clone(), &file_type.mime_type)
                            .await
                        {
                            Ok(part) => part,
                            Err(err) => {
                                return tool_error(
                                    "",
                                    format!("Failed to read {}. Error: {err}", path),
                                    "Failed to read file",
                                );
                            }
                        }
                    } else {
                        VideoURLPart::new(to_data_url(&file_type.mime_type, &data))
                    }
                } else {
                    VideoURLPart::new(to_data_url(&file_type.mime_type, &data))
                };
                let wrapped = wrap_media_part(ContentPart::from(video_part), "video", &attrs);

                let note = " If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size; if you generate or edit images/videos via commands or scripts, read the result back immediately before continuing.";
                let message = format!(
                    "Loaded video file `{}` ({}, {} bytes).{}",
                    path, file_type.mime_type, size, note
                );
                return tool_ok(wrapped, message, "");
            }
            _ => {}
        }

        tool_error("", "Unsupported media file", "Unsupported file type")
    }
}

#[async_trait::async_trait]
impl CallableTool2 for ReadMediaFile {
    type Params = ReadMediaParams;

    fn name(&self) -> &str {
        "ReadMediaFile"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
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
            FileKind::Text => {
                return tool_error(
                    "",
                    format!(
                        "`{}` is a text file. Use ReadFile to read text files.",
                        params.path
                    ),
                    "Unsupported file type",
                );
            }
            FileKind::Unknown => {
                return tool_error(
                    "",
                    format!(
                        "`{}` seems not readable as an image or video file. You may need to read it with proper shell commands, Python tools or MCP tools if available. If you read/operate it with Python, you MUST ensure that any third-party packages are installed in a virtual environment (venv).",
                        params.path
                    ),
                    "File not readable",
                );
            }
            FileKind::Image => {
                if !self.capabilities.contains(&ModelCapability::ImageIn) {
                    return tool_error(
                        "",
                        "The current model does not support image input. Tell the user to use a model with image input capability.",
                        "Unsupported media type",
                    );
                }
            }
            FileKind::Video => {
                if !self.capabilities.contains(&ModelCapability::VideoIn) {
                    return tool_error(
                        "",
                        "The current model does not support video input. Tell the user to use a model with video input capability.",
                        "Unsupported media type",
                    );
                }
            }
        }

        self.read_media(&path, &file_type).await
    }
}

fn render_read_media_description(max_mb: usize, capabilities: &HashSet<ModelCapability>) -> String {
    let desc = READ_MEDIA_DESC.replace("${MAX_MEDIA_MEGABYTES}", &max_mb.to_string());

    let image = capabilities.contains(&ModelCapability::ImageIn);
    let video = capabilities.contains(&ModelCapability::VideoIn);

    let capability_lines = if image && video {
        "- This tool supports image and video files for the current model."
    } else if image {
        "- This tool supports image files for the current model.\n- Video files are not supported by the current model."
    } else if video {
        "- This tool supports video files for the current model.\n- Image files are not supported by the current model."
    } else {
        "- The current model does not support image or video input."
    };

    let mut output = String::new();
    for line in desc.lines() {
        if line.starts_with("{%") {
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }

    let marker = "**Capabilities**\n";
    if let Some(idx) = output.find(marker) {
        let prefix = output[..idx + marker.len()].to_string();
        return format!("{prefix}{capability_lines}\n");
    }

    output.push_str("**Capabilities**\n");
    output.push_str(capability_lines);
    output.push('\n');
    output
}

fn to_data_url(mime_type: &str, data: &[u8]) -> String {
    let encoded = BASE64.encode(data);
    format!("data:{mime_type};base64,{encoded}")
}

fn extract_image_size(data: &[u8]) -> Option<(u32, u32)> {
    let image = image::load_from_memory(data).ok()?;
    Some(image.dimensions())
}
