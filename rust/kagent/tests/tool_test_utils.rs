use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use kagent::config::{
    ModelCapability, MoonshotFetchConfig, MoonshotSearchConfig, get_default_config,
};
use kagent::llm::LLM;
use kagent::metadata::WorkDirMeta;
use kagent::session::Session;
use kagent::soul::agent::{Agent, BuiltinSystemPromptArgs, LaborMarket, Runtime};
use kagent::soul::approval::Approval;
use kagent::soul::denwarenji::DenwaRenji;
use kagent::soul::toolset::KimiToolset;
use kagent::utils::Environment;
use kagent::wire::WireFile;
use kaos::{
    CurrentKaosToken, Kaos, KaosPath, LocalKaos, get_current_kaos, reset_current_kaos,
    set_current_kaos,
};
use kosong::chat_provider::echo::echo::EchoChatProvider;
use tempfile::TempDir;

pub struct RuntimeFixture {
    pub runtime: Runtime,
    _work_dir: TempDir,
    _share_dir: TempDir,
}

impl RuntimeFixture {
    #[allow(dead_code)]
    pub fn new() -> Self {
        let mut capabilities = HashSet::new();
        capabilities.insert(ModelCapability::ImageIn);
        capabilities.insert(ModelCapability::VideoIn);
        Self::with_capabilities(capabilities)
    }

    pub fn with_capabilities(capabilities: HashSet<ModelCapability>) -> Self {
        let work_dir = TempDir::new().expect("temp work dir");
        let share_dir = TempDir::new().expect("temp share dir");

        let work_path = KaosPath::from(PathBuf::from(work_dir.path()));
        let work_dir_meta = WorkDirMeta {
            path: work_path.to_string_lossy(),
            kaos: get_current_kaos().name().to_string(),
            last_session_id: None,
        };

        let context_file = share_dir.path().join("context.jsonl");
        std::fs::write(&context_file, "").expect("context file");
        let wire_file = WireFile::new(share_dir.path().join("wire.jsonl"));

        let session = Session {
            id: "test".to_string(),
            work_dir: work_path.clone(),
            work_dir_meta,
            context_file,
            wire_file,
            title: "Test Session".to_string(),
            updated_at: 0.0,
        };

        let mut config = get_default_config();
        config.services.moonshot_search = Some(MoonshotSearchConfig {
            base_url: "https://api.kimi.com/coding/v1/search".to_string(),
            api_key: "test-api-key".to_string(),
            custom_headers: None,
        });
        config.services.moonshot_fetch = Some(MoonshotFetchConfig {
            base_url: "https://api.kimi.com/coding/v1/fetch".to_string(),
            api_key: "test-api-key".to_string(),
            custom_headers: None,
        });

        let llm = LLM {
            chat_provider: Box::new(EchoChatProvider),
            max_context_size: 100_000,
            capabilities,
            model_config: None,
            provider_config: None,
        };

        let environment = Environment {
            os_kind: if cfg!(windows) { "Windows" } else { "Unix" }.to_string(),
            os_arch: "x86_64".to_string(),
            os_version: "1.0".to_string(),
            shell_name: if cfg!(windows) {
                "Windows PowerShell"
            } else {
                "bash"
            }
            .to_string(),
            shell_path: if cfg!(windows) {
                KaosPath::from(PathBuf::from("powershell.exe"))
            } else {
                KaosPath::from(PathBuf::from("/bin/bash"))
            },
        };

        let runtime = Runtime {
            config,
            llm: Some(Arc::new(llm)),
            session: session.clone(),
            builtin_args: BuiltinSystemPromptArgs {
                KIMI_NOW: "1970-01-01T00:00:00+00:00".to_string(),
                KIMI_WORK_DIR: work_path,
                KIMI_WORK_DIR_LS: "Test ls content".to_string(),
                KIMI_AGENTS_MD: "Test agents content".to_string(),
                KIMI_SKILLS: "No skills found.".to_string(),
            },
            denwa_renji: Arc::new(tokio::sync::Mutex::new(DenwaRenji::new())),
            approval: Arc::new(Approval::new(true)),
            labor_market: Arc::new(tokio::sync::Mutex::new(LaborMarket::new())),
            environment,
            skills: Default::default(),
        };

        let agent = Agent {
            name: "Mocker".to_string(),
            system_prompt: "You are a mock agent for testing.".to_string(),
            toolset: Arc::new(tokio::sync::Mutex::new(KimiToolset::new())),
            runtime: runtime.copy_for_fixed_subagent(),
        };

        runtime
            .labor_market
            .try_lock()
            .expect("lock labor market")
            .add_fixed_subagent(
                "mocker".to_string(),
                agent,
                "The mock agent for testing purposes.".to_string(),
            );

        Self {
            runtime,
            _work_dir: work_dir,
            _share_dir: share_dir,
        }
    }
}

#[allow(dead_code)]
pub struct TestKaos {
    inner: LocalKaos,
    cwd: Mutex<KaosPath>,
}

#[allow(dead_code)]
impl TestKaos {
    pub fn new(cwd: KaosPath) -> Self {
        Self {
            inner: LocalKaos::new(),
            cwd: Mutex::new(cwd),
        }
    }
}

#[async_trait::async_trait]
impl Kaos for TestKaos {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn normpath(&self, path: &kaos::StrOrKaosPath<'_>) -> KaosPath {
        self.inner.normpath(path)
    }

    fn home(&self) -> KaosPath {
        self.inner.home()
    }

    fn cwd(&self) -> KaosPath {
        self.cwd.lock().unwrap().clone()
    }

    async fn chdir(&self, path: &KaosPath) -> anyhow::Result<()> {
        *self.cwd.lock().unwrap() = path.clone();
        Ok(())
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

    async fn read_lines_stream(&self, path: &KaosPath) -> anyhow::Result<kaos::LineStream> {
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

    async fn exec(&self, args: &[String]) -> anyhow::Result<Box<dyn kaos::KaosProcess>> {
        self.inner.exec(args).await
    }
}

#[allow(dead_code)]
pub struct TestKaosGuard {
    token: Option<CurrentKaosToken>,
}

#[allow(dead_code)]
impl TestKaosGuard {
    pub fn new(cwd: KaosPath) -> Self {
        let test_kaos = Arc::new(TestKaos::new(cwd));
        let token = set_current_kaos(test_kaos);
        Self { token: Some(token) }
    }
}

impl Drop for TestKaosGuard {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            reset_current_kaos(token);
        }
    }
}

pub fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
