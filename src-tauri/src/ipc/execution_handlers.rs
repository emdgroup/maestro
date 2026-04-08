use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{ExecutionLog, ExecutionStatus, ExecutionWithTask};
use crate::db::AppState;
use crate::ssh::SshWriteOp;

/// Drain the Ready queue for auto-mode execution
///
/// Checks if auto_mode is enabled in settings. If so, counts currently running
/// executions for the project and returns task IDs that should be started next,
/// up to max_concurrent_agents. Tasks are ordered by priority (Urgent, High,
/// Medium, Low) then creation date.
///
/// # Arguments
/// * `app_state` - Tauri app state with database connection
/// * `project_id` - Project to drain the queue for
/// * `project_path` - Repository path (reserved for future use)
///
/// # Returns
/// Vec of task_ids that should be executed. Frontend calls spawn_interactive_execution for each.
/// Returns empty vec if auto_mode is disabled or concurrency limit is already reached.
#[tauri::command]
#[specta::specta]
pub async fn drain_ready_queue(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    project_path: String,
) -> Result<Vec<i32>, String> {
    let _ = project_path; // reserved for future use

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Load settings to check auto_mode and max_concurrent_agents
    let settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    if !settings.auto_mode {
        return Ok(vec![]);
    }

    // Count currently running executions for this project
    let running_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM execution_logs el
         INNER JOIN tasks t ON t.id = el.task_id
         WHERE t.project_id = ? AND el.status = 'running'",
        rusqlite::params![project_id],
        |row| row.get(0),
    ).map_err(|e| format!("Failed to count running executions: {}", e))?;

    let slots_available = settings.max_concurrent_agents - running_count;
    if slots_available <= 0 {
        return Ok(vec![]);
    }

    // Get Ready tasks ordered by priority then created_at
    // Priority order: Urgent=0, High=1, Medium=2, Low=3
    let mut stmt = conn.prepare(
        "SELECT id FROM tasks
         WHERE project_id = ? AND status = 'Ready'
         ORDER BY CASE priority
             WHEN 'Urgent' THEN 0
             WHEN 'High' THEN 1
             WHEN 'Medium' THEN 2
             WHEN 'Low' THEN 3
             ELSE 4
         END ASC, created_at ASC
         LIMIT ?"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let task_ids: Vec<i32> = stmt.query_map(
        rusqlite::params![project_id, slots_available],
        |row| row.get(0),
    ).map_err(|e| format!("Failed to query ready tasks: {}", e))?
    .filter_map(|r| match r {
        Ok(id) => Some(id),
        Err(_) => None,
    })
    .collect();

    Ok(task_ids)
}

/// Get execution logs for a task
#[tauri::command]
#[specta::specta]
pub fn get_execution_logs(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<ExecutionLog>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, task_id, status, output, terminal_output, started_at, completed_at, error_event
         FROM execution_logs
         WHERE task_id = ?
         ORDER BY started_at DESC"
    ).map_err(|e| e.to_string())?;

    let logs = stmt.query_map(rusqlite::params![task_id], |row| {
        let status_str: String = row.get(2)?;
        let status = match status_str.as_str() {
            "complete" => ExecutionStatus::Complete,
            "failed" => ExecutionStatus::Failed,
            "paused" => ExecutionStatus::Paused,
            "cancelled" => ExecutionStatus::Cancelled,
            _ => ExecutionStatus::Running,
        };

        // Parse error_event from JSON if present
        let error_event = row.get::<_, Option<String>>(7)?
            .and_then(|s| serde_json::from_str(&s).ok());

        Ok(ExecutionLog {
            id: row.get(0)?,
            task_id: row.get(1)?,
            status,
            output: row.get(3)?,
            terminal_output: row.get(4)?,
            started_at: row.get(5)?,
            completed_at: row.get(6)?,
            error_event,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for log in logs {
        result.push(log.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Retry a paused execution
///
/// Resets the execution log status to 'running' so the task can be resumed.
/// The frontend should use spawn_interactive_execution to create a new PTY session.
#[tauri::command]
#[specta::specta]
pub async fn retry_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    let _ = (project_id, repo_path); // unused — PTY sessions are managed by spawn_interactive_execution

    // Reset the most recent execution log for this task back to running
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let log_id: i32 = conn.query_row(
        "SELECT id FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
        rusqlite::params![task_id],
        |row| row.get(0),
    ).map_err(|e| format!("No execution log found for task {}: {}", task_id, e))?;

    conn.execute(
        "UPDATE execution_logs SET status = 'running', completed_at = NULL WHERE id = ?",
        rusqlite::params![log_id],
    ).map_err(|e| format!("Failed to reset execution log: {}", e))?;

    Ok(log_id)
}

/// Cancel a paused execution
#[tauri::command]
#[specta::specta]
pub fn cancel_execution(
    app_state: State<Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE execution_logs SET status = 'cancelled', completed_at = ? WHERE id = ?",
        rusqlite::params![&now, log_id],
    )
    .map_err(|e| format!("Failed to cancel execution: {}", e))?;

    Ok(())
}

/// Attach to a PTY session and stream output to frontend
///
/// Opens a Tauri channel and begins streaming PTY output to the frontend.
/// Optionally prepends terminal history from the execution log (if available).
/// The streaming continues until the PTY process ends or the channel is closed.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID to attach to
/// * `output_channel` - Tauri IPC channel for streaming output
/// * `include_history` - If true, prepend terminal_output from execution log to stream
///
/// # Returns
/// `Result<(), String>` - Ok if streaming started, Err if task not found
///
/// # Behavior
/// When `include_history` is true:
/// 1. Fetches the terminal_output from the most recent execution log
/// 2. Sends entire history as initial message to establish context
/// 3. Then continues streaming live PTY output as normal
/// This ensures the frontend sees the full terminal context when attaching.
#[tauri::command]
#[specta::specta]
pub async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    // Check remote SSH PTY sessions first
    let ssh_handle = {
        let sessions = app_state.ssh_pty_sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    if let Some(handle) = ssh_handle {
        let history = Arc::clone(&handle.history);
        let notify = Arc::clone(&handle.notify);
        let process_ended = Arc::clone(&handle.process_ended);
        let log_id = handle.log_id;
        let app_state_arc = (*app_state).clone();

        tokio::spawn(async move {
            use std::sync::atomic::Ordering;
            let is_dead = process_ended.load(Ordering::Acquire);

            if is_dead {
                // Dead session: read terminal_output from DB by log_id and send as single write
                let db_output: Option<String> = {
                    if let Ok(conn) = app_state_arc.db.lock() {
                        conn.query_row(
                            "SELECT terminal_output FROM execution_logs WHERE id = ?",
                            rusqlite::params![log_id],
                            |row| row.get::<_, Option<String>>(0),
                        ).ok().flatten()
                    } else {
                        None
                    }
                };
                if let Some(text) = db_output {
                    if !text.is_empty() {
                        let _ = output_channel.send(text);
                    }
                }
                return;
            }

            // Live session: start at pos=end (skip all history).
            // SIGWINCH from fitAddon.fit() -> resizeTerminal() will trigger
            // the running program to repaint its current screen.
            let mut pos: usize = {
                let hist = history.lock().await;
                hist.len()
            };

            loop {
                {
                    let hist = history.lock().await;
                    if pos < hist.len() {
                        let slice = &hist[pos..];
                        if !slice.is_empty() {
                            if output_channel.send(slice.to_string()).is_err() {
                                return;
                            }
                            pos = hist.len();
                        }
                    }
                }
                // Check process_ended after draining
                if process_ended.load(Ordering::Acquire) {
                    // Final drain after process ended
                    let hist = history.lock().await;
                    if pos < hist.len() {
                        let slice = &hist[pos..];
                        if !slice.is_empty() {
                            let _ = output_channel.send(slice.to_string());
                        }
                    }
                    // Persist history to DB for dead-session recovery
                    let history_snapshot: String = hist.clone();
                    drop(hist);
                    if !history_snapshot.is_empty() {
                        if let Ok(conn) = app_state_arc.db.lock() {
                            let _ = conn.execute(
                                "UPDATE execution_logs SET terminal_output = ? WHERE id = ?",
                                rusqlite::params![&history_snapshot, log_id],
                            );
                        }
                    }
                    break;
                }
                notify.notified().await;
            }
        });
        return Ok(());
    }

    // Get local PTY session from AppState
    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions); // Release lock

    // If requested, send terminal history first
    if include_history.unwrap_or(false) {
        // Drop conn before calling output_channel.send() — never hold std::sync::Mutex across IPC I/O
        let history: Option<String> = {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.query_row(
                "SELECT terminal_output FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
                rusqlite::params![task_id],
                |row| row.get::<_, Option<String>>(0)
            ).ok().flatten()
        };

        if let Some(history_text) = history {
            if !history_text.is_empty() {
                if output_channel.send(history_text).is_err() {
                    return Err("Channel closed before history could be sent".to_string());
                }
            }
        }
    }

    // Clone AppState Arc for use in the background task (State<'_> can't cross await points)
    let app_state_arc = (*app_state).clone();

    // Spawn background task to stream PTY output
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

        // Acquire the PTY reader before entering spawn_blocking — try_clone_reader() needs async locks.
        // Drop guards explicitly so they don't straddle an await point.
        let reader = {
            let session_lock = session.lock().await;
            let master = session_lock.master.lock().await;
            let result = master.try_clone_reader();
            drop(master);
            drop(session_lock);
            match result {
                Ok(r) => r,
                Err(e) => {
                    let _ = output_channel.send(
                        format!("\r\n\x1b[31m[Terminal error: {}]\x1b[0m\r\n", e)
                    );
                    return;
                }
            }
        };

        // Sender runs concurrently with the reader, forwarding output to the frontend in real time.
        // It also accumulates output for DB persistence once the session ends.
        let sender_task = tokio::spawn(async move {
            let mut accumulated = String::new();
            while let Some(output) = rx.recv().await {
                accumulated.push_str(&output);
                if output_channel.send(output).is_err() {
                    break;
                }
            }
            accumulated
        });

        // PTY reader in a blocking thread — std::io::Read::read() is a blocking syscall and
        // must not run on the tokio async thread pool (it would block a worker thread indefinitely).
        let tx_reader = tx.clone();
        let reader_task = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        if tx_reader.blocking_send(output).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait for the reader to finish (PTY EOF = process exited)
        let _ = reader_task.await;

        // Check exit code while session is still available
        let exit_code: Option<u32> = {
            let sess = session.lock().await;
            let mut child = sess.child.lock().await;
            child.try_wait().ok().flatten().map(|s| s.exit_code())
        };

        // Send exit notification through the mpsc channel so sender_task forwards it to the frontend
        let exit_msg = match exit_code {
            Some(0) => "\r\n\x1b[32m[Process exited]\x1b[0m\r\n".to_string(),
            Some(code) => format!("\r\n\x1b[31m[Process exited with code {}]\x1b[0m\r\n", code),
            None => "\r\n\x1b[33m[Process ended]\x1b[0m\r\n".to_string(),
        };
        let _ = tx.send(exit_msg).await;
        drop(tx); // both senders now dropped — sender_task drains exit_msg then finishes

        // Wait for sender to flush everything including the exit message
        let accumulated = sender_task.await.unwrap_or_else(|_| String::new());

        // Persist terminal output for historical replay in DeadSessionTerminal
        if !accumulated.is_empty() {
            if let Ok(conn) = app_state_arc.db.lock() {
                let _ = conn.execute(
                    "UPDATE execution_logs SET terminal_output = COALESCE(terminal_output, '') || ?1 WHERE id = ?2",
                    rusqlite::params![&accumulated, task_id],
                );
            }
        }

        // Update execution log status
        let now = Utc::now().to_rfc3339();
        let status = match exit_code {
            Some(0) => "complete",
            _ => "failed",
        };
        if let Ok(conn) = app_state_arc.db.lock() {
            let _ = conn.execute(
                "UPDATE execution_logs SET status = ?1, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![status, &now, task_id],
            );
        }
    });

    Ok(())
}

/// Send input to a PTY session
///
/// Writes data to the PTY master, which is delivered to the child process stdin.
/// Supports special control sequences:
/// - "\x03" (Ctrl+C) → sends SIGINT signal (interrupt) via PTY layer
/// - "\x1a" (Ctrl+Z) → sends SIGTSTP signal (suspend) via PTY layer
/// - Regular text and newlines → written directly to PTY stdin
///
/// The PTY layer automatically converts control sequences to signals that are
/// delivered to the foreground process group.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `input` - Data to send to the PTY (can be control sequences or regular text)
///
/// # Returns
/// `Result<(), String>` - Ok if input sent, Err if session not found or write failed
///
/// # Examples
/// - Regular text: "ls -la\n" → written to stdin
/// - Ctrl+C: "\x03" → converted to SIGINT by PTY layer
/// - Ctrl+Z: "\x1a" → converted to SIGTSTP by PTY layer
#[tauri::command]
#[specta::specta]
pub async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    input: String,
) -> Result<(), String> {
    // Check remote SSH PTY sessions first
    let ssh_handle = {
        let sessions = app_state.ssh_pty_sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    if let Some(handle) = ssh_handle {
        handle
            .write_tx
            .send(SshWriteOp::Data(input.into_bytes()))
            .await
            .map_err(|e| format!("Failed to send input to remote PTY: {}", e))?;
        return Ok(());
    }

    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

    // Write directly to PTY - the PTY layer handles conversion of control sequences to signals
    let session_lock = session.lock().await;
    session_lock.write_input(input.as_bytes()).await
}

/// Resize a PTY session to new dimensions
///
/// Changes the terminal size and sends SIGWINCH to the PTY process.
/// Used when the frontend terminal is resized.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `cols` - New column width
/// * `rows` - New row height
///
/// # Returns
/// `Result<(), String>` - Ok if resized, Err if session not found or resize failed
#[tauri::command]
#[specta::specta]
pub async fn resize_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Check remote SSH PTY sessions first
    let ssh_handle = {
        let sessions = app_state.ssh_pty_sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    if let Some(handle) = ssh_handle {
        let _ = handle
            .write_tx
            .send(SshWriteOp::Resize(cols as u32, rows as u32))
            .await;
        return Ok(());
    }

    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

    let session_lock = session.lock().await;
    session_lock.resize_pty(cols, rows).await
}

/// Append terminal output to an execution log for persistence
///
/// Persists streamed PTY output to the database for execution history.
/// Called periodically (via tokio::time::interval) or when accumulating large chunks
/// to avoid excessive database writes.
///
/// # Arguments
/// * `state` - Tauri app state with database connection
/// * `task_id` - Task ID being executed
/// * `output` - Terminal output chunk to append
///
/// # Returns
/// `Result<(), String>` - Ok if append successful, Err on database error
///
/// # Behavior
/// - Appends output to most recent execution log for this task
/// - Uses COALESCE to handle NULL terminal_output gracefully
/// - Only updates logs with status 'running', 'failed', or 'complete'
#[tauri::command]
#[specta::specta]
pub async fn append_terminal_output(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
    output: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Subquery targets the most recent execution log for this task
    let result = conn.execute(
        "UPDATE execution_logs
         SET terminal_output = COALESCE(terminal_output, '') || ?1
         WHERE id = (
             SELECT id FROM execution_logs
             WHERE task_id = ?2 AND status IN ('running', 'failed', 'complete')
             ORDER BY id DESC LIMIT 1
         )",
        rusqlite::params![&output, task_id],
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to append terminal output: {}", e)),
    }
}

/// Detach from a PTY session
///
/// Stops streaming PTY output to the frontend.
/// The actual cleanup happens when the channel is dropped on the frontend.
/// The streaming tasks in attach_terminal will exit when they detect the channel is closed.
#[tauri::command]
#[specta::specta]
pub async fn detach_terminal(
    _app_state: State<'_, Arc<AppState>>,
    _task_id: i32,
) -> Result<(), String> {
    // Note: The actual cleanup happens when the channel is dropped on the frontend.
    // The streaming tasks in attach_terminal will exit when they detect the channel is closed.
    // We don't need to explicitly stop anything here — just return.
    Ok(())
}

/// Pause a running agent execution by sending SIGSTOP to the process
#[tauri::command]
#[specta::specta]
pub async fn pause_agent_execution(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
    let exec_log = crate::db::get_current_execution_log(&conn, task_id)
        .map_err(|e| format!("Failed to get execution log: {}", e))?;
    crate::db::pause_execution_log(&conn, exec_log.id)
        .map_err(|e| format!("Failed to pause execution: {}", e))?;

    // TODO: Send SIGSTOP to running process (implementation depends on process handle management)
    // For now, we just update the database status. Full process pause requires process handle tracking.

    Ok(())
}

/// Resume a paused agent execution
///
/// Resets the execution log status to 'running' so the task can be resumed.
/// The frontend should use spawn_interactive_execution to create a new PTY session.
#[tauri::command]
#[specta::specta]
pub async fn resume_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    let _ = (project_id, repo_path); // unused — PTY sessions are managed by spawn_interactive_execution

    // Reset the most recent execution log for this task back to running
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let log_id: i32 = conn.query_row(
        "SELECT id FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
        rusqlite::params![task_id],
        |row| row.get(0),
    ).map_err(|e| format!("No execution log found for task {}: {}", task_id, e))?;

    conn.execute(
        "UPDATE execution_logs SET status = 'running', completed_at = NULL WHERE id = ?",
        rusqlite::params![log_id],
    ).map_err(|e| format!("Failed to reset execution log: {}", e))?;

    Ok(log_id)
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
/// * `label` - Optional display label for the session
///
/// # Returns
/// Execution log ID (used as PTY session key for attach_terminal)
#[tauri::command]
#[specta::specta]
pub async fn spawn_interactive_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch_name: String,
    repo_path: String,
    label: Option<String>,
) -> Result<i32, String> {
    let _ = label;

    // Resolve project and git connection (local vs remote SSH) — same pattern as create_worktree
    let (project, git_conn) = crate::db::get_project_with_git_conn(&app_state, project_id).await?;
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

    // Use git worktree list rather than DB state: git is the source of truth, the DB may
    // be stale, and get_current_branch only returns the main-worktree HEAD (missing branches
    // in other worktrees).
    let git_worktrees = crate::git::list_worktrees(&git_conn).await?;
    let existing_checkout = git_worktrees.into_iter().find(|wt| {
        wt.branch.as_deref() == Some(branch_name.as_str())
    });

    let worktree_abs_path: String = if let Some(wt) = existing_checkout {
        wt.path
    } else {
        use crate::models::WORKTREE_DIR;
        let relative_path = format!("{}/{}", WORKTREE_DIR, branch_name);

        // Ensure parent directory exists (local only — SSH creates dirs automatically via git worktree add)
        if !is_remote {
            tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
                .await
                .map_err(|e| format!("Failed to create worktree directory: {}", e))?;
        }

        // Checkout existing branch via SSH-aware git connection (None = checkout, not create)
        crate::git::create_worktree(&git_conn, &branch_name, &relative_path, None).await?;

        // Insert DB row with task_id = NULL
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.execute(
                "INSERT INTO worktrees (project_id, task_id, branch_name, path, created_at) VALUES (?, NULL, ?, ?, ?)",
                rusqlite::params![project_id, &branch_name, &relative_path, &now],
            )
            .map_err(|e| format!("Failed to insert worktree: {}", e))?;
        }

        format!("{}/{}", repo_path, relative_path)
    };

    // Step 2: Create execution log with task_id = NULL, storing branch_name directly
    // so list_executions_with_task_info can display the correct branch without a worktree JOIN.
    let now = chrono::Utc::now().to_rfc3339();
    let log_id: i32 = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, status, started_at) VALUES (NULL, ?, 'running', ?)",
            rusqlite::params![&branch_name, &now],
        )
        .map_err(|e| format!("Failed to create execution log: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    // Step 3: Spawn PTY session — local or remote depending on project type
    if is_remote {
        let conn_id = project
            .connection_id
            .ok_or("Remote project has no connection_id")?;
        let ssh_session = app_state
            .get_ssh_session(conn_id)
            .await
            .ok_or("SSH session not active — connect to the remote host first")?;

        // Start the user's configured login shell via SSH request_shell. We send
        // `cd && claude` as input so the user can quit claude and still have a working shell.
        let pty_handle = ssh_session
            .spawn_remote_pty(80, 24, log_id)
            .await?;

        // Send `cd` + `claude` as shell input so claude starts automatically.
        // The shell buffers stdin, so sending immediately is safe — no sleep needed.
        // Single-quote the path and escape any embedded single quotes.
        let escaped_path = worktree_abs_path.replace('\'', "'\\''");
        let init_cmd = format!("cd '{}' && clear && claude\n", escaped_path);
        pty_handle.write_tx
            .send(crate::ssh::SshWriteOp::Data(init_cmd.into_bytes()))
            .await
            .map_err(|e| format!("Failed to send init command to remote shell: {}", e))?;

        app_state.ssh_pty_sessions.lock().await.insert(log_id, pty_handle);
    } else {
        let pty_session = crate::process::spawn_agent_cli_pty(
            log_id,
            "claude".to_string(),
            vec![],
            std::path::PathBuf::from(&worktree_abs_path),
        )
        .await?;

        let app_state_arc: Arc<AppState> = (*app_state).clone();
        let mut sessions = app_state_arc.pty_sessions.lock().await;
        sessions.insert(
            log_id,
            Arc::new(tokio::sync::Mutex::new(pty_session)),
        );
        drop(sessions);
    }

    Ok(log_id)
}

/// Delete an execution log and clean up its PTY session if it exists.
#[tauri::command]
#[specta::specta]
pub async fn delete_execution_log(
    app_state: State<'_, Arc<AppState>>,
    execution_id: i32,
) -> Result<(), String> {
    // First, clean up PTY session if it exists
    let mut sessions = app_state.pty_sessions.lock().await;
    sessions.remove(&execution_id);
    drop(sessions);

    // Delete from database
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "DELETE FROM execution_logs WHERE id = ?",
        rusqlite::params![execution_id],
    )
    .map_err(|e| format!("Failed to delete execution log: {}", e))?;

    Ok(())
}

/// List all executions for a project, enriched with task name and worktree branch.
/// Used by the Agents View sidebar.
#[tauri::command]
#[specta::specta]
pub fn list_executions_with_task_info(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<ExecutionWithTask>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT el.id, el.task_id, t.name AS task_name,
                COALESCE(el.branch_name, w.branch_name) AS branch_name,
                el.status, el.started_at, el.completed_at, el.terminal_output
         FROM execution_logs el
         LEFT JOIN tasks t ON t.id = el.task_id
         LEFT JOIN worktrees w ON el.task_id IS NOT NULL AND w.task_id = el.task_id
         WHERE t.project_id = ?1 OR (el.task_id IS NULL AND el.branch_name IS NOT NULL)
         ORDER BY el.started_at DESC"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let results = stmt.query_map(rusqlite::params![project_id], |row| {
        Ok(ExecutionWithTask {
            id: row.get(0)?,
            task_id: row.get(1)?,
            task_name: row.get(2)?,
            branch_name: row.get(3)?,
            status: row.get(4)?,
            started_at: row.get(5)?,
            completed_at: row.get(6)?,
            terminal_output: row.get(7)?,
        })
    }).map_err(|e| format!("Failed to query executions: {}", e))?;

    let mut executions = Vec::new();
    for result in results {
        executions.push(result.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(executions)
}
