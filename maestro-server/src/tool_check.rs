use std::path::{Path, PathBuf};
use maestro_protocol::{ToolCheckResult, ToolPathSource};

pub(crate) async fn check_tool(tool: String) -> ToolCheckResult {
    let mut configured_path = match crate::tool_config::get(&tool) {
        Ok(path) => path,
        Err(error) => return failed(tool, None, ToolPathSource::NotFound, error),
    };

    let resolved = if let Some(path) = &configured_path {
        let candidate = PathBuf::from(path);
        if is_executable(&candidate) {
            Some((candidate, ToolPathSource::Override))
        } else {
            if let Err(error) = crate::tool_config::set(&tool, None) {
                return failed(tool, configured_path, ToolPathSource::Override, error);
            }
            configured_path = None;
            resolve_executable(&tool).await
        }
    } else {
        resolve_executable(&tool).await
    };

    let Some((path, source)) = resolved else {
        return failed(
            tool,
            configured_path,
            ToolPathSource::NotFound,
            "Executable was not found on the target environment".to_string(),
        );
    };
    let resolved_path = path.to_string_lossy().into_owned();

    match probe(&path).await {
        Ok(version) => {
            if configured_path.is_none() && source != ToolPathSource::Path {
                if let Err(error) = crate::tool_config::set(&tool, Some(resolved_path.clone())) {
                    return failed(tool, None, source, error);
                }
            }
            ToolCheckResult {
                tool,
                available: true,
                version,
                configured_path,
                resolved_path: Some(resolved_path),
                source,
                error: None,
            }
        }
        Err(error) => ToolCheckResult {
            tool,
            available: false,
            version: None,
            configured_path,
            resolved_path: Some(resolved_path),
            source,
            error: Some(error),
        },
    }
}

pub(crate) async fn check_tools(tools: Vec<String>) -> Vec<ToolCheckResult> {
    futures::future::join_all(tools.into_iter().map(check_tool)).await
}

pub(crate) async fn test_tool_path(tool: String, path: String) -> ToolCheckResult {
    let candidate = PathBuf::from(&path);
    if !candidate.is_absolute() {
        return failed(
            tool,
            Some(path),
            ToolPathSource::Override,
            "The configured path must be absolute".to_string(),
        );
    }
    if !is_executable(&candidate) {
        return failed(
            tool,
            Some(path),
            ToolPathSource::Override,
            "The path does not exist or is not executable".to_string(),
        );
    }
    match probe(&candidate).await {
        Ok(version) => ToolCheckResult {
            tool,
            available: true,
            version,
            configured_path: Some(path.clone()),
            resolved_path: Some(path),
            source: ToolPathSource::Override,
            error: None,
        },
        Err(error) => failed(tool, Some(path), ToolPathSource::Override, error),
    }
}

pub(crate) async fn resolve_tool_path(tool: &str) -> Result<PathBuf, String> {
    if let Some(path) = crate::tool_config::get(tool)? {
        let path = PathBuf::from(path);
        if is_executable(&path) {
            return Ok(path);
        }
        crate::tool_config::set(tool, None)?;
    }
    let (path, source) = resolve_executable(tool)
        .await
        .ok_or_else(|| format!("{tool} was not found on the target environment"))?;
    if source != ToolPathSource::Path {
        crate::tool_config::set(tool, Some(path.to_string_lossy().into_owned()))?;
    }
    Ok(path)
}

async fn resolve_executable(tool: &str) -> Option<(PathBuf, ToolPathSource)> {
    if let Ok(path) = which::which(tool) {
        return Some((path, ToolPathSource::Path));
    }

    #[cfg(windows)]
    for directory in persistent_windows_path() {
        if let Some(path) = find_in_directory(&directory, tool) {
            return Some((path, ToolPathSource::SystemEnvironment));
        }
    }

    for directory in known_directories() {
        if let Some(path) = find_in_directory(&directory, tool) {
            return Some((path, ToolPathSource::KnownLocation));
        }
    }

    #[cfg(unix)]
    if let Some(path) = shell_path().await {
        for directory in std::env::split_paths(&path) {
            if let Some(path) = find_in_directory(&directory, tool) {
                return Some((path, ToolPathSource::ShellEnvironment));
            }
        }
    }

    None
}

#[cfg(windows)]
fn persistent_windows_path() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let locations = [
        (HKEY_CURRENT_USER, "Environment"),
        (
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ];
    locations
        .into_iter()
        .filter_map(|(hive, key)| RegKey::predef(hive).open_subkey(key).ok())
        .filter_map(|key| key.get_value::<String, _>("Path").ok())
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .collect()
}

fn known_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            directories.push(PathBuf::from(home).join(".local/bin"));
        }
        directories.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
            PathBuf::from("/opt/local/bin"),
        ]);
    }
    {
        for (variable, suffix) in [
            ("APPDATA", "npm"),
            ("ProgramFiles", "nodejs"),
            ("LOCALAPPDATA", "Programs\\nodejs"),
            ("USERPROFILE", ".local\\bin"),
            ("USERPROFILE", ".volta\\bin"),
        ] {
            if let Some(base) = std::env::var_os(variable) {
                directories.push(PathBuf::from(base).join(suffix));
            }
        }
        for variable in ["NVM_SYMLINK", "NVM_HOME"] {
            if let Some(path) = std::env::var_os(variable) {
                directories.push(PathBuf::from(path));
            }
        }
        if let Some(path) = std::env::var_os("VOLTA_HOME") {
            directories.push(PathBuf::from(path).join("bin"));
        }
    }
    directories
}

fn find_in_directory(directory: &Path, tool: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let names = [
        tool.to_string(),
        format!("{tool}.exe"),
        format!("{tool}.cmd"),
        format!("{tool}.bat"),
    ];
    #[cfg(not(windows))]
    let names = [tool.to_string()];
    names
        .into_iter()
        .map(|name| directory.join(name))
        .find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(unix)]
async fn shell_path() -> Option<String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::process::Command::new(shell)
            .args(["-ilc", "printf '\n__MAESTRO_PATH__%s\n' \"$PATH\""])
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("__MAESTRO_PATH__"))
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

async fn probe(path: &Path) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let mut command = {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
            let mut command = tokio::process::Command::new(
                std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
            );
            command.arg("/d").arg("/c").arg(path).arg("--version");
            command
        } else {
            let mut command = tokio::process::Command::new(path);
            command.arg("--version");
            command
        }
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tokio::process::Command::new(path);
        command.arg("--version");
        command
    };
    prepend_parent_to_path(&mut command, path, None);
    let output = command
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Failed to execute {}: {error}", path.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} --version exited with {}",
            path.display(),
            output.status
        ));
    }
    let raw = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };
    Ok(String::from_utf8(raw).ok().and_then(|value| {
        value
            .lines()
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }))
}

pub(crate) fn prepend_parent_to_path(
    command: &mut tokio::process::Command,
    executable: &Path,
    base: Option<&str>,
) {
    let Some(parent) = executable.parent() else {
        return;
    };
    let base = base
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"));
    let mut paths = vec![parent.to_path_buf()];
    if let Some(base) = base {
        paths.extend(std::env::split_paths(&base));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
}

fn failed(
    tool: String,
    configured_path: Option<String>,
    source: ToolPathSource,
    error: String,
) -> ToolCheckResult {
    ToolCheckResult {
        tool,
        available: false,
        version: None,
        configured_path,
        resolved_path: None,
        source,
        error: Some(error),
    }
}
