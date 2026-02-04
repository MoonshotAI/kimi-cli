use std::path::Path;
use std::sync::Arc;

use tempfile::TempDir;

use kagent::skill::{
    Skill, SkillType, discover_skills, discover_skills_from_roots, find_user_skills_dir,
    get_builtin_skills_dir, resolve_skills_roots,
};
use kaos::{
    CurrentKaosToken, Kaos, KaosPath, KaosProcess, LineStream, LocalKaos, StrOrKaosPath,
    reset_current_kaos, set_current_kaos, with_current_kaos_scope,
};

struct FixedHomeKaos {
    inner: LocalKaos,
    home: KaosPath,
}

impl FixedHomeKaos {
    fn new(home: KaosPath) -> Self {
        Self {
            inner: LocalKaos::new(),
            home,
        }
    }
}

#[async_trait::async_trait]
impl Kaos for FixedHomeKaos {
    fn name(&self) -> &str {
        "local"
    }

    fn normpath(&self, path: &StrOrKaosPath<'_>) -> KaosPath {
        self.inner.normpath(path)
    }

    fn home(&self) -> KaosPath {
        self.home.clone()
    }

    fn cwd(&self) -> KaosPath {
        self.inner.cwd()
    }

    async fn chdir(&self, path: &KaosPath) -> anyhow::Result<()> {
        self.inner.chdir(path).await
    }

    async fn stat(
        &self,
        path: &KaosPath,
        follow_symlinks: bool,
    ) -> anyhow::Result<kaos::StatResult> {
        self.inner.stat(path, follow_symlinks).await
    }

    async fn iterdir(&self, path: &KaosPath) -> anyhow::Result<Vec<KaosPath>> {
        self.inner.iterdir(path).await
    }

    async fn glob(
        &self,
        path: &KaosPath,
        pattern: &str,
        case_sensitive: bool,
    ) -> anyhow::Result<Vec<KaosPath>> {
        self.inner.glob(path, pattern, case_sensitive).await
    }

    async fn read_bytes(&self, path: &KaosPath, limit: Option<usize>) -> anyhow::Result<Vec<u8>> {
        self.inner.read_bytes(path, limit).await
    }

    async fn read_text(&self, path: &KaosPath) -> anyhow::Result<String> {
        self.inner.read_text(path).await
    }

    async fn read_lines(&self, path: &KaosPath) -> anyhow::Result<Vec<String>> {
        self.inner.read_lines(path).await
    }

    async fn read_lines_stream(&self, path: &KaosPath) -> anyhow::Result<LineStream> {
        self.inner.read_lines_stream(path).await
    }

    async fn write_bytes(&self, path: &KaosPath, data: &[u8]) -> anyhow::Result<usize> {
        self.inner.write_bytes(path, data).await
    }

    async fn write_text(&self, path: &KaosPath, data: &str, append: bool) -> anyhow::Result<usize> {
        self.inner.write_text(path, data, append).await
    }

    async fn mkdir(&self, path: &KaosPath, parents: bool, exist_ok: bool) -> anyhow::Result<()> {
        self.inner.mkdir(path, parents, exist_ok).await
    }

    async fn exec(&self, args: &[String]) -> anyhow::Result<Box<dyn KaosProcess>> {
        self.inner.exec(args).await
    }
}

struct FixedHomeKaosGuard {
    token: Option<CurrentKaosToken>,
}

impl FixedHomeKaosGuard {
    fn new(home: KaosPath) -> Self {
        let kaos = Arc::new(FixedHomeKaos::new(home));
        let token = set_current_kaos(kaos);
        Self { token: Some(token) }
    }
}

impl Drop for FixedHomeKaosGuard {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            reset_current_kaos(token);
        }
    }
}

fn write_skill(skill_dir: &Path, content: &str) {
    std::fs::create_dir_all(skill_dir).expect("create skill dir");
    std::fs::write(skill_dir.join("SKILL.md"), content).expect("write skill");
}

#[tokio::test]
async fn test_discover_skills_parses_frontmatter_and_defaults() {
    let root = TempDir::new().expect("temp dir");
    let root_path = root.path().join("skills");
    std::fs::create_dir_all(&root_path).expect("create skills root");

    write_skill(
        &root_path.join("alpha"),
        "---\nname: alpha-skill\ndescription: Alpha description\n---\n",
    );
    write_skill(&root_path.join("beta"), "# No frontmatter");

    let root_path = KaosPath::unsafe_from_local_path(&root_path);
    let mut skills = discover_skills(&root_path).await;
    let base_dir = KaosPath::unsafe_from_local_path(Path::new("/path/to"));
    for skill in &mut skills {
        let relative_dir = skill.dir.relative_to(&root_path).expect("relative");
        skill.dir = base_dir.clone() / &relative_dir;
    }

    assert_eq!(
        skills,
        vec![
            Skill {
                name: "alpha-skill".to_string(),
                description: "Alpha description".to_string(),
                skill_type: SkillType::Standard,
                dir: KaosPath::unsafe_from_local_path(Path::new("/path/to/alpha")),
                flow: None,
            },
            Skill {
                name: "beta".to_string(),
                description: "No description provided.".to_string(),
                skill_type: SkillType::Standard,
                dir: KaosPath::unsafe_from_local_path(Path::new("/path/to/beta")),
                flow: None,
            },
        ]
    );
}

#[tokio::test]
async fn test_discover_skills_parses_flow_type() {
    let root = TempDir::new().expect("temp dir");
    let root_path = root.path().join("skills");
    std::fs::create_dir_all(&root_path).expect("create skills root");

    write_skill(
        &root_path.join("flowy"),
        "---\nname: flowy\ndescription: Flow skill\ntype: flow\n---\n```mermaid\nflowchart TD\nBEGIN([BEGIN]) --> A[Hello]\nA --> END([END])\n```\n",
    );

    let skills = discover_skills(&KaosPath::unsafe_from_local_path(&root_path)).await;

    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].skill_type, SkillType::Flow);
    assert!(skills[0].flow.is_some());
    assert_eq!(skills[0].flow.as_ref().unwrap().begin_id, "BEGIN");
}

#[tokio::test]
async fn test_discover_skills_flow_parse_failure_falls_back() {
    let root = TempDir::new().expect("temp dir");
    let root_path = root.path().join("skills");
    std::fs::create_dir_all(&root_path).expect("create skills root");

    write_skill(
        &root_path.join("broken-flow"),
        "---\nname: broken-flow\ndescription: Broken flow skill\ntype: flow\n---\n```mermaid\nflowchart TD\nA --> B\n```\n",
    );

    let skills = discover_skills(&KaosPath::unsafe_from_local_path(&root_path)).await;

    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].skill_type, SkillType::Standard);
    assert!(skills[0].flow.is_none());
}

#[tokio::test]
async fn test_discover_skills_from_roots_prefers_later_dirs() {
    let root = TempDir::new().expect("temp dir");
    let root_path = root.path().join("root");
    let system_dir = root_path.join("system");
    let user_dir = root_path.join("user");
    std::fs::create_dir_all(&system_dir).expect("create system dir");
    std::fs::create_dir_all(&user_dir).expect("create user dir");

    write_skill(
        &system_dir.join("shared"),
        "---\nname: shared\ndescription: System version\n---\n",
    );
    write_skill(
        &user_dir.join("shared"),
        "---\nname: shared\ndescription: User version\n---\n",
    );

    let root_path = KaosPath::unsafe_from_local_path(&root_path);
    let mut skills = discover_skills_from_roots(&[
        KaosPath::unsafe_from_local_path(&system_dir),
        KaosPath::unsafe_from_local_path(&user_dir),
    ])
    .await;
    let base_dir = KaosPath::unsafe_from_local_path(Path::new("/path/to"));
    for skill in &mut skills {
        let relative_dir = skill.dir.relative_to(&root_path).expect("relative");
        skill.dir = base_dir.clone() / &relative_dir;
    }

    assert_eq!(
        skills,
        vec![Skill {
            name: "shared".to_string(),
            description: "User version".to_string(),
            skill_type: SkillType::Standard,
            dir: KaosPath::unsafe_from_local_path(Path::new("/path/to/user/shared")),
            flow: None,
        }]
    );
}

#[tokio::test]
async fn test_resolve_skills_roots_uses_layers() {
    with_current_kaos_scope(async {
        let tmp = TempDir::new().expect("temp dir");
        let home_dir = tmp.path().join("home");
        std::fs::create_dir_all(&home_dir).expect("create home dir");
        let _kaos_guard = FixedHomeKaosGuard::new(KaosPath::unsafe_from_local_path(&home_dir));
        let user_dir = home_dir.join(".config/agents/skills");
        std::fs::create_dir_all(&user_dir).expect("create user skills dir");

        let work_dir = tmp.path().join("project");
        let project_dir = work_dir.join(".agents/skills");
        std::fs::create_dir_all(&project_dir).expect("create project skills dir");

        let roots = resolve_skills_roots(&KaosPath::unsafe_from_local_path(&work_dir), None).await;

        assert_eq!(
            roots,
            vec![
                KaosPath::unsafe_from_local_path(&get_builtin_skills_dir()),
                KaosPath::unsafe_from_local_path(&user_dir),
                KaosPath::unsafe_from_local_path(&project_dir),
            ]
        );
    })
    .await;
}

#[tokio::test]
async fn test_resolve_skills_roots_respects_override() {
    let work_dir = TempDir::new().expect("temp dir");
    let override_dir = work_dir.path().join("override");
    std::fs::create_dir_all(&override_dir).expect("create override dir");

    let roots = resolve_skills_roots(
        &KaosPath::unsafe_from_local_path(work_dir.path()),
        Some(KaosPath::unsafe_from_local_path(&override_dir)),
    )
    .await;

    assert_eq!(
        roots,
        vec![
            KaosPath::unsafe_from_local_path(&get_builtin_skills_dir()),
            KaosPath::unsafe_from_local_path(&override_dir),
        ]
    );
}

#[tokio::test]
async fn test_find_user_skills_dir_uses_agents_candidate() {
    with_current_kaos_scope(async {
        let tmp = TempDir::new().expect("temp dir");
        let home_dir = tmp.path().join("home");
        std::fs::create_dir_all(&home_dir).expect("create home dir");
        let _kaos_guard = FixedHomeKaosGuard::new(KaosPath::unsafe_from_local_path(&home_dir));

        let agents_dir = home_dir.join(".agents/skills");
        std::fs::create_dir_all(&agents_dir).expect("create agents skills dir");

        let found = find_user_skills_dir().await.expect("user skills dir");
        assert_eq!(found, KaosPath::unsafe_from_local_path(&agents_dir));
    })
    .await;
}

#[tokio::test]
async fn test_find_user_skills_dir_uses_codex_candidate() {
    with_current_kaos_scope(async {
        let tmp = TempDir::new().expect("temp dir");
        let home_dir = tmp.path().join("home");
        std::fs::create_dir_all(&home_dir).expect("create home dir");
        let _kaos_guard = FixedHomeKaosGuard::new(KaosPath::unsafe_from_local_path(&home_dir));

        let codex_dir = home_dir.join(".codex/skills");
        std::fs::create_dir_all(&codex_dir).expect("create codex skills dir");

        let found = find_user_skills_dir().await.expect("user skills dir");
        assert_eq!(found, KaosPath::unsafe_from_local_path(&codex_dir));
    })
    .await;
}
