use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rmcp::transport::auth::{AuthError, CredentialStore, StoredCredentials};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::exception::MCPConfigError;
use crate::share::get_share_dir;

pub fn get_global_mcp_config_file() -> PathBuf {
    get_share_dir().join("mcp.json")
}

pub async fn load_mcp_config_file(path: &Path) -> Result<Value, MCPConfigError> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|err| MCPConfigError::new(format!("Failed to read MCP config file: {err}")))?;
    load_mcp_config_string(&text)
}

pub fn load_mcp_config_string(text: &str) -> Result<Value, MCPConfigError> {
    let mut value: Value = serde_json::from_str(text)
        .map_err(|err| MCPConfigError::new(format!("Invalid JSON: {err}")))?;
    ensure_mcp_servers(&mut value)?;
    Ok(value)
}

pub fn ensure_mcp_servers(value: &mut Value) -> Result<&mut Map<String, Value>, MCPConfigError> {
    let map = value
        .as_object_mut()
        .ok_or_else(|| MCPConfigError::new("MCP config must be a JSON object"))?;
    if !map.contains_key("mcpServers") {
        map.insert("mcpServers".to_string(), json!({}));
    }
    let servers = map
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| MCPConfigError::new("mcpServers must be a JSON object"))?;
    Ok(servers)
}

pub async fn save_mcp_config(value: &Value) -> Result<(), MCPConfigError> {
    let path = get_global_mcp_config_file();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|err| {
            MCPConfigError::new(format!("Failed to create MCP config dir: {err}"))
        })?;
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|err| MCPConfigError::new(format!("Failed to serialize MCP config: {err}")))?;
    tokio::fs::write(path, text)
        .await
        .map_err(|err| MCPConfigError::new(format!("Failed to write MCP config file: {err}")))?;
    Ok(())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct McpCredentialFile {
    #[serde(default)]
    servers: HashMap<String, StoredCredentials>,
}

#[derive(Debug, Clone)]
pub struct FileCredentialStore {
    path: PathBuf,
    server_key: String,
}

impl FileCredentialStore {
    pub fn new(path: PathBuf, server_key: impl Into<String>) -> Self {
        Self {
            path,
            server_key: server_key.into(),
        }
    }
}

#[async_trait::async_trait]
impl CredentialStore for FileCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let text = match tokio::fs::read_to_string(&self.path).await {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(err) => {
                return Err(AuthError::InternalError(format!(
                    "Failed to read MCP auth file: {err}"
                )));
            }
        };
        let data: McpCredentialFile = serde_json::from_str(&text)
            .map_err(|err| AuthError::InternalError(format!("Invalid MCP auth file: {err}")))?;
        Ok(data.servers.get(&self.server_key).cloned())
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let mut data = match tokio::fs::read_to_string(&self.path).await {
            Ok(text) => serde_json::from_str::<McpCredentialFile>(&text)
                .map_err(|err| AuthError::InternalError(format!("Invalid MCP auth file: {err}")))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => McpCredentialFile::default(),
            Err(err) => {
                return Err(AuthError::InternalError(format!(
                    "Failed to read MCP auth file: {err}"
                )));
            }
        };
        data.servers.insert(self.server_key.clone(), credentials);
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|err| {
                AuthError::InternalError(format!("Failed to create MCP auth dir: {err}"))
            })?;
        }
        let text = serde_json::to_string_pretty(&data).map_err(|err| {
            AuthError::InternalError(format!("Failed to serialize MCP auth file: {err}"))
        })?;
        tokio::fs::write(&self.path, text).await.map_err(|err| {
            AuthError::InternalError(format!("Failed to write MCP auth file: {err}"))
        })?;
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        let mut data = match tokio::fs::read_to_string(&self.path).await {
            Ok(text) => serde_json::from_str::<McpCredentialFile>(&text)
                .map_err(|err| AuthError::InternalError(format!("Invalid MCP auth file: {err}")))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => McpCredentialFile::default(),
            Err(err) => {
                return Err(AuthError::InternalError(format!(
                    "Failed to read MCP auth file: {err}"
                )));
            }
        };
        data.servers.remove(&self.server_key);
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|err| {
                AuthError::InternalError(format!("Failed to create MCP auth dir: {err}"))
            })?;
        }
        let text = serde_json::to_string_pretty(&data).map_err(|err| {
            AuthError::InternalError(format!("Failed to serialize MCP auth file: {err}"))
        })?;
        tokio::fs::write(&self.path, text).await.map_err(|err| {
            AuthError::InternalError(format!("Failed to write MCP auth file: {err}"))
        })?;
        Ok(())
    }
}

pub fn get_mcp_auth_file() -> PathBuf {
    get_share_dir().join("credentials").join("mcp_auth.json")
}

pub fn get_mcp_credential_store(server_url: &str) -> FileCredentialStore {
    FileCredentialStore::new(get_mcp_auth_file(), server_url)
}

pub async fn has_oauth_tokens(server_url: &str) -> Result<bool, AuthError> {
    let store = get_mcp_credential_store(server_url);
    Ok(store
        .load()
        .await?
        .and_then(|creds| creds.token_response)
        .is_some())
}
