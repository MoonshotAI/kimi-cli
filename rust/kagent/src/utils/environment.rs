use kaos::KaosPath;

#[derive(Clone, Debug)]
pub struct Environment {
    pub os_kind: String,
    pub os_arch: String,
    pub os_version: String,
    pub shell_name: String,
    pub shell_path: KaosPath,
}

impl Environment {
    pub async fn detect() -> Self {
        let os_kind = match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            "linux" => "Linux",
            other => other,
        }
        .to_string();

        let os_arch = std::env::consts::ARCH.to_string();
        let os_version = sysinfo::System::long_os_version().unwrap_or_default();

        if os_kind == "Windows" {
            return Environment {
                os_kind,
                os_arch,
                os_version,
                shell_name: "Windows PowerShell".to_string(),
                shell_path: KaosPath::from("powershell.exe".into()),
            };
        }

        let mut shell_name = "sh".to_string();
        let mut shell_path = KaosPath::from("/bin/sh".into());
        for candidate in ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"] {
            let path = KaosPath::from(candidate.into());
            if path.is_file(true).await {
                shell_name = "bash".to_string();
                shell_path = path;
                break;
            }
        }

        Environment {
            os_kind,
            os_arch,
            os_version,
            shell_name,
            shell_path,
        }
    }
}
