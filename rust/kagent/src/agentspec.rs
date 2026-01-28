use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::exception::AgentSpecError;

pub const DEFAULT_AGENT_SPEC_VERSION: &str = "1";
pub const SUPPORTED_AGENT_SPEC_VERSIONS: &[&str] = &[DEFAULT_AGENT_SPEC_VERSION];

pub fn get_agents_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("agents")
}

pub fn default_agent_file() -> PathBuf {
    get_agents_dir().join("default").join("agent.yaml")
}

pub fn okabe_agent_file() -> PathBuf {
    get_agents_dir().join("okabe").join("agent.yaml")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inheritable<T> {
    Inherit,
    Value(T),
}

impl<T> Default for Inheritable<T> {
    fn default() -> Self {
        Inheritable::Inherit
    }
}

impl<T> Inheritable<T> {
    pub fn is_inherit(&self) -> bool {
        matches!(self, Inheritable::Inherit)
    }

    pub fn into_value(self) -> Option<T> {
        match self {
            Inheritable::Value(value) => Some(value),
            Inheritable::Inherit => None,
        }
    }
}

impl<T> From<T> for Inheritable<T> {
    fn from(value: T) -> Self {
        Inheritable::Value(value)
    }
}

impl<'de, T> Deserialize<'de> for Inheritable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = T::deserialize(deserializer)?;
        Ok(Inheritable::Value(value))
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct AgentSpec {
    #[serde(default)]
    pub extend: Option<String>,
    #[serde(default)]
    pub name: Inheritable<String>,
    #[serde(default)]
    pub system_prompt_path: Inheritable<PathBuf>,
    #[serde(default)]
    pub system_prompt_args: HashMap<String, String>,
    #[serde(default)]
    pub tools: Inheritable<Option<Vec<String>>>,
    #[serde(default)]
    pub exclude_tools: Inheritable<Option<Vec<String>>>,
    #[serde(default)]
    pub subagents: Inheritable<Option<HashMap<String, SubagentSpec>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubagentSpec {
    pub path: PathBuf,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedAgentSpec {
    pub name: String,
    pub system_prompt_path: PathBuf,
    pub system_prompt_args: HashMap<String, String>,
    pub tools: Vec<String>,
    pub exclude_tools: Vec<String>,
    pub subagents: HashMap<String, SubagentSpec>,
}

pub async fn load_agent_spec(agent_file: &Path) -> Result<ResolvedAgentSpec, AgentSpecError> {
    let agent_spec = load_agent_spec_inner(agent_file).await?;
    if agent_spec.name.is_inherit() {
        return Err(AgentSpecError::new("Agent name is required"));
    }
    if agent_spec.system_prompt_path.is_inherit() {
        return Err(AgentSpecError::new("System prompt path is required"));
    }
    if agent_spec.tools.is_inherit() {
        return Err(AgentSpecError::new("Tools are required"));
    }

    let name = agent_spec.name.into_value().unwrap();
    let system_prompt_path = agent_spec.system_prompt_path.into_value().unwrap();
    let tools = agent_spec
        .tools
        .into_value()
        .unwrap_or_default()
        .unwrap_or_default();
    let exclude_tools = agent_spec
        .exclude_tools
        .into_value()
        .unwrap_or_default()
        .unwrap_or_default();
    let subagents = agent_spec
        .subagents
        .into_value()
        .unwrap_or_default()
        .unwrap_or_default();

    Ok(ResolvedAgentSpec {
        name,
        system_prompt_path,
        system_prompt_args: agent_spec.system_prompt_args,
        tools,
        exclude_tools,
        subagents,
    })
}

async fn load_agent_spec_inner(agent_file: &Path) -> Result<AgentSpec, AgentSpecError> {
    let mut chain: Vec<(AgentSpec, PathBuf)> = Vec::new();
    let mut current_file = agent_file.to_path_buf();
    loop {
        let spec = load_agent_spec_file(&current_file).await?;
        let extend = spec.extend.clone();
        chain.push((spec, current_file.clone()));
        let Some(extend) = extend else {
            break;
        };
        current_file = if extend == "default" {
            default_agent_file()
        } else {
            current_file
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(extend)
        };
    }

    let (mut agent_spec, _) = chain.pop().expect("agent spec chain is empty");
    for (spec, _) in chain.into_iter().rev() {
        if !spec.name.is_inherit() {
            agent_spec.name = spec.name;
        }
        if !spec.system_prompt_path.is_inherit() {
            agent_spec.system_prompt_path = spec.system_prompt_path;
        }
        if !spec.system_prompt_args.is_empty() {
            for (key, value) in spec.system_prompt_args.iter() {
                agent_spec
                    .system_prompt_args
                    .insert(key.clone(), value.clone());
            }
        }
        if !spec.tools.is_inherit() {
            agent_spec.tools = spec.tools;
        }
        if !spec.exclude_tools.is_inherit() {
            agent_spec.exclude_tools = spec.exclude_tools;
        }
        if !spec.subagents.is_inherit() {
            agent_spec.subagents = spec.subagents;
        }
    }

    Ok(agent_spec)
}

async fn load_agent_spec_file(agent_file: &Path) -> Result<AgentSpec, AgentSpecError> {
    let metadata = tokio::fs::metadata(agent_file).await.map_err(|_| {
        AgentSpecError::new(format!(
            "Agent spec file not found: {}",
            agent_file.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(AgentSpecError::new(format!(
            "Agent spec path is not a file: {}",
            agent_file.display()
        )));
    }

    let content = tokio::fs::read_to_string(agent_file)
        .await
        .map_err(|err| AgentSpecError::new(format!("Invalid agent spec file: {err}")))?;
    let data: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|err| AgentSpecError::new(format!("Invalid YAML in agent spec file: {err}")))?;

    let version = data
        .get("version")
        .map(|value| {
            if let Some(text) = value.as_str() {
                text.to_string()
            } else if let Some(number) = value.as_i64() {
                number.to_string()
            } else {
                DEFAULT_AGENT_SPEC_VERSION.to_string()
            }
        })
        .unwrap_or_else(|| DEFAULT_AGENT_SPEC_VERSION.to_string());
    if !SUPPORTED_AGENT_SPEC_VERSIONS.contains(&version.as_str()) {
        return Err(AgentSpecError::new(format!(
            "Unsupported agent spec version: {version}"
        )));
    }

    let agent_value = data
        .get("agent")
        .cloned()
        .unwrap_or_else(|| serde_yaml::Value::Mapping(Default::default()));
    let mut agent_spec: AgentSpec = serde_yaml::from_value(agent_value)
        .map_err(|err| AgentSpecError::new(format!("Invalid agent spec file: {err}")))?;

    if let Inheritable::Value(path) = &mut agent_spec.system_prompt_path {
        if !path.is_absolute() {
            let joined = agent_file
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(&path);
            *path = tokio::fs::canonicalize(&joined).await.unwrap_or(joined);
        }
    }

    if let Inheritable::Value(Some(subagents)) = &mut agent_spec.subagents {
        for spec in subagents.values_mut() {
            if !spec.path.is_absolute() {
                let joined = agent_file
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(&spec.path);
                spec.path = tokio::fs::canonicalize(&joined).await.unwrap_or(joined);
            }
        }
    }

    Ok(agent_spec)
}
