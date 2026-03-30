# Phase 25: Backend Overhaul - Research

**Researched:** 2026-03-29
**Domain:** Rust backend — SQLite schema migration, Tauri IPC, tokio async, git subprocess, git2 crate
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Worktree list enrichment (list_worktrees_with_status)**
- Source of truth: `git worktree list --porcelain` for on-disk state; DB rows enriched with task/execution info
- On-disk worktree with no DB row: Include as orphan (no task/execution info); distinct "orphan" state, NOT is_zombie
- DB row with no matching disk worktree: Auto-delete the DB row silently
- Main worktree exclusion: Filter out the project root worktree; only task/agent worktrees returned

**git status per-worktree cost**
- Execution strategy: Parallel via `tokio::spawn` — all `git status --porcelain` calls run concurrently
- Field content: Return raw porcelain string as `git_status` in `WorktreeWithStatus`

**git2 vs tokio::process::Command split**
- git2 use: Only for `get_worktree_diff` — wrap in `tokio::task::spawn_blocking`
- Everything else: `tokio::process::Command` for `worktree add/remove`, `worktree list --porcelain`, `status --porcelain`
- Diff target: Diff the worktree's HEAD vs `origin/{branch_name}`

**Zombie detection criteria**
- is_zombie: `task_id IS NULL AND path LIKE '.maestro/worktrees/task-%'`
- Manually-created worktrees: NOT zombies even if task_id IS NULL (path convention distinguishes)
- On-disk orphans (no DB row): NOT marked as zombies — treated as unknown/orphan status separately

**Claude's Discretion**
- Error message formatting for git subprocess failures
- Exact SQL join structure for `list_executions_with_task_info`
- How to handle `git worktree list --porcelain` parse errors (fail whole call vs return partial results)
- Whether `cleanup_zombie_worktrees` scaffolding belongs here or strictly in Phase 28

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-01 | Schema v3 migration — drop-and-recreate worktrees with new columns | Migration pattern in `schema.rs` v1→v2; increment SCHEMA_VERSION to 3 |
| REQ-02 | Worktree model overhaul — remove pool types, add WorktreeWithStatus + ExecutionWithTask | models/worktree.rs rewrite; new view models with Option fields for orphan state |
| REQ-03 | Real `git worktree add/remove` via tokio::process::Command | Local stubs in git/mod.rs; pattern from remote.rs |
| REQ-04 | Worktree path constant `.maestro/worktrees/task-{id}` | Named Rust const; used in zombie SQL LIKE clause |
| REQ-05 | Remove 5 pool IPC commands from worktree_handlers.rs and lib.rs | All 5 identified: initialize_worktree_pool, lease_worktree, return_worktree, get_pool_status, recover_dirty_worktrees |
| REQ-06 | Add `list_worktrees_with_status` IPC | git worktree list --porcelain parse; parallel git status calls; SQL join for task/execution enrichment |
| REQ-07 | Add `get_worktree_diff` IPC | git2 crate (vendored); spawn_blocking; diff HEAD vs origin/{branch} |
| REQ-08 | Add `create_worktree` IPC | tokio::process::Command; DB INSERT; error propagation |
| REQ-09 | Add `delete_worktree` IPC | git worktree remove --force; DELETE from worktrees table |
| REQ-10 | Add `list_executions_with_task_info` IPC | SQL JOIN execution_logs + tasks + worktrees; sorted DESC by started_at |
| REQ-11 | spawn_agent_execution uses on-demand create | Replace lease_worktree() call at line ~120 with create_worktree_for_task() |
| REQ-12 | Finalization blocks delete not return | Replace both `status = 'Available'` writes (lines 356, 994) with delete worktree |
| REQ-13 | No blocking git subprocess in async IPC | tokio::process::Command everywhere; git2 only in spawn_blocking |
| REQ-14 | New crates: git2 = "0.20.4" + notify = "8.2.0" | Both verified against crates.io: git2 0.20.4 is latest stable; notify 8.2.0 is latest stable |
| REQ-15 | pnpm tauri:gen regenerates bindings.ts | Run `cargo test generate_typescript_bindings` via `pnpm tauri:gen` after all model changes |
</phase_requirements>

---

## Summary

Phase 25 is a pure Rust backend rewrite. The core transformation is from a pool-based worktree model (pre-allocate, lease, return) to an on-demand model (create on task start, delete on task end). This involves: a schema migration, model type overhaul, implementing previously-stubbed git subprocess calls, 5 IPC commands removed and 5 new ones added, two call sites in execution_handlers.rs updated, and TypeScript bindings regenerated.

The codebase provides strong prior art for everything this phase needs. The `git/remote.rs` file already shows the exact `tokio::process::Command` pattern for git operations. The `db/schema.rs` shows the drop-and-recreate migration pattern (v1→v2 is the direct template for v2→v3). The existing IPC handlers all follow the `State<'_, Arc<AppState>>` + `db.lock()` pattern that new handlers must match.

The atomic risk is the pool removal: `create_worktree` must be implemented and verified before `lease_worktree` call sites in execution_handlers.rs are switched. These changes must be committed together to avoid a state where execution_handlers.rs calls a removed function.

**Primary recommendation:** Implement in three waves — (1) schema + models, (2) git operations + new IPC commands standalone, (3) atomic removal of pool commands + migration of execution_handlers.rs call sites — then regenerate bindings.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.20.4 | Structured diff output via libgit2 bindings | Only for get_worktree_diff; vendored-libgit2 avoids system dependency |
| notify | 8.2.0 | Filesystem event watching | Added per REQ-14; not used in Phase 25 handlers but required in Cargo.toml |
| tokio | 1 (existing) | Async runtime, process::Command, spawn, spawn_blocking | Already a dependency; all async git ops use this |
| rusqlite | 0.38.0 (existing) | SQLite database access | Already in use; schema migration follows established pattern |
| tauri-specta | 2.0.0-rc.20 (existing) | IPC type generation to TypeScript | All new commands must have #[tauri::command] + #[specta::specta] |

### Version Verification
Confirmed against crates.io API (2026-03-29):
- `git2`: latest stable = **0.20.4** (matches requirement exactly)
- `notify`: latest stable = **8.2.0**, latest pre-release = 9.0.0-rc.2 (requirement specifies 8.2.0 — correct, use stable)

**Installation addition to Cargo.toml:**
```toml
git2 = { version = "0.20.4", features = ["vendored-libgit2"] }
notify = "8.2.0"
```

---

## Architecture Patterns

### Established IPC Handler Pattern (HIGH confidence — verified from existing code)

All async handlers follow this exact structure:

```rust
// Source: src-tauri/src/ipc/worktree_handlers.rs and execution_handlers.rs
#[tauri::command]
#[specta::specta]
pub async fn my_new_command(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<SomeType, String> {
    // Lock DB - always drop before any .await point
    let result = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        // do sync DB work
        // conn is dropped here (scope closes)
    };

    // Async git work happens outside the DB lock
    tokio::process::Command::new("git")
        .args([...])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("git failed: {}", e))?;

    Ok(result)
}
```

**CRITICAL:** Never hold the DB mutex lock across an `.await` point. SQLite Mutex is `std::sync::Mutex`, not `tokio::sync::Mutex` — it is blocking and cannot be held across await.

### tokio::process::Command Pattern (HIGH confidence — from git/remote.rs)

```rust
// Source: src-tauri/src/git/mod.rs (list_branches_local pattern)
// and to be extended for worktree add/remove

use tokio::process::Command;

async fn create_worktree_local(path: &str, branch: &str, worktree_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "add", worktree_path, branch])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }
    Ok(())
}
```

**Note:** The existing `list_branches_local` uses `std::process::Command` (blocking). New implementations in this phase MUST use `tokio::process::Command`. The stubs in `git/mod.rs` that said "TODO: Phase 3-01 sidecar integration" are now replaced with direct git subprocess calls — the sidecar approach was abandoned in favor of direct git CLI.

### git2 spawn_blocking Pattern (HIGH confidence — Rust async best practice)

```rust
// git2 is synchronous; must wrap in spawn_blocking to not block the async runtime
pub async fn get_worktree_diff_local(
    project_path: &str,
    worktree_path: &str,
    branch_name: &str,
) -> Result<String, String> {
    let project_path = project_path.to_string();
    let worktree_path = worktree_path.to_string();
    let branch_name = branch_name.to_string();

    tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&worktree_path)
            .map_err(|e| format!("Failed to open repo: {}", e))?;
        // ... git2 diff operations ...
        Ok(diff_string)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
}
```

### git worktree list --porcelain Format (HIGH confidence — verified against live output)

Actual output from this repository:
```
worktree /home/m306213/workspace/maestro
HEAD 676a8737648b9f0729200ccc1bfc42b181443f4c
branch refs/heads/master

worktree /home/m306213/workspace/maestro/.emdash/worktrees/sunny-ravens-lick-1774299629570
HEAD 3e0afe073a04006db0a5f0fbe88a74afb7c7befa
branch refs/heads/sunny-ravens-lick-1774299629570
prunable gitdir file points to non-existent location
```

**Parse rules:**
- Entries separated by blank lines
- First entry is always the main worktree (filter it out by comparing path == project_path)
- `worktree <absolute-path>` — the path field
- `branch refs/heads/<branch-name>` — strip `refs/heads/` prefix
- `prunable ...` — indicates the worktree directory may be missing (treat as orphan candidate)
- Detached HEAD shows `HEAD <hash>` without a `branch` line

### Parallel git status Pattern (HIGH confidence)

```rust
// For list_worktrees_with_status — run git status per worktree concurrently
let handles: Vec<_> = worktrees.iter().map(|wt| {
    let path = wt.path.clone();
    tokio::spawn(async move {
        let output = tokio::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&path)
            .output()
            .await;
        (path, output)
    })
}).collect();

// Join all handles
for handle in handles {
    let (path, result) = handle.await.unwrap_or_default();
    // ...
}
```

### Schema Migration Pattern (HIGH confidence — from schema.rs v1→v2)

The existing migration at `db/schema.rs` is the exact template:

```rust
// Bump SCHEMA_VERSION to 3
pub const SCHEMA_VERSION: u32 = 3;

// In initialize_schema():
// The existing drop-all code already runs for any version < SCHEMA_VERSION
// Add new SCHEMA_V3 constant with updated worktrees table DDL
// Replace conn.execute_batch(SCHEMA_V2) with conn.execute_batch(SCHEMA_V3)
```

New worktrees table DDL for v3:
```sql
CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    branch_name TEXT NOT NULL,
    path TEXT NOT NULL,
    git_status TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

**Key changes from v2:** `task_id` (nullable FK to tasks), `git_status` (nullable text), removed `status`, `leased_at`, `returned_at`.

### New View Models for worktree.rs (HIGH confidence)

```rust
// Add to models/worktree.rs — replace WorktreeStatus + PoolStatus + Worktree

/// On-disk worktree state + DB enrichment
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeWithStatus {
    pub id: Option<i32>,           // None if orphan (no DB row)
    pub project_id: Option<i32>,
    pub task_id: Option<i32>,
    pub branch_name: String,
    pub path: String,
    pub git_status: String,        // raw porcelain string
    pub created_at: Option<String>,
    pub task_name: Option<String>,
    pub agent_status: Option<String>, // from execution_logs.status
    pub is_zombie: bool,
    pub is_orphan: bool,           // true if no DB row (on-disk but not tracked)
}

/// Execution log + task name + worktree branch
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExecutionWithTask {
    pub id: i32,
    pub task_id: i32,
    pub task_name: String,
    pub branch_name: Option<String>,
    pub status: ExecutionStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub terminal_output: Option<String>,
}
```

### Worktree Path Constant (HIGH confidence)

```rust
// In worktree_handlers.rs (or a shared constants module)
pub const WORKTREE_PATH_TEMPLATE: &str = ".maestro/worktrees/task-{}";

// Helper to build the path:
pub fn worktree_path_for_task(task_id: i32) -> String {
    format!(".maestro/worktrees/task-{}", task_id)
}
```

### create_worktree_for_task Internal Helper (HIGH confidence)

The IPC command `create_worktree` is the public API. An internal helper `create_worktree_for_task(task_id, project_id, repo_path, app_state)` wraps it for use by execution_handlers.rs:

```rust
// Called from spawn_agent_execution and resume_agent_execution
// replaces: super::lease_worktree(app_state.clone(), project_id, task_id, repo_path).await?
async fn create_worktree_for_task(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    repo_path: &str,
) -> Result<(i32, String), String> {
    // Returns (worktree_id, absolute_worktree_path)
    let relative_path = worktree_path_for_task(task_id);
    let abs_path = format!("{}/{}", repo_path, relative_path);
    // ... git worktree add, DB insert, return worktree_id + abs_path
}
```

### Finalization: Delete Not Return (HIGH confidence)

**Current code (to be replaced):**
- Line 356: `UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?`
- Line 994: `UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?`

**Replacement pattern:**
```rust
// In finalization block of spawn_agent_execution and resume_agent_execution tokio::spawn closures
// After execution completes (success or failure):
if let Ok(conn) = app_state_arc.db.lock() {
    let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", [worktree_id]);
    println!("[finalize] Deleted worktree {} on completion", worktree_id);
}
// Also invoke git worktree remove (best effort, don't fail on error)
let _ = tokio::process::Command::new("git")
    .args(["worktree", "remove", &worktree_path, "--force"])
    .current_dir(&repo_path)
    .output()
    .await;
```

### lib.rs Command Registration (HIGH confidence)

**Lines 45-50 to replace (the 6 pool commands):**
```rust
// REMOVE:
crate::ipc::lease_worktree,
crate::ipc::return_worktree,
crate::ipc::get_pool_status,
crate::ipc::cleanup_worktree,
crate::ipc::recover_dirty_worktrees,
crate::ipc::initialize_worktree_pool,

// ADD:
crate::ipc::list_worktrees_with_status,
crate::ipc::get_worktree_diff,
crate::ipc::create_worktree,
crate::ipc::delete_worktree,
crate::ipc::list_executions_with_task_info,
```

Also update `pub use` in `lib.rs` line 12 — remove `WorktreeStatus`, `PoolStatus` from the pub use statement; add `WorktreeWithStatus`, `ExecutionWithTask`.

### models/mod.rs Update (HIGH confidence)

```rust
// BEFORE:
pub use worktree::{Worktree, WorktreeStatus, PoolStatus};

// AFTER:
pub use worktree::{Worktree, WorktreeWithStatus, ExecutionWithTask};
```

Also remove from lib.rs pub use: `WorktreeStatus` (currently line 12).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Structured git diff | Custom diff parser | git2 crate with Diff API | Handles binary files, encodings, renames, context lines correctly |
| Async blocking ops | Spawning a thread manually | `tokio::task::spawn_blocking` | Integrated with tokio scheduler, propagates panics, idiomatic |
| Git porcelain parsing | Custom state machine | Simple line-by-line split on blank lines | The format is stable and minimal; over-engineering not needed |
| DB migrations | Custom migration framework | `PRAGMA user_version` + drop-and-recreate | Already established in this codebase; no production data to preserve |

**Key insight:** The git2 crate handles the one place where structured diff output is needed. Everything else is `tokio::process::Command` which is already proven in this codebase.

---

## Common Pitfalls

### Pitfall 1: Holding DB Lock Across .await
**What goes wrong:** Deadlock or runtime panic. `std::sync::Mutex` (used for AppState.db) cannot be held across an `.await` point in tokio.
**Why it happens:** Developer writes `let conn = app_state.db.lock()?; some_async_fn().await;` and holds the lock.
**How to avoid:** Always open a `{ let conn = ...; ... }` block that drops before any `.await` call. Review all new async IPC handlers.
**Warning signs:** Compilation warning about `MutexGuard` held across await; runtime deadlock when two commands execute concurrently.

### Pitfall 2: Non-atomic Pool Removal
**What goes wrong:** If pool commands are removed from lib.rs before `create_worktree_for_task` is integrated into execution_handlers.rs, the build breaks — `lease_worktree` is called but removed.
**Why it happens:** Pool removal and call site migration done in separate commits.
**How to avoid:** Implement `create_worktree_for_task` internal helper first, replace both call sites in execution_handlers.rs, then delete pool commands in the same commit.
**Warning signs:** `cargo build` fails with "cannot find function `lease_worktree`".

### Pitfall 3: Main Worktree Included in List
**What goes wrong:** The project root itself is the "main" worktree in git's model. `git worktree list --porcelain` always returns it first.
**Why it happens:** Parser treats all entries equally.
**How to avoid:** After parsing, filter: if `worktree.path == repo_path` (absolute comparison), skip it.
**Warning signs:** Worktrees view shows the project root as a worktree card.

### Pitfall 4: git2 Repository::open in Async Context
**What goes wrong:** `git2::Repository::open` is synchronous and may do significant I/O. If called directly in async fn, it blocks the tokio thread.
**Why it happens:** git2 API looks synchronous like a regular function call.
**How to avoid:** Always wrap git2 calls in `tokio::task::spawn_blocking`.
**Warning signs:** High latency, tokio warnings about blocking in async context.

### Pitfall 5: specta export on View Models
**What goes wrong:** TypeScript bindings not generated for `WorktreeWithStatus` or `ExecutionWithTask` if `#[specta(export)]` and `#[ts(export)]` are missing.
**Why it happens:** New structs added to models but not annotated.
**How to avoid:** All new public model structs need `#[derive(Type)]` + `#[specta(export)]`. Must also be re-exported from `models/mod.rs` and included in `lib.rs` pub use.
**Warning signs:** `pnpm tauri:gen` runs but bindings.ts doesn't contain the new types.

### Pitfall 6: Worktree Path Relativity
**What goes wrong:** `git worktree list --porcelain` returns absolute paths. DB stores relative path `.maestro/worktrees/task-X`. Comparison fails.
**Why it happens:** Mixing absolute and relative paths when reconciling disk state with DB state.
**How to avoid:** When matching disk worktrees to DB rows, construct the absolute path from `repo_path + "/" + db.path` before comparing, or normalize both to absolute before comparing.
**Warning signs:** All DB worktrees appear as "orphan" even when they exist on disk.

### Pitfall 7: tokio::spawn closure capture of worktree_id
**What goes wrong:** After `create_worktree_for_task` returns `(worktree_id, worktree_path)`, both values must be captured by the `tokio::spawn(async move { ... })` closure for use in the finalization block.
**Why it happens:** Current code captures `worktree_id` from `worktree.id` after `lease_worktree`. New code must ensure equivalent capture from `create_worktree_for_task`.
**How to avoid:** Destructure the return tuple before the `tokio::spawn` call and verify both values are captured.

---

## Code Examples

### git worktree list --porcelain Parser

```rust
// Source: verified against live output (this repository has active worktrees)
struct ParsedWorktree {
    path: String,
    branch: Option<String>,
    head: String,
    is_prunable: bool,
}

fn parse_worktree_list(output: &str) -> Vec<ParsedWorktree> {
    output.split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut path = String::new();
            let mut branch = None;
            let mut head = String::new();
            let mut is_prunable = false;

            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = p.to_string();
                } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(b.to_string());
                } else if let Some(h) = line.strip_prefix("HEAD ") {
                    head = h.to_string();
                } else if line.starts_with("prunable") {
                    is_prunable = true;
                }
            }

            ParsedWorktree { path, branch, head, is_prunable }
        })
        .collect()
}
```

### SQL for list_executions_with_task_info

```sql
-- Recommended join structure (Claude's discretion)
SELECT
    el.id,
    el.task_id,
    t.name AS task_name,
    w.branch_name,
    el.status,
    el.started_at,
    el.completed_at,
    el.terminal_output
FROM execution_logs el
INNER JOIN tasks t ON t.id = el.task_id
LEFT JOIN worktrees w ON w.task_id = el.task_id
WHERE t.project_id = ?
ORDER BY el.started_at DESC
```

**Note:** LEFT JOIN on worktrees because the worktree may have been deleted after execution completes. Still want to show the execution history.

### SQL for list_worktrees_with_status (DB portion)

```sql
-- Get DB worktrees with task info and agent status
SELECT
    w.id,
    w.project_id,
    w.task_id,
    w.branch_name,
    w.path,
    w.created_at,
    t.name AS task_name,
    el.status AS agent_status
FROM worktrees w
LEFT JOIN tasks t ON t.id = w.task_id
LEFT JOIN execution_logs el ON el.task_id = w.task_id
    AND el.id = (
        SELECT id FROM execution_logs
        WHERE task_id = w.task_id
        ORDER BY started_at DESC LIMIT 1
    )
WHERE w.project_id = ?
```

### Zombie Detection

```rust
// In WorktreeWithStatus construction:
let is_zombie = worktree_db_row.task_id.is_none()
    && worktree_db_row.path.contains(".maestro/worktrees/task-");
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Pool pre-allocation (Available/Leased/InUse/Dirty) | On-demand create/delete per task | Phase 25 | Eliminates pool size limits, dirty recovery, pool initialization on startup |
| Sidecar Node.js for local git ops | Direct tokio::process::Command | Phase 25 (stubs never implemented) | Removes Node.js dependency for git operations; simpler, fewer moving parts |
| WorktreeStatus enum (4 states) | is_zombie: bool + is_orphan: bool | Phase 25 | Cleaner model; state is computed not persisted |

**Deprecated/outdated:**
- `WorktreeStatus` enum: Removed. Pool states no longer exist.
- `PoolStatus` struct: Removed. No pool to monitor.
- `Worktree.status` column: Removed from schema v3.
- `Worktree.leased_at` / `returned_at` columns: Removed from schema v3.
- `recover_dirty_worktrees` IPC: Removed. Replaced by `cleanup_zombie_worktrees` in Phase 28.

---

## Runtime State Inventory

This is NOT a rename/refactor phase — it is a schema migration and model overhaul. However, state impact exists:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | SQLite worktrees table: v2 schema with status/leased_at/returned_at columns | Schema migration (drop-and-recreate) in `initialize_schema()` when SCHEMA_VERSION bumps 2→3 |
| Live service config | None — no external service registration | None |
| OS-registered state | None | None |
| Secrets/env vars | None | None |
| Build artifacts | `src/types/bindings.ts` — auto-generated; stale after model changes | `pnpm tauri:gen` must run after all Rust model changes (REQ-15) |

**Data migration note:** Drop-and-recreate is safe because no production data exists (REQUIREMENTS.md decision). The migration auto-fires when the app opens with SCHEMA_VERSION < 3.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| git CLI | tokio::process::Command git calls | Yes | 2.39.5 | — |
| cargo | Rust build | Yes | 1.94.0 | — |
| pnpm | tauri:gen (bindings regeneration) | Assumed yes (existing project) | — | — |
| git2 crate (vendored) | get_worktree_diff | Requires libclang/cmake for vendored build | TBD | `features = ["vendored-libgit2"]` compiles libgit2 from source — no system libgit2 needed, but requires C compiler (gcc/clang) |

**Note on git2 vendored build:** The `vendored-libgit2` feature compiles libgit2 from source during `cargo build`. This requires a C compiler. On this Linux system, gcc is expected to be available. If the cross-compilation target `x86_64-pc-windows-msvc` (from CLAUDE.md) is used, `cargo-xwin` handles the MSVC toolchain — vendored libgit2 should compile correctly through cargo-xwin.

---

## Validation Architecture

`workflow.nyquist_validation` is not set in `.planning/config.json` — treat as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in `cargo test` + Vitest (frontend) |
| Config file | No explicit config — `cargo test` in `src-tauri/` |
| Quick run command | `cd src-tauri && cargo check` |
| Full suite command | `cd src-tauri && cargo test` |
| Binding gen command | `pnpm tauri:gen` (runs `cargo test generate_typescript_bindings`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-01 | Schema v3 applied on startup; worktrees table has new columns | unit | `cd src-tauri && cargo test test_schema_initialization` | Yes (schema test exists, needs update) |
| REQ-02 | WorktreeWithStatus + ExecutionWithTask compile and serialize | unit | `cd src-tauri && cargo build` (compile check) | No — new types |
| REQ-03 | git worktree add/remove execute without error | manual smoke | `pnpm tauri:dev` + manual test | No |
| REQ-05 | Pool commands absent from build | compile | `cd src-tauri && cargo build` | No explicit test |
| REQ-06-10 | New IPC commands in collect_commands! | compile | `cd src-tauri && cargo build` | No explicit test |
| REQ-13 | No std::process::Command in async IPC | code review | `grep -n "std::process::Command" src-tauri/src/ipc/` | — |
| REQ-14 | git2 + notify in Cargo.toml | compile | `cd src-tauri && cargo build` | — |
| REQ-15 | bindings.ts regenerated | manual | `pnpm tauri:gen && pnpm build` | Yes (existing workflow) |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo check`
- **Per wave merge:** `cd src-tauri && cargo build && pnpm build`
- **Phase gate:** `pnpm tauri:gen` succeeds + `pnpm build` produces 0 TypeScript errors before phase is done

### Wave 0 Gaps
- No new test files needed for Wave 0 — existing `test_schema_initialization` must be updated to assert SCHEMA_VERSION == 3 and verify new worktrees columns
- The main validation is compilation: if the code compiles and `pnpm tauri:gen` succeeds, the IPC surface is correct by construction (tauri-specta enforces type safety at compile time)

---

## Open Questions

1. **cleanup_zombie_worktrees scaffolding in Phase 25 or Phase 28?**
   - What we know: CONTEXT.md marks this as Claude's discretion. REQ-34 is Phase 28's requirement. Phase 25's is_zombie detection is only a flag on WorktreeWithStatus.
   - What's unclear: Should Phase 25 stub the IPC command signature (as a no-op) to avoid a frontend compilation error in Phase 27 that displays zombie badges?
   - Recommendation: Do NOT add cleanup_zombie_worktrees in Phase 25. Phase 27 only displays the `is_zombie` flag — it does not call the cleanup command. Phase 28 owns the IPC command. No stub needed.

2. **Partial results vs fail-all for git worktree list parse errors**
   - What we know: CONTEXT.md marks this as Claude's discretion.
   - Recommendation: Fail the whole call with a descriptive error. A partial list would show some worktrees missing, which is worse UX than a clear error. The planner should decide and document the chosen behavior in the plan.

3. **Does the existing `Worktree` struct (plain DB row model) remain alongside the new view models?**
   - What we know: REQ-02 says remove WorktreeStatus + PoolStatus, add WorktreeWithStatus + ExecutionWithTask. The base `Worktree` struct is not explicitly mentioned.
   - What's unclear: Whether any existing code still needs the plain `Worktree` type after the schema change removes its status/leased_at/returned_at fields.
   - Recommendation: Keep a simplified `Worktree` (matching new schema: id, project_id, task_id, branch_name, path, git_status, created_at) for DB hydration. `WorktreeWithStatus` is the view model built on top. Remove from models/mod.rs exports only what's no longer needed.

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/src/db/schema.rs` — Migration pattern (drop-and-recreate), SCHEMA_VERSION, worktrees DDL
- `src-tauri/src/models/worktree.rs` — Current WorktreeStatus, PoolStatus, Worktree structs (to be replaced)
- `src-tauri/src/git/mod.rs` — Local stubs with TODO comments; list_branches_local has std::process::Command example
- `src-tauri/src/git/remote.rs` — The reference implementation pattern for git CLI operations
- `src-tauri/src/ipc/worktree_handlers.rs` — All 5 pool commands to remove; full handler structure
- `src-tauri/src/ipc/execution_handlers.rs` — `lease_worktree` call sites at lines 120, 896; `status = 'Available'` writes at lines 356, 994
- `src-tauri/src/lib.rs` — Command registration; lines 45-50 pool commands; pub use exports
- `src-tauri/Cargo.toml` — Current dependency list; git2 and notify absent
- crates.io API (2026-03-29) — git2 0.20.4 (max stable), notify 8.2.0 (max stable)
- Live `git worktree list --porcelain` output — verified actual format with real worktrees

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` — REQ-01 through REQ-15 full specification
- `.planning/phases/25-backend-overhaul/25-CONTEXT.md` — All locked decisions and implementation guidance

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified against crates.io API
- Architecture: HIGH — all patterns verified from existing source code
- Pitfalls: HIGH — grounded in actual code being modified
- SQL joins: MEDIUM — structure recommended based on schema; planner may adjust

**Research date:** 2026-03-29
**Valid until:** 2026-04-29 (stable domain — Rust crate APIs don't change rapidly)
