use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct AgentSpecError {
    message: String,
}

impl AgentSpecError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct SystemPromptTemplateError {
    message: String,
}

impl SystemPromptTemplateError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct InvalidToolError {
    message: String,
}

impl InvalidToolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct MCPConfigError {
    message: String,
}

impl MCPConfigError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct MCPRuntimeError {
    message: String,
}

impl MCPRuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum KimiCliError {
    #[error("config error: {0}")]
    Config(String),
    #[error("agent spec error: {0}")]
    AgentSpec(String),
    #[error("system prompt template error: {0}")]
    SystemPromptTemplate(String),
    #[error("invalid tool: {0}")]
    InvalidTool(String),
    #[error("mcp config error: {0}")]
    McpConfig(String),
    #[error("mcp runtime error: {0}")]
    McpRuntime(String),
}

impl From<ConfigError> for KimiCliError {
    fn from(err: ConfigError) -> Self {
        KimiCliError::Config(err.to_string())
    }
}

impl From<AgentSpecError> for KimiCliError {
    fn from(err: AgentSpecError) -> Self {
        KimiCliError::AgentSpec(err.to_string())
    }
}

impl From<SystemPromptTemplateError> for KimiCliError {
    fn from(err: SystemPromptTemplateError) -> Self {
        KimiCliError::SystemPromptTemplate(err.to_string())
    }
}

impl From<InvalidToolError> for KimiCliError {
    fn from(err: InvalidToolError) -> Self {
        KimiCliError::InvalidTool(err.to_string())
    }
}

impl From<MCPConfigError> for KimiCliError {
    fn from(err: MCPConfigError) -> Self {
        KimiCliError::McpConfig(err.to_string())
    }
}

impl From<MCPRuntimeError> for KimiCliError {
    fn from(err: MCPRuntimeError) -> Self {
        KimiCliError::McpRuntime(err.to_string())
    }
}
