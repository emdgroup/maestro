use chrono::Utc;
use rusqlite::{Connection, params};
use crate::models::ErrorEvent;

/// Create a new execution log record in the database
///
/// # Arguments
/// * `conn` - Database connection
/// * `task_id` - ID of the task being executed
/// * `_worktree_id` - ID of the worktree being used (for future integration)
///
/// # Returns
/// The ID of the newly created execution log record
pub fn create_execution_log(
    conn: &Connection,
    task_id: i32,
    _worktree_id: i32,
) -> Result<i32, String> {
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO execution_logs (task_id, status, output, started_at) VALUES (?, ?, ?, ?)",
        params![task_id, "running", "", &now],
    )
    .map_err(|e| format!("Failed to create execution log: {}", e))?;

    let log_id = conn.last_insert_rowid() as i32;
    Ok(log_id)
}

/// Append output to an execution log record
///
/// # Arguments
/// * `conn` - Database connection
/// * `log_id` - ID of the execution log to update
/// * `output` - Output text to append
///
/// # Returns
/// Ok(()) on success, Err(String) on database error
pub fn append_output(
    conn: &Connection,
    log_id: i32,
    output: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE execution_logs SET output = output || ? WHERE id = ?",
        params![output, log_id],
    )
    .map_err(|e| format!("Failed to append output: {}", e))?;

    Ok(())
}

/// Mark an execution log as complete with exit code and status
///
/// # Arguments
/// * `conn` - Database connection
/// * `log_id` - ID of the execution log to complete
/// * `exit_code` - Exit code from the process
///
/// # Returns
/// Ok(()) on success, Err(String) on database error
///
/// # Behavior
/// - If exit_code == 0: status set to "complete"
/// - If exit_code != 0: status set to "paused" (EXEC-06 failure detection, awaits user action)
/// - Appends exit code to output
/// - Sets completed_at timestamp
pub fn mark_complete(
    conn: &Connection,
    log_id: i32,
    exit_code: i32,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let status = if exit_code == 0 { "complete" } else { "paused" };

    conn.execute(
        "UPDATE execution_logs SET status = ?, completed_at = ?, output = output || ? WHERE id = ?",
        params![status, &now, &format!("\n[Exit code: {}]", exit_code), log_id],
    )
    .map_err(|e| format!("Failed to mark execution complete: {}", e))?;

    Ok(())
}

/// Append an error event to an execution log
///
/// # Arguments
/// * `conn` - Database connection
/// * `log_id` - ID of the execution log to update
/// * `error_event` - ErrorEvent to store
///
/// # Returns
/// Ok(()) on success, Err(String) on database error
pub fn append_error_event(
    conn: &Connection,
    log_id: i32,
    error_event: &ErrorEvent,
) -> Result<(), String> {
    let error_json = serde_json::to_string(&error_event)
        .map_err(|e| format!("Failed to serialize error event: {}", e))?;

    conn.execute(
        "UPDATE execution_logs SET error_event = ? WHERE id = ?",
        params![&error_json, log_id],
    )
    .map_err(|e| format!("Failed to append error event: {}", e))?;

    Ok(())
}

/// Mark execution as failed with error details
///
/// # Arguments
/// * `conn` - Database connection
/// * `log_id` - ID of the execution log to mark as failed
/// * `error_event` - ErrorEvent with error details
///
/// # Returns
/// Ok(()) on success, Err(String) on database error
pub fn mark_failed(
    conn: &Connection,
    log_id: i32,
    error_event: &ErrorEvent,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let error_json = serde_json::to_string(&error_event)
        .map_err(|e| format!("Failed to serialize error event: {}", e))?;

    conn.execute(
        "UPDATE execution_logs SET status = 'failed', error_event = ?, completed_at = ? WHERE id = ?",
        params![&error_json, &now, log_id],
    )
    .map_err(|e| format!("Failed to mark execution failed: {}", e))?;

    Ok(())
}

/// Get error event for an execution log
///
/// # Arguments
/// * `conn` - Database connection
/// * `log_id` - ID of the execution log
///
/// # Returns
/// Ok(Option<ErrorEvent>) - the error event if present, or None
pub fn get_error_event(
    conn: &Connection,
    log_id: i32,
) -> Result<Option<ErrorEvent>, String> {
    let mut stmt = conn.prepare(
        "SELECT error_event FROM execution_logs WHERE id = ?"
    ).map_err(|e| e.to_string())?;

    let error_event = stmt.query_row([log_id], |row| {
        let error_json: Option<String> = row.get(0)?;
        Ok(error_json.and_then(|s| serde_json::from_str(&s).ok()))
    })
    .map_err(|e| e.to_string())?;

    Ok(error_event)
}

/// Pause an execution log (set status to 'paused')
///
/// # Arguments
/// * `conn` - Database connection
/// * `exec_log_id` - ID of the execution log to pause
///
/// # Returns
/// Ok(()) on success, Err(String) on database error
pub fn pause_execution_log(
    conn: &Connection,
    exec_log_id: i32,
) -> Result<(), String> {
    conn.execute(
        "UPDATE execution_logs SET status = 'paused' WHERE id = ?",
        [exec_log_id],
    )
    .map_err(|e| format!("Failed to pause execution: {}", e))?;

    Ok(())
}

/// Get the most recent execution log for a task
///
/// # Arguments
/// * `conn` - Database connection
/// * `task_id` - ID of the task
///
/// # Returns
/// Ok(ExecutionLog) - the most recent execution log
/// Err(String) - if no execution log found or database error
pub fn get_current_execution_log(
    conn: &Connection,
    task_id: i32,
) -> Result<crate::models::ExecutionLog, String> {
    use crate::models::ExecutionLog;

    let result = conn.query_row(
        "SELECT id, task_id, output, terminal_output, status, started_at, completed_at, error_event
         FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
        [task_id],
        |row| {
            let status_str: String = row.get(4)?;
            Ok(ExecutionLog {
                id: row.get(0)?,
                task_id: row.get(1)?,
                output: row.get(2)?,
                terminal_output: row.get(3)?,
                status: match status_str.as_str() {
                    "running" => crate::models::ExecutionStatus::Running,
                    "complete" => crate::models::ExecutionStatus::Complete,
                    "failed" => crate::models::ExecutionStatus::Failed,
                    "paused" => crate::models::ExecutionStatus::Paused,
                    "cancelled" => crate::models::ExecutionStatus::Cancelled,
                    _ => crate::models::ExecutionStatus::Running,
                },
                started_at: row.get(5)?,
                completed_at: row.get(6)?,
                error_event: {
                    let error_json: Option<String> = row.get(7)?;
                    error_json.and_then(|s| serde_json::from_str(&s).ok())
                },
            })
        },
    );

    result.map_err(|e| format!("Failed to get execution log: {}", e))
}
