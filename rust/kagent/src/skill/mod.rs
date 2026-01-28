use std::collections::HashMap;
use std::path::PathBuf;

use kaos::{KaosPath, get_current_kaos};
use serde_yaml::Value;
use tracing::{error, info, warn};

use crate::skill::flow::d2::parse_d2_flowchart;
use crate::skill::flow::mermaid::parse_mermaid_flowchart;
use crate::skill::flow::{Flow, FlowError};
use crate::utils::parse_frontmatter;

pub mod flow;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillType {
    Standard,
    Flow,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub skill_type: SkillType,
    pub dir: KaosPath,
    pub flow: Option<Flow>,
}

impl Skill {
    pub fn skill_md_file(&self) -> KaosPath {
        self.dir.clone() / "SKILL.md"
    }
}

pub fn get_skills_dir() -> KaosPath {
    KaosPath::home() / ".config" / "agents" / "skills"
}

pub fn get_builtin_skills_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("skills")
}

pub fn get_user_skills_dir_candidates() -> Vec<KaosPath> {
    vec![
        KaosPath::home() / ".config" / "agents" / "skills",
        KaosPath::home() / ".agents" / "skills",
        KaosPath::home() / ".kimi" / "skills",
        KaosPath::home() / ".claude" / "skills",
        KaosPath::home() / ".codex" / "skills",
    ]
}

pub fn get_project_skills_dir_candidates(work_dir: &KaosPath) -> Vec<KaosPath> {
    vec![
        work_dir.clone() / ".agents" / "skills",
        work_dir.clone() / ".kimi" / "skills",
        work_dir.clone() / ".claude" / "skills",
        work_dir.clone() / ".codex" / "skills",
    ]
}

fn supports_builtin_skills() -> bool {
    let current = get_current_kaos().name().to_string();
    matches!(current.as_str(), "local" | "acp")
}

pub async fn find_first_existing_dir(candidates: &[KaosPath]) -> Option<KaosPath> {
    for candidate in candidates {
        if candidate.is_dir(true).await {
            return Some(candidate.clone());
        }
    }
    None
}

pub async fn find_user_skills_dir() -> Option<KaosPath> {
    find_first_existing_dir(&get_user_skills_dir_candidates()).await
}

pub async fn find_project_skills_dir(work_dir: &KaosPath) -> Option<KaosPath> {
    find_first_existing_dir(&get_project_skills_dir_candidates(work_dir)).await
}

pub async fn resolve_skills_roots(
    work_dir: &KaosPath,
    skills_dir_override: Option<KaosPath>,
) -> Vec<KaosPath> {
    let mut roots = Vec::new();
    if supports_builtin_skills() {
        roots.push(KaosPath::unsafe_from_local_path(&get_builtin_skills_dir()));
    }
    if let Some(override_dir) = skills_dir_override {
        roots.push(override_dir);
        return roots;
    }
    if let Some(user_dir) = find_user_skills_dir().await {
        roots.push(user_dir);
    }
    if let Some(project_dir) = find_project_skills_dir(work_dir).await {
        roots.push(project_dir);
    }
    roots
}

pub fn normalize_skill_name(name: &str) -> String {
    name.to_lowercase()
}

pub fn index_skills(skills: &[Skill]) -> HashMap<String, Skill> {
    skills
        .iter()
        .map(|skill| (normalize_skill_name(&skill.name), skill.clone()))
        .collect()
}

pub async fn discover_skills_from_roots(skills_dirs: &[KaosPath]) -> Vec<Skill> {
    let mut skills_by_name: HashMap<String, Skill> = HashMap::new();
    for skills_dir in skills_dirs {
        for skill in discover_skills(skills_dir).await {
            skills_by_name.insert(normalize_skill_name(&skill.name), skill);
        }
    }
    let mut skills: Vec<Skill> = skills_by_name.into_values().collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

pub async fn read_skill_text(skill: &Skill) -> Option<String> {
    match skill.skill_md_file().read_text().await {
        Ok(text) => Some(text.trim().to_string()),
        Err(err) => {
            warn!(
                "Failed to read skill file {}: {}",
                skill.skill_md_file().to_string_lossy(),
                err
            );
            None
        }
    }
}

pub async fn discover_skills(skills_dir: &KaosPath) -> Vec<Skill> {
    if !skills_dir.is_dir(true).await {
        return Vec::new();
    }
    let mut skills = Vec::new();
    if let Ok(entries) = skills_dir.iterdir().await {
        for skill_dir in entries {
            if !skill_dir.is_dir(true).await {
                continue;
            }
            let skill_md = skill_dir.clone() / "SKILL.md";
            if !skill_md.is_file(true).await {
                continue;
            }
            let Ok(content) = skill_md.read_text().await else {
                continue;
            };
            match parse_skill_text(&content, &skill_dir) {
                Ok(skill) => skills.push(skill),
                Err(err) => {
                    info!(
                        "Skipping invalid skill at {}: {}",
                        skill_md.to_string_lossy(),
                        err
                    );
                }
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

pub fn parse_skill_text(content: &str, dir_path: &KaosPath) -> Result<Skill, String> {
    let frontmatter = parse_frontmatter(content).map_err(|err| err.to_string())?;
    let name = frontmatter
        .as_ref()
        .and_then(|map| map.get("name"))
        .and_then(value_as_string)
        .unwrap_or_else(|| dir_path.name());
    let description = frontmatter
        .as_ref()
        .and_then(|map| map.get("description"))
        .and_then(value_as_string)
        .unwrap_or_else(|| "No description provided.".to_string());
    let skill_type = frontmatter
        .as_ref()
        .and_then(|map| map.get("type"))
        .and_then(value_as_string)
        .unwrap_or_else(|| "standard".to_string());

    let mut flow = None;
    let mut resolved_type = SkillType::Standard;
    if skill_type == "flow" {
        match parse_flow_from_skill(content) {
            Ok(parsed_flow) => {
                flow = Some(parsed_flow);
                resolved_type = SkillType::Flow;
            }
            Err(err) => {
                error!("Failed to parse flow skill {}: {}", name, err);
                flow = None;
                resolved_type = SkillType::Standard;
            }
        }
    }

    Ok(Skill {
        name,
        description,
        skill_type: resolved_type,
        dir: dir_path.clone(),
        flow,
    })
}

fn parse_flow_from_skill(content: &str) -> Result<Flow, FlowError> {
    for (lang, code) in iter_fenced_codeblocks(content) {
        if lang == "mermaid" {
            return parse_mermaid_flowchart(&code).map_err(|err| FlowError::new(err.to_string()));
        }
        if lang == "d2" {
            return parse_d2_flowchart(&code).map_err(|err| FlowError::new(err.to_string()));
        }
    }
    Err(FlowError::new(
        "Flow skills require a mermaid or d2 code block in SKILL.md.",
    ))
}

fn iter_fenced_codeblocks(content: &str) -> Vec<(String, String)> {
    let mut blocks = Vec::new();
    let mut fence = String::new();
    let mut fence_char = '\0';
    let mut lang = String::new();
    let mut buf: Vec<String> = Vec::new();
    let mut in_block = false;

    for line in content.lines() {
        let stripped = line.trim_start();
        if !in_block {
            if let Some((fence_text, fence_ch, info)) = parse_fence_open(stripped) {
                fence = fence_text;
                fence_char = fence_ch;
                lang = normalize_code_lang(&info);
                in_block = true;
                buf.clear();
            }
            continue;
        }
        if is_fence_close(stripped, fence_char, fence.len()) {
            blocks.push((lang.clone(), buf.join("\n").trim_matches('\n').to_string()));
            in_block = false;
            fence.clear();
            fence_char = '\0';
            lang.clear();
            buf.clear();
            continue;
        }
        buf.push(line.to_string());
    }
    blocks
}

fn normalize_code_lang(info: &str) -> String {
    if info.is_empty() {
        return String::new();
    }
    let mut lang = info.split_whitespace().next().unwrap_or("").to_lowercase();
    if lang.starts_with('{') && lang.ends_with('}') && lang.len() > 2 {
        lang = lang[1..lang.len() - 1].trim().to_string();
    }
    lang
}

fn parse_fence_open(line: &str) -> Option<(String, char, String)> {
    let first = line.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let mut count = 0usize;
    for ch in line.chars() {
        if ch == first {
            count += 1;
        } else {
            break;
        }
    }
    if count < 3 {
        return None;
    }
    let fence = std::iter::repeat(first).take(count).collect::<String>();
    let info = line[count..].trim().to_string();
    Some((fence, first, info))
}

fn is_fence_close(line: &str, fence_char: char, fence_len: usize) -> bool {
    if fence_char == '\0' || line.is_empty() || line.chars().next().unwrap_or('\0') != fence_char {
        return false;
    }
    let mut count = 0usize;
    for ch in line.chars() {
        if ch == fence_char {
            count += 1;
        } else {
            break;
        }
    }
    if count < fence_len {
        return false;
    }
    line[count..].trim().is_empty()
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.to_string()),
        _ => None,
    }
}
