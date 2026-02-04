use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use rmcp::transport::auth::{AuthorizationManager, AuthorizationSession, CredentialStore};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use url::Url;

use crate::mcp::{
    ensure_mcp_servers, get_global_mcp_config_file, get_mcp_credential_store, has_oauth_tokens,
    load_mcp_config_file, load_mcp_config_string, save_mcp_config,
};
use crate::share::ensure_share_dir;
use crate::soul::toolset::{list_mcp_tools, parse_mcp_config};

#[derive(Args, Debug)]
#[command(about = "Manage MCP server configurations.")]
pub struct McpArgs {
    #[command(subcommand)]
    pub command: McpCommand,
}

#[derive(Subcommand, Debug)]
pub enum McpCommand {
    /// Add an MCP server.
    Add(McpAddArgs),
    /// Remove an MCP server.
    Remove(McpRemoveArgs),
    /// List all MCP servers.
    List,
    /// Authorize with an OAuth-enabled MCP server.
    Auth(McpAuthArgs),
    /// Reset OAuth authorization for an MCP server (clear cached tokens).
    ResetAuth(McpResetAuthArgs),
    /// Test connection to an MCP server and list available tools.
    Test(McpTestArgs),
}

#[derive(Args, Debug)]
#[command(
    about = "Add an MCP server.",
    after_help = "Examples:\n\n      # Add streamable HTTP server:\n      kagent mcp add --transport http context7 https://mcp.context7.com/mcp --header \"CONTEXT7_API_KEY: ctx7sk-your-key\"\n\n      # Add streamable HTTP server with OAuth authorization:\n      kagent mcp add --transport http --auth oauth linear https://mcp.linear.app/mcp\n\n      # Add stdio server:\n      kagent mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest"
)]
pub struct McpAddArgs {
    #[arg(help = "Name of the MCP server to add.")]
    pub name: String,

    #[arg(
        value_name = "TARGET_OR_COMMAND...",
        help = "For http: server URL. For stdio: command to run (prefix with `--`)."
    )]
    pub server_args: Vec<String>,

    #[arg(
        long = "transport",
        short = 't',
        default_value = "stdio",
        help = "Transport type for the MCP server. Default: stdio."
    )]
    pub transport: String,

    #[arg(
        long = "env",
        short = 'e',
        help = "Environment variables in KEY=VALUE format. Can be specified multiple times."
    )]
    pub env: Vec<String>,

    #[arg(
        long = "header",
        short = 'H',
        help = "HTTP headers in KEY:VALUE format. Can be specified multiple times."
    )]
    pub header: Vec<String>,

    #[arg(
        long = "auth",
        short = 'a',
        help = "Authorization type (e.g., 'oauth')."
    )]
    pub auth: Option<String>,
}

#[derive(Args, Debug)]
#[command(about = "Remove an MCP server.")]
pub struct McpRemoveArgs {
    #[arg(help = "Name of the MCP server to remove.")]
    pub name: String,
}

#[derive(Args, Debug)]
#[command(about = "Authorize with an OAuth-enabled MCP server.")]
pub struct McpAuthArgs {
    #[arg(help = "Name of the MCP server to authorize.")]
    pub name: String,
}

#[derive(Args, Debug)]
#[command(about = "Reset OAuth authorization for an MCP server (clear cached tokens).")]
pub struct McpResetAuthArgs {
    #[arg(help = "Name of the MCP server to reset authorization.")]
    pub name: String,
}

#[derive(Args, Debug)]
#[command(about = "Test connection to an MCP server and list available tools.")]
pub struct McpTestArgs {
    #[arg(help = "Name of the MCP server to test.")]
    pub name: String,
}

pub async fn run_mcp_command(args: McpArgs) -> Result<()> {
    match args.command {
        McpCommand::Add(args) => mcp_add(args).await,
        McpCommand::Remove(args) => mcp_remove(args).await,
        McpCommand::List => mcp_list().await,
        McpCommand::Auth(args) => mcp_auth(args).await,
        McpCommand::ResetAuth(args) => mcp_reset_auth(args).await,
        McpCommand::Test(args) => mcp_test(args).await,
    }
}

async fn mcp_add(args: McpAddArgs) -> Result<()> {
    let mut config = load_mcp_config_for_edit().await?;
    let servers = ensure_mcp_servers(&mut config)?;

    match args.transport.as_str() {
        "stdio" => {
            if args.server_args.is_empty() {
                anyhow::bail!(
                    "For stdio transport, provide the command to start the MCP server after `--`."
                );
            }
            if !args.header.is_empty() {
                anyhow::bail!("--header is only valid for http transport.");
            }
            if args.auth.is_some() {
                anyhow::bail!("--auth is only valid for http transport.");
            }
            let command = &args.server_args[0];
            let command_args = args.server_args[1..].to_vec();
            let mut server = json!({
                "command": command,
                "args": command_args,
            });
            if !args.env.is_empty() {
                let env = parse_key_value_pairs(&args.env, "env", "=", false)?;
                if let Some(map) = server.as_object_mut() {
                    map.insert("env".to_string(), json!(env));
                }
            }
            servers.insert(args.name.clone(), server);
        }
        "http" => {
            if !args.env.is_empty() {
                anyhow::bail!("--env is only supported for stdio transport.");
            }
            if args.server_args.is_empty() {
                anyhow::bail!("URL is required for http transport.");
            }
            if args.server_args.len() > 1 {
                anyhow::bail!("Multiple targets provided. Supply a single URL for http transport.");
            }
            let mut server = json!({
                "url": args.server_args[0],
                "transport": "http",
            });
            if !args.header.is_empty() {
                let headers = parse_key_value_pairs(&args.header, "header", ":", true)?;
                if let Some(map) = server.as_object_mut() {
                    map.insert("headers".to_string(), json!(headers));
                }
            }
            if let Some(auth) = args.auth.as_ref() {
                if let Some(map) = server.as_object_mut() {
                    map.insert("auth".to_string(), json!(auth));
                }
            }
            servers.insert(args.name.clone(), server);
        }
        other => {
            anyhow::bail!("Unsupported transport: {other}.");
        }
    }

    save_mcp_config(&config).await?;
    println!(
        "Added MCP server '{}' to {}.",
        args.name,
        get_global_mcp_config_file().display()
    );
    Ok(())
}

async fn mcp_remove(args: McpRemoveArgs) -> Result<()> {
    let mut config = load_mcp_config_for_edit().await?;
    let servers = ensure_mcp_servers(&mut config)?;
    if !servers.contains_key(&args.name) {
        anyhow::bail!("MCP server '{}' not found.", args.name);
    }
    servers.remove(&args.name);
    save_mcp_config(&config).await?;
    println!(
        "Removed MCP server '{}' from {}.",
        args.name,
        get_global_mcp_config_file().display()
    );
    Ok(())
}

async fn mcp_list() -> Result<()> {
    let config_file = get_global_mcp_config_file();
    let mut config = load_mcp_config_for_edit().await?;
    let servers = ensure_mcp_servers(&mut config)?;

    println!("MCP config file: {}", config_file.display());
    if servers.is_empty() {
        println!("No MCP servers configured.");
        return Ok(());
    }

    for (name, server) in servers.iter() {
        let mut auth_required = false;
        if server.get("auth").and_then(Value::as_str) == Some("oauth") {
            if let Some(url) = server.get("url").and_then(Value::as_str) {
                auth_required = !has_oauth_tokens(url).await?;
            }
        }
        let line = describe_mcp_server(name, server, auth_required);
        println!("  {line}");
    }
    Ok(())
}

async fn mcp_auth(args: McpAuthArgs) -> Result<()> {
    let mut config = load_mcp_config_for_edit().await?;
    let servers = ensure_mcp_servers(&mut config)?;
    let server = servers.get(&args.name);
    let Some(server) = server else {
        anyhow::bail!("MCP server '{}' not found.", args.name);
    };
    if server.get("url").and_then(Value::as_str).is_none() {
        anyhow::bail!("MCP server '{}' is not a remote server.", args.name);
    }
    let auth = server.get("auth").and_then(Value::as_str);
    if auth != Some("oauth") {
        anyhow::bail!(
            "MCP server '{}' does not use OAuth. Add with --auth oauth.",
            args.name
        );
    }
    let url = server
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("MCP server '{}' is missing url.", args.name))?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("Failed to open local callback server")?;
    let addr = listener
        .local_addr()
        .context("Failed to read callback address")?;
    let redirect_uri = format!("http://{addr}/callback");

    let mut manager = AuthorizationManager::new(url).await?;
    manager.set_credential_store(get_mcp_credential_store(url));
    let metadata = manager.discover_metadata().await?;
    manager.set_metadata(metadata);

    let session =
        AuthorizationSession::new(manager, &[], &redirect_uri, Some("Kimi Code CLI"), None).await?;
    let auth_url = session.get_authorization_url().to_string();

    println!("Authorizing with '{}'...", args.name);
    println!("A browser window will open for authorization.");
    if let Err(err) = webbrowser::open(&auth_url) {
        eprintln!("Failed to open browser: {err}\nOpen this URL:\n{auth_url}");
    }

    let callback = timeout(Duration::from_secs(300), wait_for_oauth_callback(listener))
        .await
        .context("OAuth authorization timed out")??;
    session
        .handle_callback(&callback.code, &callback.state)
        .await
        .map_err(|err| anyhow::anyhow!("Authorization failed: {err}"))?;

    println!("Successfully authorized with '{}'.", args.name);

    let parsed =
        parse_mcp_config(&config).map_err(|err| anyhow::anyhow!("Invalid MCP config: {err}"))?;
    let server_config = parsed
        .get(&args.name)
        .ok_or_else(|| anyhow::anyhow!("MCP server '{}' not found.", args.name))?;
    let tools = list_mcp_tools(server_config)
        .await
        .map_err(|err| anyhow::anyhow!("Failed to list MCP tools: {err}"))?;
    println!("Available tools: {}", tools.len());
    Ok(())
}

async fn mcp_reset_auth(args: McpResetAuthArgs) -> Result<()> {
    let mut config = load_mcp_config_for_edit().await?;
    let servers = ensure_mcp_servers(&mut config)?;
    let server = servers.get(&args.name);
    let Some(server) = server else {
        anyhow::bail!("MCP server '{}' not found.", args.name);
    };
    if server.get("url").and_then(Value::as_str).is_none() {
        anyhow::bail!("MCP server '{}' is not a remote server.", args.name);
    }
    let url = server
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("MCP server '{}' is missing url.", args.name))?;
    get_mcp_credential_store(url).clear().await?;
    println!("OAuth tokens cleared for '{}'.", args.name);
    Ok(())
}

async fn mcp_test(args: McpTestArgs) -> Result<()> {
    let mut config = load_mcp_config_for_edit().await?;
    let servers = ensure_mcp_servers(&mut config)?;
    if !servers.contains_key(&args.name) {
        anyhow::bail!("MCP server '{}' not found.", args.name);
    }

    let parsed =
        parse_mcp_config(&config).map_err(|err| anyhow::anyhow!("Invalid MCP config: {err}"))?;
    let server_config = parsed
        .get(&args.name)
        .ok_or_else(|| anyhow::anyhow!("MCP server '{}' not found.", args.name))?;

    println!("Testing connection to '{}'...", args.name);
    let tools = list_mcp_tools(server_config)
        .await
        .map_err(|err| anyhow::anyhow!("✗ Connection failed: {err}"))?;

    println!("✓ Connected to '{}'", args.name);
    println!("  Available tools: {}", tools.len());
    if !tools.is_empty() {
        println!("  Tools:");
        for tool in tools {
            let mut desc = tool
                .description
                .as_ref()
                .map(|value| value.as_ref())
                .unwrap_or("")
                .to_string();
            if desc.len() > 50 {
                desc.truncate(47);
                desc.push_str("...");
            }
            if desc.is_empty() {
                println!("    - {}", tool.name);
            } else {
                println!("    - {}: {}", tool.name, desc);
            }
        }
    }
    Ok(())
}

fn describe_mcp_server(name: &str, server: &Value, auth_required: bool) -> String {
    if let Some(command) = server.get("command").and_then(Value::as_str) {
        let args = server
            .get("args")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let line = if args.is_empty() {
            format!("{name} (stdio): {command}")
        } else {
            format!("{name} (stdio): {command} {args}")
        };
        return line.trim_end().to_string();
    }

    if let Some(url) = server.get("url").and_then(Value::as_str) {
        let mut transport = server
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("http")
            .to_string();
        if transport == "streamable-http" {
            transport = "http".to_string();
        }
        let mut line = format!("{name} ({transport}): {url}");
        if auth_required {
            line.push_str(" [authorization required - run: kagent mcp auth ");
            line.push_str(name);
            line.push(']');
        }
        return line;
    }

    format!("{name}: {server}")
}

pub async fn load_mcp_configs(files: &[PathBuf], raw: &[String]) -> Result<Vec<Value>> {
    let mut configs = Vec::new();
    let mut file_configs = files.to_vec();

    if file_configs.is_empty() && raw.is_empty() {
        let default_path = get_global_mcp_config_file();
        if tokio::fs::metadata(&default_path).await.is_ok() {
            file_configs.push(default_path);
        }
    }

    for path in file_configs {
        let text = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("Failed to read MCP config file: {}", path.display()))?;
        let mut value = load_mcp_config_string(&text).map_err(|err| {
            anyhow::anyhow!(
                "Invalid JSON in MCP config file '{}': {err}",
                path.display()
            )
        })?;
        ensure_mcp_servers(&mut value)?;
        configs.push(value);
    }

    for raw_conf in raw.iter() {
        let trimmed = raw_conf.trim();
        if trimmed.is_empty() {
            anyhow::bail!("MCP config cannot be empty.");
        }
        let mut value = load_mcp_config_string(trimmed)
            .map_err(|err| anyhow::anyhow!("Invalid JSON in MCP config: {err}"))?;
        ensure_mcp_servers(&mut value)?;
        configs.push(value);
    }

    Ok(configs)
}

async fn load_mcp_config_for_edit() -> Result<Value> {
    let _ = ensure_share_dir().await;
    let path = get_global_mcp_config_file();
    if tokio::fs::metadata(&path).await.is_err() {
        return Ok(json!({"mcpServers": {}}));
    }
    let mut value = load_mcp_config_file(&path).await.map_err(|err| {
        anyhow::anyhow!(
            "Invalid JSON in MCP config file '{}': {err}",
            path.display()
        )
    })?;
    ensure_mcp_servers(&mut value)?;
    Ok(value)
}

fn parse_key_value_pairs(
    items: &[String],
    option_name: &str,
    separator: &str,
    strip_whitespace: bool,
) -> Result<HashMap<String, String>> {
    let mut parsed = HashMap::new();
    for item in items {
        if let Some((key, value)) = item.split_once(separator) {
            let (key, value) = if strip_whitespace {
                (key.trim(), value.trim())
            } else {
                (key, value)
            };
            if key.is_empty() {
                anyhow::bail!("Invalid {option_name} format: {item} (empty key).");
            }
            parsed.insert(key.to_string(), value.to_string());
        } else {
            anyhow::bail!("Invalid {option_name} format: {item} (expected KEY{separator}VALUE).");
        }
    }
    Ok(parsed)
}

struct OAuthCallback {
    code: String,
    state: String,
}

// Minimal localhost callback receiver for OAuth code + state.
async fn wait_for_oauth_callback(listener: TcpListener) -> Result<OAuthCallback> {
    let (mut socket, _addr) = listener.accept().await?;
    let mut buffer = vec![0u8; 4096];
    let read = socket.read(&mut buffer).await?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or("/");

    let result = if method != "GET" {
        Err(anyhow::anyhow!("Unsupported HTTP method"))
    } else {
        let url = Url::parse(&format!("http://localhost{path}"))?;
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "code" => code = Some(value.to_string()),
                "state" => state = Some(value.to_string()),
                "error" => error = Some(value.to_string()),
                _ => {}
            }
        }
        if let Some(error) = error {
            Err(anyhow::anyhow!("OAuth error: {error}"))
        } else if let (Some(code), Some(state)) = (code, state) {
            Ok(OAuthCallback { code, state })
        } else {
            Err(anyhow::anyhow!("Missing OAuth code or state"))
        }
    };

    let (status, body) = match &result {
        Ok(_) => (
            "200 OK",
            "<html><body><p>Authorization complete. You can close this tab.</p></body></html>"
                .to_string(),
        ),
        Err(err) => (
            "400 Bad Request",
            format!(
                "<html><body><p>Authorization failed: {}</p></body></html>",
                err
            ),
        ),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;

    result
}
