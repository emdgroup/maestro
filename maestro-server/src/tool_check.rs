use maestro_protocol::ToolCheckResult;

pub(crate) async fn probe_tool(tool: &str) -> (bool, Option<String>) {
    // On Windows, tools like npx/uvx are .cmd batch files — CreateProcess won't find them
    // without going through cmd.exe. Check exit code too since cmd.exe always launches.
    #[cfg(windows)]
    let result = {
        use crate::command_ext::NoConsoleWindow;
        tokio::process::Command::new("cmd")
            .args(["/c", tool, "--version"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
    };
    #[cfg(not(windows))]
    let result = tokio::process::Command::new(tool)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match result {
        Err(_) => (false, None),
        Ok(out) => {
            #[cfg(windows)]
            if !out.status.success() {
                return (false, None);
            }
            let raw = if out.stdout.is_empty() { out.stderr } else { out.stdout };
            let ver = String::from_utf8(raw)
                .ok()
                .map(|s| s.lines().next().unwrap_or("").trim().to_string())
                .filter(|s| !s.is_empty());
            (true, ver)
        }
    }
}

pub(crate) async fn check_tools(tools: Vec<String>) -> Vec<ToolCheckResult> {
    let handles: Vec<_> = tools
        .into_iter()
        .map(|tool| {
            tokio::spawn(async move {
                let (available, version) = probe_tool(&tool).await;
                ToolCheckResult { tool, available, version }
            })
        })
        .collect();

    futures::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(Result::ok)
        .collect()
}
