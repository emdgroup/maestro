use chrono::Utc;
use rusqlite::{Connection, params};

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
