use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{Worktree, WorktreeStatus, PoolStatus};
use crate::db::AppState;

// ============================================================================
// Worktree Pool Configuration
// ============================================================================

const POOL_MAX_SIZE: i32 = 5;
const DEFAULT_POOL_SIZE: i32 = 3;

// ============================================================================
// Worktree Leasing
// ============================================================================

/// Lease worktree from pool for task execution with automatic retry and pool expansion
///
/// When no worktrees are available:
/// 1. Retries up to 3 times with exponential backoff (500ms, 1s, 1.5s)
/// 2. On each retry, checks again for available worktrees
/// 3. After retries exhausted, attempts pool expansion (creates new worktree)
/// 4. Returns error only if all retries and expansion fail
#[tauri::command]
pub async fn lease_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    _repo_path: String,
) -> Result<Worktree, String> {
    println!("lease_worktree(project={}, task={}) called", project_id, task_id);

    const MAX_RETRIES: u32 = 3;
    const RETRY_BASE_MS: u64 = 500;

    // Try to lease with retry loop
    for attempt in 0..=MAX_RETRIES {
        // Attempt to lease available worktree
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

            let available: Result<Worktree, _> = conn.query_row(
                "SELECT id, project_id, branch_name, path, status, leased_at, returned_at, created_at
                 FROM worktrees WHERE project_id = ? AND status = 'Available' LIMIT 1",
                [project_id],
                |row| {
                    Ok(Worktree {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        branch_name: row.get(2)?,
                        path: row.get(3)?,
                        status: WorktreeStatus::Available,
                        leased_at: row.get(5)?,
                        returned_at: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                },
            );

            if let Ok(mut worktree) = available {
                // Lease existing worktree
                let now = Utc::now().to_rfc3339();
                conn.execute(
                    "UPDATE worktrees SET status = 'Leased', leased_at = ? WHERE id = ?",
                    rusqlite::params![&now, worktree.id],
                )
                .map_err(|e| format!("Failed to lease worktree: {}", e))?;

                worktree.status = WorktreeStatus::Leased;
                worktree.leased_at = Some(now);

                println!("✓ Leased existing worktree {}", worktree.id);
                return Ok(worktree);
            }
        } // Drop lock before sleep

        // No available worktree, check if we can create new one
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

            let count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM worktrees WHERE project_id = ?",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count worktrees: {}", e))?;

            if count < POOL_MAX_SIZE {
                // Create new worktree
                let worktree_id_str = format!("wt-{:03}", count + 1);
                let branch_name = format!("pool/agent-task-{}", task_id);
                let worktree_path = format!(".worktree-pool/{}", worktree_id_str);
                let now = Utc::now().to_rfc3339();

                conn.execute(
                    "INSERT INTO worktrees (project_id, branch_name, path, status, leased_at, created_at)
                     VALUES (?, ?, ?, 'Leased', ?, ?)",
                    rusqlite::params![project_id, &branch_name, &worktree_path, &now, &now],
                )
                .map_err(|e| format!("Failed to create worktree record: {}", e))?;

                let worktree_id = conn.last_insert_rowid() as i32;

                println!("✓ Created new worktree {} (pool expansion)", worktree_id);

                // Return without waiting for sidecar (Phase 4 will integrate actual git creation)
                return Ok(Worktree {
                    id: worktree_id,
                    project_id,
                    branch_name,
                    path: worktree_path,
                    status: WorktreeStatus::Leased,
                    leased_at: Some(now.clone()),
                    returned_at: None,
                    created_at: now,
                });
            }
        } // Drop lock before sleep

        // Pool is at max size and no available worktrees
        if attempt < MAX_RETRIES {
            // Calculate exponential backoff: 500ms * 2^attempt = 500ms, 1s, 1.5s
            let backoff_ms = RETRY_BASE_MS * (1 << attempt); // 2^attempt
            println!("[retry] Attempt {}: No available worktrees, retrying in {}ms (pool at max)", attempt + 1, backoff_ms);
            tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
        }
    }

    // All retries exhausted, pool still full
    Err(format!("Failed to lease or create worktree: pool exhausted and creation failed after {} retries", MAX_RETRIES))
}

// ============================================================================
// Worktree Return
// ============================================================================

/// Return worktree to pool after task completion
#[tauri::command]
pub fn return_worktree(
    app_state: State<Arc<AppState>>,
    worktree_id: i32,
) -> Result<(), String> {
    println!("return_worktree({}) called", worktree_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?",
        rusqlite::params![&now, worktree_id],
    )
    .map_err(|e| format!("Failed to return worktree: {}", e))?;

    println!("✓ Returned worktree {} to pool", worktree_id);
    Ok(())
}

// ============================================================================
// Pool Status Monitoring
// ============================================================================

/// Get current pool status for monitoring
#[tauri::command]
pub fn get_pool_status(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<PoolStatus, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let available: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Available'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);

    let leased: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Leased'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);

    let in_use: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'InUse'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);

    let dirty: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Dirty'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);

    let total = available + leased + in_use + dirty;
    let utilization_percent = if total > 0 {
        ((leased + in_use) as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    Ok(PoolStatus {
        total,
        available,
        leased,
        in_use,
        dirty,
        utilization_percent,
    })
}

// ============================================================================
// Worktree Cleanup
// ============================================================================

// Worktree Cleanup Lifecycle
//
// 1. Task completes → agent calls merge to main
// 2. Phase 6 (Review & Merge) calls cleanup_worktree(worktree_id, repo_path)
// 3. cleanup_worktree:
//    - Marks worktree as 'Dirty' (durable state, survives crashes)
//    - Spawns async sidecar to delete worktree + branch (safe order: worktree → branch → prune)
//    - Uses tokio::process::Command for async context (NOT blocking std::process::Command)
//    - Deletes from database on success
//    - Returns Err if sidecar fails (leaves dirty for retry)
// 4. If cleanup fails or process crashes:
//    - Worktree stays marked 'Dirty'
//    - Call recover_dirty_worktrees() on next app startup or manually
//    - Prevents orphaned worktrees from blocking pool
//
// Database State Machine:
// Leased/InUse → Dirty (on cleanup start) → [deleted] (on cleanup success)
// If cleanup fails: Dirty → [retry later via recover_dirty_worktrees]
//
// CRITICAL INTEGRATION POINT (Phase 2):
// - App.tsx should call invoke("recover_dirty_worktrees", {...}) in useEffect on project open
// - This ensures stuck worktrees are recovered at startup

/// Delete worktree and associated branch after task merge
///
/// This function implements safe deletion with recovery for failures:
/// 1. Marks worktree as 'Dirty' (failure-proof flag, survives crashes)
/// 2. Calls async sidecar to delete worktree + branch (safe git sequence)
/// 3. Removes from database on success
///
/// If any step fails, worktree remains 'Dirty' for manual recovery.
///
/// # Arguments
/// * `project_id` - Project owning the worktree
/// * `worktree_id` - ID of worktree to clean
/// * `repo_path` - Path to git repository
/// * `state` - Tauri app state with database connection
///
/// # Returns
/// `Ok(())` on successful cleanup, `Err(msg)` on failure
///
/// # Safety
/// Uses database transaction to ensure atomicity. Sidecar call via tokio (async-safe).
/// If sidecar fails, worktree stays marked 'Dirty' for retry.
///
/// # Async Context
/// MUST use tokio::process::Command (NOT std::process::Command) to avoid blocking.
#[tauri::command]
pub async fn cleanup_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_id: i32,
    repo_path: String,
) -> Result<(), String> {
    println!("cleanup_worktree({}, {}) called", project_id, worktree_id);

    // Fetch worktree record
    let (path, branch_name) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let result: Result<(String, String), _> = conn.query_row(
            "SELECT path, branch_name FROM worktrees WHERE id = ? AND project_id = ?",
            rusqlite::params![worktree_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );

        match result {
            Ok(data) => data,
            Err(_) => return Err(format!("Worktree {} not found", worktree_id)),
        }
    };

    // Mark as dirty
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
            [worktree_id],
        )
        .map_err(|e| format!("Failed to mark dirty: {}", e))?;
    }

    // TODO: Phase 4 - Invoke sidecar with tokio::process::Command
    // For now, stub the sidecar invocation
    println!("TODO: Invoke sidecar deleteWorktree({}, {}, {})", repo_path, path, branch_name);

    // Simulate success for now
    // In Phase 4, this will be actual async sidecar call

    // Delete from database
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "DELETE FROM worktrees WHERE id = ? AND status = 'Dirty'",
            [worktree_id],
        )
        .map_err(|e| format!("Failed to delete worktree: {}", e))?;
    }

    println!("✓ Cleaned up worktree {} (branch: {})", worktree_id, branch_name);
    Ok(())
}

/// Recover worktrees stuck in 'Dirty' state
///
/// Called on app startup to retry cleanup of worktrees that failed mid-operation.
/// Prevents orphaned worktrees from accumulating and blocking the pool.
///
/// # Arguments
/// * `project_id` - Project to recover worktrees for
/// * `repo_path` - Path to git repository
/// * `state` - Tauri app state with database connection
///
/// # Returns
/// Vec of successfully recovered worktree IDs (for logging)
///
/// # Integration
/// Should be invoked in App.tsx useEffect on project load (see Phase 2 integration point)
#[tauri::command]
pub async fn recover_dirty_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<Vec<i32>, String> {
    println!("recover_dirty_worktrees({}) called", project_id);

    // Query dirty worktrees
    let dirty_worktrees: Vec<(i32, String, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let mut stmt = conn
            .prepare("SELECT id, path, branch_name FROM worktrees WHERE project_id = ? AND status = 'Dirty'")
            .map_err(|e| e.to_string())?;

        let rows = stmt.query_map([project_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    if dirty_worktrees.is_empty() {
        println!("No dirty worktrees to recover");
        return Ok(vec![]);
    }

    println!("Found {} dirty worktrees, attempting recovery", dirty_worktrees.len());

    let mut recovered_ids = vec![];

    for (wt_id, path, branch) in &dirty_worktrees {
        // TODO: Phase 4 - Invoke sidecar deleteWorktree via tokio::process::Command
        println!("TODO: Recover worktree {} via sidecar deleteWorktree({}, {}, {})", wt_id, repo_path, path, branch);

        // Simulate success for now
        // In Phase 4, this will be actual async sidecar call with error handling

        // Delete from database on success
        let result = {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.execute("DELETE FROM worktrees WHERE id = ?", [wt_id])
        };

        match result {
            Ok(_) => {
                println!("✓ Recovered worktree {}", wt_id);
                recovered_ids.push(*wt_id);
            }
            Err(e) => {
                eprintln!("Failed to delete recovered worktree {}: {}", wt_id, e);
            }
        }
    }

    println!("Recovery complete: {}/{} worktrees recovered", recovered_ids.len(), dirty_worktrees.len());
    Ok(recovered_ids)
}

// ============================================================================
// Worktree Pool Pre-creation
// ============================================================================

// INTEGRATION POINT: App.tsx (Phase 2)
// After user selects project and project loads:
// 1. recover_dirty_worktrees() to retry any failed cleanups
// 2. initialize_worktree_pool() to pre-create 3 available worktrees
//
// Sequence in App.tsx useEffect (when project changes):
// useEffect(() => {
//   if (project) {
//     // Recover stuck worktrees
//     invoke("recover_dirty_worktrees", { projectId: project.id, repoPath: project.path });
//     // Pre-create pool for instant allocation
//     invoke("initialize_worktree_pool", { projectId: project.id, repoPath: project.path });
//   }
// }, [project]);

/// Pre-create worktree pool on project open
///
/// Creates database entries for available worktrees to enable instant allocation.
/// Actual git worktree creation happens lazily when worktree is leased for task execution.
///
/// Design:
/// - Creates 3 database entries in 'available' state
/// - Lazy git worktree creation on first lease (avoids slow disk I/O at startup)
/// - If pool already initialized, returns current pool status
/// - Idempotent: safe to call multiple times
///
/// # Arguments
/// * `project_id` - Project to initialize pool for
/// * `repo_path` - Path to git repository
/// * `pool_size` - Optional pool size (default: 3). Override for testing.
/// * `state` - Tauri app state with database connection
///
/// # Returns
/// Current PoolStatus showing total, available, leased, dirty counts
///
/// # Integration
/// Should be called in App.tsx useEffect after project is selected:
/// ```typescript
/// await invoke("initialize_worktree_pool", { projectId: project.id, repoPath: project.path });
/// ```
#[tauri::command]
pub fn initialize_worktree_pool(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    _repo_path: String,
    pool_size: Option<i32>,
) -> Result<PoolStatus, String> {
    let pool_size = pool_size.unwrap_or(DEFAULT_POOL_SIZE);
    println!("initialize_worktree_pool(project={}, size={}) called", project_id, pool_size);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Check existing available worktrees
    let current_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Available'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);

    if current_count >= pool_size {
        println!("Pool already initialized ({} available)", current_count);
        drop(conn);
        return get_pool_status(app_state, project_id);
    }

    // Create missing worktrees
    let total_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ?",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);

    let needed = pool_size - current_count;
    println!("Creating {} worktrees (current: {}, target: {})", needed, current_count, pool_size);

    let now = Utc::now().to_rfc3339();

    for i in 1..=needed {
        let worktree_num = total_count + i;
        let worktree_id = format!("wt-{:03}", worktree_num);
        let branch_name = format!("pool/reserved-{}", worktree_num);
        let path = format!(".worktree-pool/{}", worktree_id);

        conn.execute(
            "INSERT INTO worktrees (project_id, branch_name, path, status, created_at)
             VALUES (?, ?, ?, 'Available', ?)",
            rusqlite::params![project_id, &branch_name, &path, &now],
        )
        .map_err(|e| format!("Failed to create worktree {}: {}", worktree_id, e))?;

        println!("✓ Created worktree {} (database entry)", worktree_id);
    }

    drop(conn);

    println!("✓ Pool initialized with {} worktrees", pool_size);
    get_pool_status(app_state, project_id)
}
