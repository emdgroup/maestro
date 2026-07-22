use std::sync::Arc;
use tauri::{Emitter, State};

use crate::core::AppState;

/// Find the best available shell on Windows.
///
/// Priority: PowerShell 7+ (pwsh) from Program Files (highest version) →
/// pwsh on PATH → powershell (5.1) on PATH → cmd.exe.
///
/// Returns an absolute path so portable-pty skips bare-name resolution,
/// which EDR products flag as a reverse-shell pattern.
#[cfg(windows)]
fn resolve_windows_shell() -> String {
    let program_files = std::env::var("ProgramFiles")
        .unwrap_or_else(|_| r"C:\Program Files".to_string());
    let ps_dir = std::path::PathBuf::from(&program_files).join("PowerShell");
    if let Ok(entries) = std::fs::read_dir(&ps_dir) {
        let best = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
            .filter_map(|entry| {
                let version = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
                let exe = entry.path().join("pwsh.exe");
                exe.exists().then_some((version, exe))
            })
            .max_by_key(|(v, _)| *v);
        if let Some((_, path)) = best {
            return path.to_string_lossy().to_string();
        }
    }

    if let Ok(path) = which::which("pwsh") {
        return path.to_string_lossy().to_string();
    }

    if let Ok(path) = which::which("powershell") {
        return path.to_string_lossy().to_string();
    }

    "cmd.exe".to_string()
}

/// Spawn an interactive (task-free) PTY session on a specific branch.
///
/// This creates an execution log with NULL task_id, finds or creates a worktree for the
/// given branch, and spawns an interactive PTY session keyed by log_id.
///
/// # Arguments
/// * `app_state` - Tauri app state with database connection
/// * `project_id` - Project ID
/// * `branch_name` - Branch to open in the worktree
/// * `repo_path` - Repository path
/// * `session_name` - Optional display name for the session
/// * `worktree_id` - Optional worktree ID to use directly
/// * `task_id` - Optional task ID to associate with this execution (updates task status to InProgress)
/// * `task_description` - Optional task description to inject into the PTY 2s after spawn
///
/// # Returns
/// Execution log ID (used as PTY session key for attach_terminal)
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_interactive_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch_name: Option<String>,
    repo_path: String,
    session_name: Option<String>,
    worktree_id: Option<i32>,
    task_id: Option<i32>,
    _task_description: Option<String>,
) -> Result<i32, String> {

    // Resolve project and git connection (local vs remote SSH) — same pattern as create_worktree
    let (project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let is_remote = project.is_remote();

    // For local projects only, canonicalize to resolve symlinks/relative paths
    let repo_path = if is_remote {
        repo_path
    } else {
        std::path::Path::new(&repo_path)
            .canonicalize()
            .map_err(|e| format!("Invalid repository path '{}': {}. Ensure the project directory exists.", repo_path, e))?
            .to_string_lossy()
            .to_string()
    };

    let worktree_abs_path: String = if let Some(wt_id) = worktree_id {
        // DB lookup path — skip git worktree list entirely when caller already knows the worktree ID
        let relative_path: String = {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.query_row(
                "SELECT path FROM worktrees WHERE id = ?",
                rusqlite::params![wt_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Worktree id={} not found: {}", wt_id, e))?
        };
        format!("{}/{}", repo_path, relative_path)
    } else if let Some(ref branch) = branch_name {
        // Use git worktree list rather than DB state: git is the source of truth, the DB may
        // be stale, and get_current_branch only returns the main-worktree HEAD (missing branches
        // in other worktrees).
        let git_worktrees = crate::git::list_worktrees(&git_conn).await?;
        let existing_checkout = git_worktrees.into_iter().find(|wt| {
            wt.branch.as_deref() == Some(branch.as_str())
        });

        if let Some(wt) = existing_checkout {
            wt.path
        } else {
            use crate::models::WORKTREE_DIR;
            let relative_path = format!("{}/{}", WORKTREE_DIR, branch);

            // Ensure parent directory exists (local only — SSH creates dirs automatically via git worktree add)
            if !is_remote {
                tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
                    .await
                    .map_err(|e| format!("Failed to create worktree directory: {}", e))?;
            }

            // Checkout existing branch via SSH-aware git connection (None = checkout, not create)
            crate::git::create_worktree(&git_conn, branch, &relative_path, None).await?;

            // Insert DB row with task_id = NULL
            let now = chrono::Utc::now().to_rfc3339();
            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "INSERT INTO worktrees (project_id, task_id, branch_name, path, created_at) VALUES (?, NULL, ?, ?, ?)",
                    rusqlite::params![project_id, branch, &relative_path, &now],
                )
                .map_err(|e| format!("Failed to insert worktree: {}", e))?;
            }

            app_state.app_handle.emit("worktrees-changed", ()).ok();
            format!("{}/{}", repo_path, relative_path)
        }
    } else {
        // No branch specified → spawn in repo root
        repo_path.clone()
    };

    // Step 2: Assign session key and optionally update task status.
    let now = chrono::Utc::now().to_rfc3339();
    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    if let Some(tid) = task_id {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let changed = conn.execute(
            "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ? AND status = 'Queue'",
            rusqlite::params![&now, tid],
        ).map_err(|e| format!("Failed to update task status: {}", e))?;
        if changed > 0 {
            app_state.app_handle.emit("tasks-changed", ()).ok();
        }
    }

    // Step 3: Spawn PTY session — local or remote depending on project type
    if is_remote {
        let conn_id = project
            .connection_id
            .ok_or("Remote project has no connection_id")?;
        let ssh_session = app_state
            .ssh.get_session(conn_id)
            .await
            .ok_or("SSH session not active — connect to the remote host first")?;

        let pty_handle = ssh_session
            .spawn_remote_pty(80, 24, log_id)
            .await?;

        // cd into the worktree directory and clear the screen.
        // Single-quote the path to prevent command injection.
        let escaped_path = worktree_abs_path.replace('\'', "'\\''");
        let init_cmd = format!("cd '{}' && clear\n", escaped_path);
        pty_handle.write_tx
            .send(crate::connectivity::ssh::SshWriteOp::Data(init_cmd.into_bytes()))
            .await
            .map_err(|e| format!("Failed to send init command to remote shell: {}", e))?;

        app_state.ssh.pty_sessions.lock().await.insert(log_id, pty_handle);
    } else if let crate::models::GitConnection::Wsl { ref distro, .. } = git_conn {
        let shell = "wsl.exe".to_string();
        let args = vec![
            "-d".to_string(),
            distro.clone(),
            "--cd".to_string(),
            worktree_abs_path.clone(),
        ];
        // cwd for wsl.exe process itself is irrelevant — --cd sets the WSL working dir.
        // Use a safe Windows path so the PTY spawn doesn't fail on a Linux path.
        let windows_cwd = std::env::var("USERPROFILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("C:\\"));
        let pty_session = crate::execution::spawn_agent_cli_pty(
            log_id,
            shell,
            args,
            windows_cwd,
        )
        .await?;

        let app_state_arc: Arc<AppState> = (*app_state).clone();
        let mut sessions = app_state_arc.pty.sessions.lock().await;
        sessions.insert(
            log_id,
            Arc::new(tokio::sync::Mutex::new(pty_session)),
        );
        drop(sessions);
    } else {
        #[cfg(windows)]
        let shell = resolve_windows_shell();
        #[cfg(not(windows))]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let pty_session = crate::execution::spawn_agent_cli_pty(
            log_id,
            shell,
            vec![],
            std::path::PathBuf::from(&worktree_abs_path),
        )
        .await?;

        let app_state_arc: Arc<AppState> = (*app_state).clone();
        let mut sessions = app_state_arc.pty.sessions.lock().await;
        sessions.insert(
            log_id,
            Arc::new(tokio::sync::Mutex::new(pty_session)),
        );
        drop(sessions);
    }

    // Store PTY session metadata for get_active_sessions
    {
        use crate::models::worktree::PtySessionMeta;
        let meta = PtySessionMeta {
            session_name: session_name.clone(),
            started_at: now.clone(),
            task_id,
            task_name: None,
            branch_name: branch_name.clone(),
            cwd: worktree_abs_path.clone(),
            project_id: Some(project_id),
        };
        app_state.pty.session_meta.lock().await.insert(log_id, meta);
    }
    app_state.app_handle.emit("sessions-changed", ()).ok();

    Ok(log_id)
}
