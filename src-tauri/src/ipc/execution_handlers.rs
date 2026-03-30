use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use std::io::Read;

use crate::models::{ExecutionLog, ExecutionStatus, ExecutionWithTask};
use crate::db::AppState;

/// Detect error type and provide suggestions based on stderr and exit code
///
/// # Arguments
/// * `stderr` - The stderr output from the process
/// * `exit_code` - The process exit code
///
/// # Returns
/// A tuple of (error_type_string, vec_of_suggestions)
pub fn detect_error_type_and_suggestions(stderr: &str, exit_code: i32) -> (String, Vec<String>) {
    let stderr_lower = stderr.to_lowercase();

    // Pattern matching for error types
    if stderr_lower.contains("error ts") ||
       stderr_lower.contains("syntaxerror") ||
       stderr_lower.contains("referenceerror") {
        return ("CompilationError".to_string(), vec![
            "Run: npm install".to_string(),
            "Check syntax in source files".to_string(),
        ]);
    }

    if stderr_lower.contains("not found") ||
       stderr_lower.contains("cannot find module") ||
       stderr_lower.contains("npm err") ||
       stderr_lower.contains("package.json") {
        return ("MissingDependency".to_string(), vec![
            "Run: npm install".to_string(),
            "Check package.json dependencies".to_string(),
        ]);
    }

    if stderr_lower.contains("error:") ||
       stderr_lower.contains("exception") ||
       stderr_lower.contains("panic") ||
       stderr_lower.contains("segmentation fault") {
        return ("RuntimeError".to_string(), vec![
            "Check task acceptance criteria".to_string(),
            "Review error in terminal history".to_string(),
        ]);
    }

    if exit_code < 0 || stderr_lower.contains("signal") {
        return ("ProcessCrash".to_string(), vec![
            "Check system resources".to_string(),
            "Review agent logs".to_string(),
        ]);
    }

    // Default to Unknown
    ("Unknown".to_string(), vec![
        "Review full terminal output".to_string(),
        "Check error details".to_string(),
    ])
}

/// Spawn agent execution for a task
///
/// This handler creates an execution log record, spawns the agent CLI process
/// in a background tokio task, and returns immediately with the execution log ID.
/// The process continues running after the IPC returns.
///
/// # Arguments
/// * `app_state` - Tauri app state with database connection
/// * `project_id` - Project ID (for context)
/// * `task_id` - Task ID to execute
/// * `repo_path` - Repository path for the agent
///
/// # Returns
/// Execution log ID that tracks the execution
///
/// # Async Behavior
/// - Creates execution log synchronously
/// - Spawns background task with tokio::spawn
/// - Returns immediately (process continues in background)
/// - Background task captures output and marks completion
/// - Failure detection: exit_code != 0 sets status to "failed" (EXEC-06)
#[tauri::command]
#[specta::specta]
pub async fn spawn_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    println!("spawn_agent_execution(project={}, task={}) called", project_id, task_id);
    println!("spawn_agent_execution: repo_path='{}', is_absolute={}, exists={}",
        repo_path,
        std::path::Path::new(&repo_path).is_absolute(),
        std::path::Path::new(&repo_path).is_dir());

    // Canonicalize repo_path to resolve symlinks, trailing slashes, or relative path issues
    let repo_path = std::path::Path::new(&repo_path)
        .canonicalize()
        .map_err(|e| format!("Invalid repository path '{}': {}. Ensure the project directory exists.", repo_path, e))?
        .to_string_lossy()
        .to_string();

    // Step 1: Create an on-demand worktree for this task
    let app_state_arc: Arc<AppState> = (*app_state).clone();
    let (worktree_id, worktree_path) = super::create_worktree_for_task(
        &app_state_arc,
        project_id,
        task_id,
        &repo_path,
    ).await?;
    println!("Created on-demand worktree {} at {}", worktree_id, worktree_path);

    // Step 2: Create execution log record
    let now = Utc::now().to_rfc3339();
    let log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO execution_logs (task_id, status, started_at) VALUES (?, 'running', ?)",
            rusqlite::params![task_id, &now],
        )
        .map_err(|e| format!("Failed to create execution log: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    println!("spawn_agent_execution: created execution log {}", log_id);

    // Step 3: Update task status to InProgress
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let _ = conn.execute(
            "UPDATE tasks SET status = 'InProgress' WHERE id = ?",
            rusqlite::params![task_id],
        );
    }

    // Step 4: Spawn background task for agent execution
    let app_state_bg = app_state_arc.clone();
    let repo_path_clone = repo_path.clone();
    let worktree_path_clone = worktree_path.clone();

    tokio::spawn(async move {
        println!("[spawn] Background task started for log {}", log_id);

        // Spawn the agent CLI in the worktree
        let result = crate::process::spawn_agent_cli(
            &worktree_path_clone,
            "sidecar/dist/index.js",
            task_id,
        ).await;

        let now = Utc::now().to_rfc3339();

        match result {
            Ok(output) => {
                let final_status = if output.exit_code == 0 { "complete" } else { "failed" };
                println!("[spawn] Agent finished with status={} for log {}", final_status, log_id);

                // Update execution log with result
                if let Ok(conn) = app_state_bg.db.lock() {
                    let _ = conn.execute(
                        "UPDATE execution_logs SET status = ?, completed_at = ?, output = ? WHERE id = ?",
                        rusqlite::params![final_status, &now, &output.stdout, log_id],
                    );
                    // Update task status based on result
                    let task_status = if output.exit_code == 0 { "Review" } else { "Ready" };
                    let _ = conn.execute(
                        "UPDATE tasks SET status = ? WHERE id = ?",
                        rusqlite::params![task_status, task_id],
                    );
                }
            }
            Err(e) => {
                eprintln!("[spawn] Agent execution error for log {}: {}", log_id, e);
                if let Ok(conn) = app_state_bg.db.lock() {
                    let _ = conn.execute(
                        "UPDATE execution_logs SET status = 'failed', completed_at = ? WHERE id = ?",
                        rusqlite::params![&now, log_id],
                    );
                    let _ = conn.execute(
                        "UPDATE tasks SET status = 'Ready' WHERE id = ?",
                        rusqlite::params![task_id],
                    );
                    // Best-effort delete worktree DB row on error
                    let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![worktree_id]);
                }
                return;
            }
        }

        // Finalization: delete worktree on completion (best effort)
        if let Err(e) = super::delete_worktree_for_task(
            &app_state_bg,
            worktree_id,
            &worktree_path_clone,
            &repo_path_clone,
        ).await {
            eprintln!("[finalize] Failed to delete worktree {}: {}", worktree_id, e);
        } else {
            println!("[finalize] Deleted worktree {} on completion", worktree_id);
        }
    });

    Ok(log_id)
}

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
/// Vec of task_ids that should be executed. Frontend calls spawn_agent_execution for each.
/// Returns empty vec if auto_mode is disabled or concurrency limit is already reached.
#[tauri::command]
#[specta::specta]
pub async fn drain_ready_queue(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    project_path: String,
) -> Result<Vec<i32>, String> {
    println!("drain_ready_queue(project={}) called", project_id);
    let _ = project_path; // reserved for future use

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Load settings to check auto_mode and max_concurrent_agents
    let settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    if !settings.auto_mode {
        println!("drain_ready_queue: auto_mode is disabled, returning empty");
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
        println!("drain_ready_queue: no slots available ({} running, max {})",
            running_count, settings.max_concurrent_agents);
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
    .filter_map(|r| r.ok())
    .collect();

    println!("drain_ready_queue: found {} task(s) to start", task_ids.len());
    Ok(task_ids)
}

/// Get execution logs for a task
#[tauri::command]
#[specta::specta]
pub fn get_execution_logs(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<ExecutionLog>, String> {
    println!("get_execution_logs({}) called", task_id);
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
#[tauri::command]
#[specta::specta]
pub async fn retry_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    println!("retry_execution(project={}, task={}) called", project_id, task_id);

    // Simply spawn a new execution for the same task
    spawn_agent_execution(app_state, project_id, task_id, repo_path).await
}

/// Cancel a paused execution
#[tauri::command]
#[specta::specta]
pub fn cancel_execution(
    app_state: State<Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    println!("cancel_execution({}) called", log_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE execution_logs SET status = 'cancelled', completed_at = ? WHERE id = ?",
        rusqlite::params![&now, log_id],
    )
    .map_err(|e| format!("Failed to cancel execution: {}", e))?;

    println!("✓ Cancelled execution log {}", log_id);
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
    println!("attach_terminal({}) called (include_history: {})", task_id, include_history.unwrap_or(false));

    // Get PTY session from AppState
    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions); // Release lock

    println!("[attach] Starting output streaming for task {}", task_id);

    // If requested, send terminal history first
    if include_history.unwrap_or(false) {
        println!("[attach] Fetching terminal history for task {}", task_id);
        // Try to get execution logs to prepend history
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let history = conn.query_row(
            "SELECT terminal_output FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
            rusqlite::params![task_id],
            |row| row.get::<_, Option<String>>(0)
        ).ok().flatten();

        if let Some(history_text) = history {
            if !history_text.is_empty() {
                println!("[attach] Sending {} chars of history to frontend", history_text.len());
                if output_channel.send(history_text).is_err() {
                    println!("[attach] Channel closed while sending history");
                    return Err("Channel closed before history could be sent".to_string());
                }
            }
        }
    }

    // Spawn background task to stream PTY output
    tokio::spawn(async move {
        // Create bounded channel for buffering between PTY reader and frontend sender
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

        // Spawn PTY reader task
        let session_reader = session.clone();
        let reader_task = tokio::spawn(async move {
            loop {
                // Try to get a reader from the PTY master
                let session_lock = session_reader.lock().await;
                let mut reader = match session_lock.master.lock().await.try_clone_reader() {
                    Ok(r) => r,
                    Err(_) => {
                        println!("[PTY reader] Failed to clone reader, stopping");
                        break;
                    }
                };
                drop(session_lock);

                // Read from PTY in 4096-byte chunks
                let mut buf = [0u8; 4096];
                match reader.read(&mut buf) {
                    Ok(0) => {
                        println!("[PTY reader] EOF reached, stopping");
                        break;
                    }
                    Ok(n) => {
                        // Decode UTF-8, using lossy conversion to handle mid-sequence bytes
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        if tx.send(output).await.is_err() {
                            println!("[PTY reader] Channel closed by receiver, stopping");
                            break;
                        }
                    }
                    Err(e) => {
                        println!("[PTY reader] Read error: {}, stopping", e);
                        break;
                    }
                }
            }
        });

        // Spawn frontend sender task
        let sender_task = tokio::spawn(async move {
            while let Some(output) = rx.recv().await {
                if output_channel.send(output).is_err() {
                    println!("[frontend sender] Channel closed, stopping");
                    break;
                }
            }
        });

        // Wait for either task to complete
        tokio::select! {
            _ = reader_task => {
                println!("[attach] Reader task completed");
            }
            _ = sender_task => {
                println!("[attach] Sender task completed");
            }
        }

        println!("[attach] Output streaming ended for task {}", task_id);
    });

    println!("[attach] ✓ Streaming started for task {}", task_id);
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
    // Log control sequences for debugging
    if input == "\x03" {
        println!("send_terminal_input({}) - Ctrl+C (SIGINT)", task_id);
    } else if input == "\x1a" {
        println!("send_terminal_input({}) - Ctrl+Z (SIGTSTP)", task_id);
    } else {
        println!("send_terminal_input({}) - {} bytes of text", task_id, input.len());
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
    println!("resize_terminal({}) called with {}x{}", task_id, cols, rows);

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
        Ok(0) => {
            // No rows updated (no active execution log found)
            println!("[append_terminal] No active execution log found for task {}", task_id);
            Ok(())
        }
        Ok(_) => {
            println!("[append_terminal] ✓ Appended {} bytes to execution log for task {}", output.len(), task_id);
            Ok(())
        }
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
    task_id: i32,
) -> Result<(), String> {
    println!("detach_terminal({}) called", task_id);
    println!("[detach] ✓ Detached from terminal for task {}", task_id);

    // Note: The actual cleanup happens when the channel is dropped on the frontend.
    // The streaming tasks in attach_terminal will exit when they detect the channel is closed.
    // We don't need to explicitly stop anything here - just log and return.
    Ok(())
}

/// Pause a running agent execution by sending SIGSTOP to the process
#[tauri::command]
#[specta::specta]
pub async fn pause_agent_execution(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    println!("pause_agent_execution(task={}) called", task_id);

    // Get current execution log for this task
    let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
    let exec_log = crate::db::get_current_execution_log(&conn, task_id)
        .map_err(|e| format!("Failed to get execution log: {}", e))?;
    drop(conn);

    println!("[pause] Got execution log {}", exec_log.id);

    // Update execution log status to Paused in database
    let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
    crate::db::pause_execution_log(&conn, exec_log.id)
        .map_err(|e| format!("Failed to pause execution: {}", e))?;
    drop(conn);

    println!("[pause] ✓ Updated execution log status to paused");

    // TODO: Send SIGSTOP to running process (implementation depends on process handle management)
    // For now, we just update the database status. Full process pause requires process handle tracking.

    Ok(())
}

/// Resume a paused agent execution by creating a new execution and spawning the agent again
#[tauri::command]
#[specta::specta]
pub async fn resume_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    println!("resume_agent_execution(project={}, task={}) called", project_id, task_id);

    // Canonicalize repo_path to resolve symlinks, trailing slashes, or relative path issues
    let repo_path = std::path::Path::new(&repo_path)
        .canonicalize()
        .map_err(|e| format!("Invalid repository path '{}': {}. Ensure the project directory exists.", repo_path, e))?
        .to_string_lossy()
        .to_string();

    // Step 1: Create an on-demand worktree for this task
    let app_state_arc: Arc<AppState> = (*app_state).clone();
    let (worktree_id, worktree_path) = super::create_worktree_for_task(
        &app_state_arc,
        project_id,
        task_id,
        &repo_path,
    ).await?;
    println!("Created on-demand worktree {} at {}", worktree_id, worktree_path);

    // Step 2: Create new execution log record for resumed execution
    let now = Utc::now().to_rfc3339();
    let log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO execution_logs (task_id, status, started_at) VALUES (?, 'running', ?)",
            rusqlite::params![task_id, &now],
        )
        .map_err(|e| format!("Failed to create execution log: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    println!("resume_agent_execution: created execution log {}", log_id);

    // Step 3: Update task status to InProgress
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let _ = conn.execute(
            "UPDATE tasks SET status = 'InProgress' WHERE id = ?",
            rusqlite::params![task_id],
        );
    }

    // Step 4: Spawn background task for resumed agent execution
    let app_state_bg = app_state_arc.clone();
    let repo_path_clone = repo_path.clone();
    let worktree_path_clone = worktree_path.clone();

    tokio::spawn(async move {
        println!("[resume] Background task started for log {}", log_id);

        let result = crate::process::spawn_agent_cli(
            &worktree_path_clone,
            "sidecar/dist/index.js",
            task_id,
        ).await;

        let now = Utc::now().to_rfc3339();

        match result {
            Ok(output) => {
                let final_status = if output.exit_code == 0 { "complete" } else { "failed" };
                println!("[resume] Agent finished with status={} for log {}", final_status, log_id);

                if let Ok(conn) = app_state_bg.db.lock() {
                    let _ = conn.execute(
                        "UPDATE execution_logs SET status = ?, completed_at = ?, output = ? WHERE id = ?",
                        rusqlite::params![final_status, &now, &output.stdout, log_id],
                    );
                    let task_status = if output.exit_code == 0 { "Review" } else { "Ready" };
                    let _ = conn.execute(
                        "UPDATE tasks SET status = ? WHERE id = ?",
                        rusqlite::params![task_status, task_id],
                    );
                }
            }
            Err(e) => {
                eprintln!("[resume] Agent execution error for log {}: {}", log_id, e);
                if let Ok(conn) = app_state_bg.db.lock() {
                    let _ = conn.execute(
                        "UPDATE execution_logs SET status = 'failed', completed_at = ? WHERE id = ?",
                        rusqlite::params![&now, log_id],
                    );
                    let _ = conn.execute(
                        "UPDATE tasks SET status = 'Ready' WHERE id = ?",
                        rusqlite::params![task_id],
                    );
                    // Best-effort delete worktree DB row on error
                    let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![worktree_id]);
                }
                return;
            }
        }

        // Finalization: delete worktree on completion (best effort)
        if let Err(e) = super::delete_worktree_for_task(
            &app_state_bg,
            worktree_id,
            &worktree_path_clone,
            &repo_path_clone,
        ).await {
            eprintln!("[finalize] Failed to delete worktree {}: {}", worktree_id, e);
        } else {
            println!("[finalize] Deleted worktree {} on completion", worktree_id);
        }
    });

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
    println!(
        "spawn_interactive_execution(project={}, branch={}, label={:?}) called",
        project_id, branch_name, label
    );
    let _ = label; // reserved for future display use

    // Canonicalize repo_path
    let repo_path = std::path::Path::new(&repo_path)
        .canonicalize()
        .map_err(|e| format!("Invalid repository path '{}': {}. Ensure the project directory exists.", repo_path, e))?
        .to_string_lossy()
        .to_string();

    // Step 1: Check if a worktree already exists for this branch in DB
    let existing_worktree: Option<(i32, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, path FROM worktrees WHERE project_id = ? AND branch_name = ?",
            rusqlite::params![project_id, &branch_name],
            |row| Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?)),
        ).ok()
    };

    let worktree_abs_path: String = if let Some((_wt_id, relative_path)) = existing_worktree {
        // Worktree exists — use its path
        format!("{}/{}", repo_path, relative_path)
    } else {
        // No worktree for this branch — create one (checkout existing branch)
        use crate::models::WORKTREE_DIR;
        let relative_path = format!("{}/{}", WORKTREE_DIR, branch_name);

        // Ensure parent directory exists
        tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
            .await
            .map_err(|e| format!("Failed to create worktree directory: {}", e))?;

        // Checkout existing branch (no new_branch — None means checkout, not create)
        let git_conn = crate::models::GitConnection::Local { path: repo_path.clone() };
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

    // Step 2: Create execution log with task_id = NULL
    let now = chrono::Utc::now().to_rfc3339();
    let log_id: i32 = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO execution_logs (task_id, status, started_at) VALUES (NULL, 'running', ?)",
            rusqlite::params![&now],
        )
        .map_err(|e| format!("Failed to create execution log: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    println!("spawn_interactive_execution: created execution log {}", log_id);

    // Step 3: Spawn interactive PTY session keyed by log_id
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

    println!("spawn_interactive_execution: PTY session {} started at {}", log_id, worktree_abs_path);
    Ok(log_id)
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
        "SELECT el.id, el.task_id, t.name AS task_name, w.branch_name,
                el.status, el.started_at, el.completed_at, el.terminal_output
         FROM execution_logs el
         LEFT JOIN tasks t ON t.id = el.task_id
         LEFT JOIN worktrees w ON w.task_id = el.task_id
         WHERE t.project_id = ?1 OR (el.task_id IS NULL)
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
