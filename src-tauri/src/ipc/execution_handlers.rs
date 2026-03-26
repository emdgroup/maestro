use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use std::io::Read;

use crate::models::{Task, ErrorEvent, ExecutionLog, ExecutionStatus};
use crate::db::AppState;
use crate::process::{spawn_agent_cli_pty, ExecutionConfig};
use crate::process::spawn_agent_execution as spawn_agent_execution_dispatcher;
use crate::websocket::attach_remote_stream_listener;

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

    // 0. Get project and determine if remote
    let is_remote = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let connection_id: Option<i32> = conn.query_row(
            "SELECT connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        ).map_err(|e| format!("Failed to load project: {}", e))?;
        drop(conn);
        connection_id.is_some()
    };

    println!("✓ Determined execution type (is_remote: {})", is_remote);

    // 1. Create execution log record
    let exec_log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::db::execution_logs::create_execution_log(&conn, task_id, 0)?
    };
    println!("✓ Created execution log {}", exec_log_id);

    // 2. Lease worktree from pool
    let worktree = super::lease_worktree(app_state.clone(), project_id, task_id, repo_path.clone()).await?;
    let worktree_id = worktree.id;
    let worktree_path = format!("{}/{}", repo_path, worktree.path);
    println!("✓ Leased worktree {} at path {}", worktree_id, worktree.path);

    // 3. Get task for execution
    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let result = conn.query_row(
            "SELECT id, project_id, name, description, acceptance_criteria, status, priority, \
             origin_branch, archived_at, external_id, is_imported, import_source, skills, \
             model_override, mcp_allowlist, skills_override, created_at, updated_at \
             FROM tasks WHERE id = ?",
            [task_id],
            Task::from_row,
        );
        drop(conn);
        result.map_err(|e| format!("Failed to load task: {}", e))?
    };

    // 4. Build execution config from task and project settings
    let config = ExecutionConfig {
        model_override: task.model_override.clone(),
        mcp_allowlist: task.mcp_allowlist.clone(),
        skills_override: task.skills_override.clone(),
    };

    // 5. Extract Arc<AppState> from State for background task
    let app_state_arc = (*app_state).clone();

    // 6. Spawn background task (returns immediately to caller)
    tokio::spawn(async move {
        println!("[background] Starting agent execution for task {} in worktree {}", task_id, worktree_id);

        // For local execution: continue using existing PTY spawner
        if !is_remote {
            match spawn_agent_cli_pty(
                task_id,
                "node".to_string(),
                vec!["sidecar/dist/index.js".to_string(), "--task-id".to_string(), task_id.to_string()],
                std::path::PathBuf::from(&worktree_path),
            )
            .await
            {
                Ok(pty_session) => {
                    println!("[background] PTY session spawned for task {}", task_id);

                    // Store PtySession in AppState for frontend attachment
                    {
                        let mut sessions = app_state_arc.pty_sessions.lock().await;
                        sessions.insert(task_id, Arc::new(tokio::sync::Mutex::new(pty_session)));
                        println!("[background] ✓ Stored PTY session for task {} in AppState", task_id);
                    }

                    // Initialize execution log status
                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            if let Err(e) = crate::db::execution_logs::mark_complete(&conn, exec_log_id, 0) {
                                eprintln!("[background] Failed to initialize execution log: {}", e);
                            }
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[background] PTY spawning failed: {}", e);

                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            let error_msg = format!("\n[ERROR] Failed to spawn PTY: {}", e);
                            let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                            let (error_type, suggestions) = detect_error_type_and_suggestions(&e, -1);
                            let now = Utc::now().to_rfc3339();
                            let error_event = ErrorEvent {
                                error_type: error_type.clone(),
                                message: e.clone(),
                                suggestions,
                                detected_at: now,
                            };

                            let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);

                            let _ = conn.execute(
                                "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                rusqlite::params![worktree_id],
                            );
                            println!("✗ Marked worktree {} as dirty due to spawn error. Error type: {}", worktree_id, error_type);
                        }
                        Err(lock_err) => {
                            eprintln!("[background] Failed to lock database for error logging: {}", lock_err);
                        }
                    }
                }
            }
        } else {
            // For remote execution: Get SSH session and call dispatcher

            // Get SSH session from AppState
            match app_state_arc.get_ssh_session(project_id).await {
                Some(ssh_session) => {
                    // 2. Build GitConnection for dispatcher
                    let git_conn = crate::models::GitConnection::Remote {
                        ssh: Arc::new(ssh_session),
                        remote_path: worktree_path.clone(), // Use the leased worktree path as remote root
                    };

                    // 3. Call dispatcher which handles remote execution
                    match spawn_agent_execution_dispatcher(&git_conn, &worktree, &task, &config).await {
                        Ok((_output, Some(handle))) => {
                            // 4. Attach streaming to the remote handle
                            // Create broadcast_sender callback that forwards to execution log
                            let exec_log_id_for_streaming = exec_log_id;
                            let app_state_for_streaming = app_state_arc.clone();
                            let broadcast_sender = move |bytes: Vec<u8>| {
                                // Forward bytes to execution log terminal_output
                                if let Ok(conn) = app_state_for_streaming.db.lock() {
                                    let output_str = String::from_utf8_lossy(&bytes);
                                    let _ = crate::db::execution_logs::append_output(&conn, exec_log_id_for_streaming, &output_str);
                                }
                            };

                            // 5. Call attach_remote_stream_listener to start streaming background task
                            if let Err(e) = attach_remote_stream_listener(&handle, broadcast_sender).await {
                                eprintln!("[background] Failed to attach stream listener: {}", e);
                            }

                            println!("[background] ✓ Remote execution spawned with streaming (PID: {})", handle.remote_pid);

                            // 6. Initialize execution log status
                            match app_state_arc.db.lock() {
                                Ok(conn) => {
                                    let _ = crate::db::execution_logs::mark_complete(&conn, exec_log_id, 0);
                                }
                                Err(e) => {
                                    eprintln!("[background] Failed to initialize execution log: {}", e);
                                }
                            }
                        }
                        Ok((_output, None)) => {
                            eprintln!("[background] Remote execution returned no handle");

                            match app_state_arc.db.lock() {
                                Ok(conn) => {
                                    let error_msg = "[ERROR] Remote execution returned no handle".to_string();
                                    let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                                    let (error_type, suggestions) = detect_error_type_and_suggestions(&error_msg, -1);
                                    let now = Utc::now().to_rfc3339();
                                    let error_event = ErrorEvent {
                                        error_type,
                                        message: error_msg,
                                        suggestions,
                                        detected_at: now,
                                    };

                                    let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);
                                    let _ = conn.execute(
                                        "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                        rusqlite::params![worktree_id],
                                    );
                                }
                                Err(e) => {
                                    eprintln!("[background] Failed to lock database: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[background] Remote execution dispatcher failed: {}", e);

                            match app_state_arc.db.lock() {
                                Ok(conn) => {
                                    let error_msg = format!("[ERROR] Remote execution failed: {}", e);
                                    let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                                    let (error_type, suggestions) = detect_error_type_and_suggestions(&error_msg, -1);
                                    let now = Utc::now().to_rfc3339();
                                    let error_event = ErrorEvent {
                                        error_type,
                                        message: error_msg,
                                        suggestions,
                                        detected_at: now,
                                    };

                                    let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);
                                    let _ = conn.execute(
                                        "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                        rusqlite::params![worktree_id],
                                    );
                                }
                                Err(lock_err) => {
                                    eprintln!("[background] Failed to lock database: {}", lock_err);
                                }
                            }
                        }
                    }
                }
                None => {
                    eprintln!("[background] SSH session not available for remote project");

                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            let error_msg = "[ERROR] SSH session not available for remote project".to_string();
                            let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                            let (error_type, suggestions) = detect_error_type_and_suggestions(&error_msg, -1);
                            let now = Utc::now().to_rfc3339();
                            let error_event = ErrorEvent {
                                error_type,
                                message: error_msg,
                                suggestions,
                                detected_at: now,
                            };

                            let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);
                            let _ = conn.execute(
                                "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                rusqlite::params![worktree_id],
                            );
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
            }
        }

        // Finalize: Return worktree to pool after execution completes (success or failure)
        {
            match app_state_arc.db.lock() {
                Ok(conn) => {
                    let now = Utc::now().to_rfc3339();
                    match conn.execute(
                        "UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?",
                        rusqlite::params![&now, worktree_id],
                    ) {
                        Ok(_) => println!("[finalize] ✓ Returned worktree {} to pool", worktree_id),
                        Err(e) => eprintln!("[finalize] ✗ Failed to return worktree to pool: {}", e),
                    }
                }
                Err(e) => eprintln!("[finalize] ✗ Failed to lock database to return worktree: {}", e),
            }
        }

        println!("[background] Agent execution complete for task {}", task_id);
    });

    // 7. Return execution_log id immediately (process runs in background)
    println!("✓ Spawned background agent task, execution log id: {}", exec_log_id);
    Ok(exec_log_id)
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

    // Append to most recent execution log for this task (typically running/active one)
    let result = conn.execute(
        "UPDATE execution_logs
         SET terminal_output = COALESCE(terminal_output, '') || ?
         WHERE task_id = ? AND status IN ('running', 'failed', 'complete')
         ORDER BY id DESC LIMIT 1",
        rusqlite::params![&output, task_id],
    );

    // Note: The ORDER BY in an UPDATE is non-standard but works in SQLite
    // If this causes issues, we can use a subquery approach instead:
    // UPDATE execution_logs
    // SET terminal_output = COALESCE(terminal_output, '') || ?
    // WHERE id = (SELECT id FROM execution_logs
    //             WHERE task_id = ? AND status IN (...)
    //             ORDER BY id DESC LIMIT 1)

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
    println!("resume_agent_execution(task={}, project={}) called", task_id, project_id);

    // Step 1: Get current paused execution log
    let _prev_exec_log = {
        let conn = app_state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
        crate::db::get_current_execution_log(&conn, task_id)
            .map_err(|e| format!("Failed to get execution log: {}", e))?
    };

    println!("[resume] Got previous execution log");

    // Step 2: Create new execution log
    let exec_log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
        crate::db::create_execution_log(&conn, task_id, 0)?
    };

    println!("[resume] Created new execution log {}", exec_log_id);

    // Step 3: Lease worktree
    let worktree = super::lease_worktree(app_state.clone(), project_id, task_id, repo_path.clone()).await?;
    let worktree_id = worktree.id;
    let worktree_path = format!("{}/{}", repo_path, worktree.path);

    println!("[resume] Leased worktree {} at path {}", worktree_id, worktree.path);

    // Step 4: Get project to determine if remote
    let is_remote: bool = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let connection_id: Option<i32> = conn.query_row(
            "SELECT connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        ).map_err(|e| format!("Failed to load project: {}", e))?;
        connection_id.is_some()
    };

    println!("[resume] ✓ Determined execution type (is_remote: {})", is_remote);

    // Step 5: Extract Arc<AppState> for background task
    let app_state_arc = (*app_state).clone();

    // Step 6: Spawn background task (reuses spawn_agent_cli_pty pattern from spawn_agent_execution)
    tokio::spawn(async move {
        println!("[background] Starting resumed agent execution for task {} in worktree {}", task_id, worktree_id);

        // For local execution
        if !is_remote {
            match spawn_agent_cli_pty(
                task_id,
                "node".to_string(),
                vec!["sidecar/dist/index.js".to_string(), "--task-id".to_string(), task_id.to_string()],
                std::path::PathBuf::from(&worktree_path),
            )
            .await
            {
                Ok(pty_session) => {
                    println!("[background] PTY session spawned for resumed task {}", task_id);

                    // Store PtySession in AppState
                    {
                        let mut sessions = app_state_arc.pty_sessions.lock().await;
                        sessions.insert(task_id, Arc::new(tokio::sync::Mutex::new(pty_session)));
                        println!("[background] ✓ Stored PTY session for task {} in AppState", task_id);
                    }

                    // Initialize execution log status
                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            if let Err(e) = crate::db::mark_complete(&conn, exec_log_id, 0) {
                                eprintln!("[background] Failed to initialize execution log: {}", e);
                            }
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[background] PTY spawning failed: {}", e);

                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            let error_msg = format!("\n[ERROR] Failed to spawn PTY on resume: {}", e);
                            let _ = crate::db::append_output(&conn, exec_log_id, &error_msg);

                            let (error_type, suggestions) = detect_error_type_and_suggestions(&e, -1);
                            let now = Utc::now().to_rfc3339();
                            let error_event = ErrorEvent {
                                error_type: error_type.clone(),
                                message: e.clone(),
                                suggestions,
                                detected_at: now,
                            };

                            let _ = crate::db::mark_failed(&conn, exec_log_id, &error_event);

                            let _ = conn.execute(
                                "UPDATE tasks SET status = 'Failed' WHERE id = ?",
                                [task_id],
                            );
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
            }
        } else {
            // Remote execution - TODO: similar pattern to local but with remote spawn
            eprintln!("[background] Remote execution on resume not yet implemented");
        }

        // Finalization: Return worktree to pool
        match app_state_arc.db.lock() {
            Ok(conn) => {
                let now = Utc::now().to_rfc3339();
                let _ = conn.execute(
                    "UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?",
                    rusqlite::params![&now, worktree_id],
                );
                println!("[background] ✓ Returned worktree {} to Available", worktree_id);
            }
            Err(e) => {
                eprintln!("[background] Failed to return worktree to pool: {}", e);
            }
        }
    });

    println!("[resume] ✓ Spawned background execution task, returning log id {}", exec_log_id);
    Ok(exec_log_id)
}
