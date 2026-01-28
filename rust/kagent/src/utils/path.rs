use std::path::{Path, PathBuf};

use kaos::KaosPath;

pub async fn next_available_rotation(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    if tokio::fs::metadata(parent).await.is_err() {
        return None;
    }

    let base_name = path.file_stem()?.to_string_lossy().to_string();
    let suffix = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    let mut max_num = 0u64;
    if let Ok(entries) = tokio::fs::read_dir(parent).await {
        let mut entries = entries;
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                if let Some(num) = parse_rotation_suffix(name, &base_name, &suffix) {
                    if num > max_num {
                        max_num = num;
                    }
                }
            }
        }
    }

    let mut next_num = max_num + 1;
    loop {
        let candidate = parent.join(format!("{base_name}_{next_num}{suffix}"));
        if reserve_rotation_path(&candidate).await {
            return Some(candidate);
        }
        next_num += 1;
    }
}

async fn reserve_rotation_path(path: &Path) -> bool {
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    match options.open(path).await {
        Ok(file) => {
            drop(file);
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => false,
    }
}

pub async fn list_directory(work_dir: &KaosPath) -> String {
    let entries = match work_dir.iterdir().await {
        Ok(entries) => entries,
        Err(_) => return String::new(),
    };
    let mut lines = Vec::new();
    for entry in entries {
        match entry.stat(true).await {
            Ok(stat) => {
                let mode = format_mode(stat.st_mode);
                lines.push(format!("{mode} {:>10} {}", stat.st_size, entry.name()));
            }
            Err(_) => {
                lines.push(format!(
                    "?--------- {:>10} {} [stat failed]",
                    "?",
                    entry.name()
                ));
            }
        }
    }
    lines.join("\n")
}

pub fn shorten_home(path: &KaosPath) -> KaosPath {
    let home = KaosPath::home();
    if let Ok(relative) = path.relative_to(&home) {
        return KaosPath::new("~") / &relative;
    }
    path.clone()
}

pub fn is_within_directory(path: &KaosPath, directory: &KaosPath) -> bool {
    let path_str = path.to_string_lossy();
    let dir_str = directory.to_string_lossy();
    Path::new(&path_str)
        .strip_prefix(Path::new(&dir_str))
        .is_ok()
}

fn parse_rotation_suffix(name: &str, base_name: &str, suffix: &str) -> Option<u64> {
    if !name.starts_with(base_name) || !name.ends_with(suffix) {
        return None;
    }
    let middle = &name[base_name.len()..name.len() - suffix.len()];
    let middle = middle.strip_prefix('_')?;
    middle.parse::<u64>().ok()
}

fn format_mode(mode: u32) -> String {
    let mut out = String::new();
    out.push(if mode & 0o040000 != 0 { 'd' } else { '-' });
    out.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    out.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    out.push(if mode & 0o100 != 0 { 'x' } else { '-' });
    out.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    out.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    out.push(if mode & 0o010 != 0 { 'x' } else { '-' });
    out.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    out.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    out.push(if mode & 0o001 != 0 { 'x' } else { '-' });
    out
}
