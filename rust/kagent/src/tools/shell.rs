use std::time::Duration;

use schemars::JsonSchema;
use serde::Deserialize;

use kaos::{AsyncReadable, KaosPath};
use kosong::tooling::error::tool_runtime_error;
use kosong::tooling::{CallableTool2, DisplayBlock, ShellDisplayBlock, ToolReturnValue};

use crate::soul::approval::Approval;
use crate::tools::utils::{ToolResultBuilder, load_desc, tool_rejected_error};

const DEFAULT_TIMEOUT: i64 = 60;

const BASH_DESC: &str = include_str!("desc/shell/bash.md");
const POWERSHELL_DESC: &str = include_str!("desc/shell/powershell.md");

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellParams {
    #[schemars(description = "The bash command to execute.")]
    pub command: String,
    #[serde(default = "default_timeout")]
    #[schemars(
        description = "The timeout in seconds for the command to execute. If the command takes longer than this, it will be killed.",
        range(min = 1, max = 300),
        default = "default_timeout"
    )]
    pub timeout: i64,
}

fn default_timeout() -> i64 {
    DEFAULT_TIMEOUT
}

pub struct Shell {
    description: String,
    approval: std::sync::Arc<Approval>,
    shell_path: KaosPath,
    is_powershell: bool,
}

impl Shell {
    pub fn new(runtime: &crate::soul::agent::Runtime) -> Self {
        let environment = runtime.environment.clone();
        let is_powershell = environment.shell_name == "Windows PowerShell";
        let shell_label = format!("{} (`{}`)", environment.shell_name, environment.shell_path);
        let template = if is_powershell {
            POWERSHELL_DESC
        } else {
            BASH_DESC
        };
        let desc = load_desc(template, &[("SHELL", shell_label)]);

        Self {
            description: desc,
            approval: runtime.approval.clone(),
            shell_path: environment.shell_path,
            is_powershell,
        }
    }

    async fn read_stream(
        &self,
        stream: &mut dyn AsyncReadable,
        builder: &mut ToolResultBuilder,
    ) -> anyhow::Result<()> {
        loop {
            let line = stream.readline().await?;
            if line.is_empty() {
                break;
            }
            let text = String::from_utf8_lossy(&line);
            builder.write(&text);
        }
        Ok(())
    }

    async fn read_streams(
        &self,
        mut stdout: Option<Box<dyn AsyncReadable>>,
        mut stderr: Option<Box<dyn AsyncReadable>>,
        builder: &mut ToolResultBuilder,
    ) -> anyhow::Result<()> {
        let mut stdout_done = stdout.is_none();
        let mut stderr_done = stderr.is_none();

        while !stdout_done || !stderr_done {
            tokio::select! {
                line = async {
                    match stdout.as_mut() {
                        Some(stream) => stream.readline().await,
                        None => Ok(Vec::new()),
                    }
                }, if !stdout_done => {
                    let line = line?;
                    if line.is_empty() {
                        stdout_done = true;
                    } else {
                        let text = String::from_utf8_lossy(&line);
                        builder.write(&text);
                    }
                }
                line = async {
                    match stderr.as_mut() {
                        Some(stream) => stream.readline().await,
                        None => Ok(Vec::new()),
                    }
                }, if !stderr_done => {
                    let line = line?;
                    if line.is_empty() {
                        stderr_done = true;
                    } else {
                        let text = String::from_utf8_lossy(&line);
                        builder.write(&text);
                    }
                }
            }
        }

        Ok(())
    }

    fn shell_args(&self, command: &str) -> Vec<String> {
        if self.is_powershell {
            vec![
                self.shell_path.to_string_lossy(),
                "-command".to_string(),
                command.to_string(),
            ]
        } else {
            vec![
                self.shell_path.to_string_lossy(),
                "-c".to_string(),
                command.to_string(),
            ]
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for Shell {
    type Params = ShellParams;

    fn name(&self) -> &str {
        "Shell"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let mut builder = ToolResultBuilder::default();

        if params.command.is_empty() {
            return builder.error("Command cannot be empty.", "Empty command");
        }

        let approved = match self
            .approval
            .request(
                self.name(),
                "run command",
                &format!("Run command `{}`", params.command),
                Some(vec![DisplayBlock::Shell(ShellDisplayBlock::new(
                    if self.is_powershell {
                        "powershell"
                    } else {
                        "bash"
                    },
                    params.command.clone(),
                ))]),
            )
            .await
        {
            Ok(value) => value,
            Err(_) => false,
        };

        if !approved {
            return tool_rejected_error();
        }

        let args = self.shell_args(&params.command);
        let mut process = match kaos::exec(&args).await {
            Ok(process) => process,
            Err(err) => return tool_runtime_error(&err.to_string()),
        };

        let stdout = process.take_stdout();
        let stderr = process.take_stderr();

        let read_result = tokio::time::timeout(Duration::from_secs(params.timeout as u64), async {
            match (stdout, stderr) {
                (Some(stdout), Some(stderr)) => {
                    self.read_streams(Some(stdout), Some(stderr), &mut builder)
                        .await
                }
                (Some(stdout), None) => {
                    self.read_streams(Some(stdout), None, &mut builder).await?;
                    self.read_stream(process.stderr(), &mut builder).await
                }
                (None, Some(stderr)) => {
                    self.read_stream(process.stdout(), &mut builder).await?;
                    self.read_streams(None, Some(stderr), &mut builder).await
                }
                (None, None) => {
                    self.read_stream(process.stdout(), &mut builder).await?;
                    self.read_stream(process.stderr(), &mut builder).await
                }
            }
        })
        .await;

        match read_result {
            Ok(Ok(())) => {
                let exitcode = match process.wait().await {
                    Ok(code) => code,
                    Err(err) => return tool_runtime_error(&err.to_string()),
                };
                if exitcode == 0 {
                    builder.ok("Command executed successfully.", "")
                } else {
                    builder.error(
                        &format!("Command failed with exit code: {exitcode}."),
                        &format!("Failed with exit code: {exitcode}"),
                    )
                }
            }
            Ok(Err(err)) => tool_runtime_error(&err.to_string()),
            Err(_) => {
                if let Err(err) = process.kill().await {
                    return tool_runtime_error(&err.to_string());
                }
                builder.error(
                    &format!("Command killed by timeout ({}s)", params.timeout),
                    &format!("Killed by timeout ({}s)", params.timeout),
                )
            }
        }
    }
}
