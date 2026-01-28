use std::sync::Arc;

use kaos::KaosPath;
use serde_json::Value;

use crate::exception::InvalidToolError;
use crate::soul::agent::Runtime;
use crate::soul::toolset::KimiToolset;
use crate::utils::shorten_middle;

use kosong::tooling::CallableTool;

pub mod utils;

pub mod dmail;
pub mod file;
pub mod multiagent;
pub mod shell;
pub mod test;
pub mod think;
pub mod todo;
pub mod web;

#[derive(Debug)]
pub struct SkipThisTool;

pub struct ToolDeps<'a> {
    pub runtime: &'a Runtime,
    pub toolset: Arc<tokio::sync::Mutex<KimiToolset>>,
}

impl<'a> ToolDeps<'a> {
    pub fn new(runtime: &'a Runtime, toolset: Arc<tokio::sync::Mutex<KimiToolset>>) -> Self {
        Self { runtime, toolset }
    }
}

pub fn load_tool(
    tool_path: &str,
    deps: &ToolDeps<'_>,
) -> Result<Option<Arc<dyn CallableTool>>, InvalidToolError> {
    match tool_path {
        "kimi_cli.tools.shell:Shell" => Ok(Some(Arc::new(shell::Shell::new(deps.runtime)))),
        "kimi_cli.tools.file:ReadFile" => Ok(Some(Arc::new(file::ReadFile::new(deps.runtime)))),
        "kimi_cli.tools.file:ReadMediaFile" => match file::ReadMediaFile::new(deps.runtime) {
            Ok(tool) => Ok(Some(Arc::new(tool))),
            Err(SkipThisTool) => Ok(None),
        },
        "kimi_cli.tools.file:Glob" => Ok(Some(Arc::new(file::Glob::new(deps.runtime)))),
        "kimi_cli.tools.file:Grep" => Ok(Some(Arc::new(file::Grep::new(deps.runtime)))),
        "kimi_cli.tools.file:WriteFile" => Ok(Some(Arc::new(file::WriteFile::new(deps.runtime)))),
        "kimi_cli.tools.file:StrReplaceFile" => {
            Ok(Some(Arc::new(file::StrReplaceFile::new(deps.runtime))))
        }
        "kimi_cli.tools.web:SearchWeb" => match web::SearchWeb::new(deps.runtime) {
            Ok(tool) => Ok(Some(Arc::new(tool))),
            Err(SkipThisTool) => Ok(None),
        },
        "kimi_cli.tools.web:FetchURL" => Ok(Some(Arc::new(web::FetchURL::new(deps.runtime)))),
        "kimi_cli.tools.todo:SetTodoList" => {
            Ok(Some(Arc::new(todo::SetTodoList::new(deps.runtime))))
        }
        "kimi_cli.tools.multiagent:Task" => {
            Ok(Some(Arc::new(multiagent::TaskTool::new(deps.runtime))))
        }
        "kimi_cli.tools.multiagent:CreateSubagent" => Ok(Some(Arc::new(
            multiagent::CreateSubagent::new(Arc::clone(&deps.toolset), deps.runtime),
        ))),
        "kimi_cli.tools.dmail:SendDMail" => Ok(Some(Arc::new(dmail::SendDMail::new(deps.runtime)))),
        "kimi_cli.tools.think:Think" => Ok(Some(Arc::new(think::Think::new(deps.runtime)))),
        "kimi_cli.tools.test:Plus" => Ok(Some(Arc::new(test::Plus))),
        "kimi_cli.tools.test:Compare" => Ok(Some(Arc::new(test::Compare))),
        "kimi_cli.tools.test:Panic" => Ok(Some(Arc::new(test::Panic))),
        _ => Err(InvalidToolError::new(format!("Invalid tool: {tool_path}"))),
    }
}

pub fn extract_key_argument(json_content: &str, tool_name: &str) -> Option<String> {
    let is_known = matches!(
        tool_name,
        "Task"
            | "CreateSubagent"
            | "SendDMail"
            | "Think"
            | "SetTodoList"
            | "Shell"
            | "ReadFile"
            | "ReadMediaFile"
            | "WriteFile"
            | "StrReplaceFile"
            | "Glob"
            | "Grep"
            | "SearchWeb"
            | "FetchURL"
    );

    if !is_known {
        return Some(shorten_middle(json_content, 50, true));
    }

    let value: Value = serde_json::from_str(json_content).ok()?;
    if value.is_null() {
        return None;
    }
    let key_argument = match tool_name {
        "Task" => value.get("description")?.as_str()?.to_string(),
        "CreateSubagent" => value.get("name")?.as_str()?.to_string(),
        "SendDMail" => return None,
        "Think" => value.get("thought")?.as_str()?.to_string(),
        "SetTodoList" => return None,
        "Shell" => value.get("command")?.as_str()?.to_string(),
        "ReadFile" | "ReadMediaFile" | "WriteFile" | "StrReplaceFile" => {
            let path = value.get("path")?.as_str()?;
            normalize_path(path)
        }
        "Glob" => value.get("pattern")?.as_str()?.to_string(),
        "Grep" => value.get("pattern")?.as_str()?.to_string(),
        "SearchWeb" => value.get("query")?.as_str()?.to_string(),
        "FetchURL" => value.get("url")?.as_str()?.to_string(),
        _ => json_content.to_string(),
    };

    Some(shorten_middle(&key_argument, 50, true))
}

fn normalize_path(path: &str) -> String {
    let cwd = KaosPath::cwd().canonical();
    let cwd_str = cwd.to_string_lossy();
    if path.starts_with(&cwd_str) {
        path[cwd_str.len()..]
            .trim_start_matches(['/', '\\'])
            .to_string()
    } else {
        path.to_string()
    }
}
