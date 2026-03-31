# Phase 33: Tauri Backend Code Review and Refactoring for Maintainability — Research

**Researched:** 2026-03-31
**Domain:** Rust/Tauri backend (src-tauri/src/) — DRY, SOLID, KISS
**Confidence:** HIGH (all findings derived from direct code reading)

---

## Summary

Phase 32 fixed the most critical correctness bugs and security issues identified in an earlier code review (broken queries, panics, duplicate polling, shell injection, password zeroing, AppError removal, and more). The backend is now structurally sound and compiles cleanly.

Phase 33 is a second-pass maintainability sweep. After reading every file in `src-tauri/src/`, this research identifies the remaining DRY violations, SOLID violations, complexity issues, and cleanup opportunities. None of these are correctness bugs — all are code-quality issues that make the codebase harder to understand and extend.

The highest-value targets are: (1) the `save_task_review` / `request_changes` duplicate insert-then-query-for-id pattern in `review_handlers.rs`; (2) the `clone_project` / `create_new_project` duplicate DB registration block in `project_handlers.rs`; (3) the `connect_ssh_*` family in `ssh_handlers.rs` which share 4 near-identical steps; (4) the `list_project_branches` project lookup that does not use `get_project_with_git_conn`; and (5) small scattered cleanup items (leftover `println!` in `process/remote.rs`, unused `canonicalize_repo_path` in `execution_handlers.rs`, `serde_json::Value` return from review functions, undef-able empty module `error.rs`).

**Primary recommendation:** Address in 2-3 plans grouped by scope: (A) review_handlers DRY + project_handlers DRY, (B) ssh_handlers connection helper extraction, (C) miscellaneous cleanup.

---

## Project Constraints (from CLAUDE.md)

- Rust modules: snake_case filenames; TypeScript/React: camelCase functions, PascalCase components/types
- IPC handlers return `Result<T, String>` — no custom error types in IPC layer
- `AppState` contains `Mutex<Connection>` — always lock before DB operations, never hold across async `.await` points
- `tokio::process::Command` for all local git ops (not `std::process::Command`)
- Use Immer middleware on frontend Zustand stores (not relevant to backend)
- `pnpm tauri:gen` must be run after any Rust model/struct changes that have `#[derive(TS)]`
- cargo check must pass at end of every change

---

## What Phase 32 Already Fixed

These are NOT targets for Phase 33 (they are done):

| Fixed in Phase 32 | Location |
|---|---|
| Broken review queries (V5 schema) | review_handlers.rs |
| `.expect()` → `map_err+?` on project inserts | project_handlers.rs |
| Remote log polling duplicated | process/remote.rs |
| `WorktreeSnapshot` stale fields | models/project_state.rs |
| `resume_agent_execution` delegates to `spawn` | execution_handlers.rs |
| `get_project_with_git_conn` helper extracted | db/connection.rs |
| `TASK_SELECT` centralized | models/task.rs |
| `update_task` single dynamic UPDATE | task_handlers.rs |
| `filter_map(r.ok())` → error logging | worktree_handlers.rs, execution_handlers.rs |
| Shell injection fix (`shell_quote`) | git/remote.rs, project_handlers.rs |
| Password zeroing (`Zeroizing<String>`) | db/connection.rs, ssh/ |
| Reconnection race fix | ssh/session.rs |
| PTY writer stored (no fd clone per keystroke) | process/pty.rs |
| `AppError` removed | error.rs (now comment-only) |
| `upsert_imported_tasks` extracted | settings_handlers.rs |
| `stop_remote_stream` calls `kill_remote_process` | process/remote.rs |

---

## Architecture Patterns (Current State)

### Module Boundaries

```
src-tauri/src/
├── lib.rs               # Entry point, IPC command registration (collect_commands![])
├── main.rs              # Tauri app setup, injects AppState
├── error.rs             # Empty — comment only (Phase 32 removed AppError)
├── db/
│   ├── connection.rs    # AppState, init_db, get_git_connection, get_project_with_git_conn
│   ├── schema.rs        # SQL migrations (SCHEMA_VERSION = 1)
│   ├── settings.rs      # load_settings / save_settings helpers
│   ├── execution_logs.rs # DB helpers for execution log lifecycle
│   ├── project_storage.rs # .maestro folder file I/O
│   └── mod.rs           # pub use re-exports
├── models/              # Domain types with #[derive(TS)] for TypeScript binding gen
│   ├── task.rs          # Task, TaskStatus, TASK_SELECT const, ProjectConfigRequest/Response
│   └── ...
├── ipc/
│   ├── project_handlers.rs
│   ├── task_handlers.rs
│   ├── worktree_handlers.rs
│   ├── execution_handlers.rs
│   ├── review_handlers.rs
│   ├── settings_handlers.rs
│   ├── ssh_handlers.rs
│   ├── filesystem_handlers.rs
│   └── mod.rs           # glob re-exports all handlers
├── git/
│   ├── mod.rs           # Public dispatcher: routes Local/Remote git ops
│   └── remote.rs        # SSH git commands, poll_remote_log, kill_remote_process
├── ssh/
│   ├── mod.rs
│   ├── session.rs       # RemoteSshSession, SshConnection, auth
│   └── password_manager.rs
├── process/
│   ├── mod.rs           # spawn_agent_execution dispatcher (Local=todo!, Remote=live)
│   ├── spawner.rs       # spawn_agent_cli (local Node.js sidecar)
│   ├── pty.rs           # PTY session management
│   └── remote.rs        # SSH agent spawn + poll_remote_log + stream_remote_output
└── websocket/
    └── streaming.rs     # attach_remote_stream_listener (calls poll_remote_log)
```

### Key Design Decisions (locked from prior phases)

- All IPC handlers: `Result<T, String>` — no custom error types at IPC boundary
- DB lock: held for minimum duration — never across `async .await` points
- `get_project_with_git_conn` is the standard helper for project+git_conn lookup
- `TASK_SELECT` constant in `models/task.rs` — all task queries use it
- `GitConnection` enum dispatches Local vs. Remote — all git ops go through `git/mod.rs` dispatcher
- Phase 32 decision: `ProjectConfigRequest` kept as separate struct (not alias) — type aliases cannot carry `#[derive(TS)]`

---

## Remaining DRY Violations

### DRY-1: `save_task_review` and `request_changes` share identical review insert + id-lookup pattern

**Location:** `src-tauri/src/ipc/review_handlers.rs`

**What's duplicated:** Both functions do:
1. `INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at) VALUES ...`
2. `SELECT id FROM task_reviews WHERE task_id = ?` to get the insert ID
3. Loop inserting per-file comments via `review_comments`

This pattern appears in `save_task_review` (lines 141–169) and `request_changes` (lines 193–217). The only difference is the decision value ("Approve"/"RequestChanges") and whether a task status UPDATE follows.

**Fix:** Extract private `fn insert_review_with_comments(conn, task_id, decision, general_feedback, per_file_comments, now) -> Result<i32, String>`.

**Note:** Using `conn.last_insert_rowid()` is cleaner than re-querying — it's the standard rusqlite idiom and avoids an extra query. The current code uses `SELECT id FROM task_reviews WHERE task_id = ?` which is also fragile (returns the first match for task_id, not necessarily the just-inserted row). The helper should use `last_insert_rowid()`.

### DRY-2: `clone_project` and `create_new_project` duplicate the DB registration + maestro folder init block

**Location:** `src-tauri/src/ipc/project_handlers.rs`

**What's duplicated:** Both functions (lines 296–335 in `clone_project`, lines 396–428 in `create_new_project`) share:
1. Check-or-insert project row with `SELECT id FROM projects WHERE path = ? AND connection_id IS ?`
2. `INSERT INTO projects (...) VALUES (...)`
3. `create_project_maestro_folder` call (local only)
4. Final `SELECT ... FROM projects WHERE id = ?` to return the Project

These ~25 lines are near-identical.

**Fix:** Extract private `fn register_project_in_db(app_state, path, name, connection_id) -> Result<Project, String>`. The function handles check-or-insert, `.maestro` folder init, and returns the full Project row. Both `clone_project` and `create_new_project` call it.

**Note:** `create_project` (the older IPC command, lines 434–472) has a similar but slightly different pattern — it uses `connection_id = ?` (not `IS`) in the WHERE clause. This older handler can be unified with the helper too if the WHERE clause difference is resolved (it's a bug: `IS` is correct for nullable comparison in SQLite; `=` with NULL never matches).

### DRY-3: `list_project_branches` in `task_handlers.rs` does not use `get_project_with_git_conn`

**Location:** `src-tauri/src/ipc/task_handlers.rs`, lines 350–370

**What's duplicated:** This function manually queries the project row and then calls `get_git_connection` directly, with an `unwrap_or_else` fallback — the same two-step pattern that `get_project_with_git_conn` was designed to replace. It is the only IPC handler that still uses the old pattern.

**Fix:** Replace with `get_project_with_git_conn` (keeping the `unwrap_or_else` fallback separately if needed — the helper fails on missing SSH session, but `list_branches` should fall back gracefully).

Actually on reflection: `list_project_branches` needs the `unwrap_or_else` fallback for graceful branch listing even when SSH is disconnected. The correct refactor is:
```rust
let project = { /* query row only */ };
let git_conn = crate::db::get_git_connection(&project, &app_state).await
    .unwrap_or_else(|_| GitConnection::Local { path: project.path.clone() });
```
This is already the minimal form — the project query is only 4 lines. This is low priority but worth doing for consistency.

### DRY-4: `connect_ssh_*` handlers share 4 near-identical steps

**Location:** `src-tauri/src/ipc/ssh_handlers.rs`

**What's shared across `connect_ssh_without_credentials`, `connect_ssh_with_password`, `connect_ssh_with_agent`, `connect_ssh_with_key`:**
1. `get_ssh_connection(connection_id, app_state.clone())` — load SshConnection row
2. Construct `RemoteSshSession::new(connection)` — create session object
3. `.connect(...)` — establish SSH connection
4. `app_state.set_ssh_session(connection_id, session).await` — store session
5. Lock DB, update `last_used_at` and `updated_at` and optionally `auth_method`

Steps 4 and 5 are identical in all four handlers (aside from the `auth_method` update in password/agent/key variants).

**Fix:** Extract `async fn finalize_ssh_connection(app_state, connection_id, session, auth_method_update: Option<SshAuthMethod>) -> Result<(), String>` — stores session, updates DB timestamps, optionally updates auth_method. Reduces ~15 lines of duplicated code per handler.

---

## SOLID Violations

### SOLID-1: `review_handlers.rs` returns `serde_json::Value` from IPC commands

**Location:** `approve_task_and_merge`, `save_task_review`, `request_changes` all return `Result<serde_json::Value, String>`

**Violation:** These IPC commands use a raw JSON value as their return type, bypassing Tauri's type-safe specta binding system. The frontend cannot get compile-time TypeScript types for these responses.

**Impact:** The TypeScript bindings for these commands are typed as `unknown` or `Record<string, any>`, meaning the frontend cannot rely on type safety for merge outcomes and review responses.

**Fix:** Define typed Rust structs for the return values:
```rust
pub struct ReviewResult { pub success: bool, pub review_id: i32 }
pub struct MergeResult { pub success: bool, pub task_status: String, pub conflicts: Vec<String> }
```
Add `#[derive(Serialize, Deserialize, Type)] #[specta(export)]` and return these instead of `serde_json::json!(...)`. Run `pnpm tauri:gen` after.

**Confidence:** HIGH — this is a clear SOLID/ISP violation (the interface exposes an untyped blob) and a missed specta feature.

### SOLID-2: `get_project_settings` / `update_project_settings` ignore the `_project_id` parameter

**Location:** `src-tauri/src/ipc/project_handlers.rs`, lines 478–577

**Issue:** Both functions receive `_project_id: i32` but completely ignore it. Settings are stored globally in the `settings` table with no project scope. The IPC interface implies per-project settings but the implementation is global. This is a confusing API contract violation.

**Options:**
1. Remove `_project_id` from the IPC signature (breaking change — frontend code must update)
2. Add a comment explaining the current global-only behavior and that project-scoped settings are deferred

Option 2 is KISS-compliant (no code change needed, documents intent). Option 1 is SOLID-compliant but requires frontend changes. The right choice depends on whether the frontend actually uses `project_id` as a discriminator.

**Recommendation:** Add a clear `// TODO: Currently global. project_id parameter is accepted but ignored...` comment documenting the behavior. This is Phase 33 scope; per-project settings is a future feature.

### SOLID-3: `detect_error_type_and_suggestions` in `execution_handlers.rs` is never called

**Location:** `src-tauri/src/ipc/execution_handlers.rs`, lines 17–62

**Issue:** This function is defined as `pub fn` but grep shows no call sites anywhere in the codebase. It is dead code.

**Fix:** Remove it, or if it might be useful, keep it and add `#[allow(dead_code)]` with a comment. Since the backend handles execution errors by logging them, not by parsing stderr patterns, the function appears vestigial from an earlier design.

### SOLID-4: `finalize_successful_merge` uses a Node.js sidecar for worktree deletion

**Location:** `src-tauri/src/ipc/review_handlers.rs`, lines 381–416

**Issue:** The merge finalization calls `node sidecar/dist/index.js --delete-worktree` while `delete_worktree` in `worktree_handlers.rs` already handles git worktree deletion via the `git/mod.rs` dispatcher. This creates two code paths for worktree deletion — one via the Rust git dispatcher (used everywhere else) and one via the Node.js sidecar (used only in merge finalization).

**Impact:** If the Node.js sidecar is unavailable, the merge succeeds but the worktree is never cleaned up. The Rust path (`crate::git::delete_worktree`) already handles SSH-aware deletion and is more reliable.

**Fix:** Replace the sidecar call with `crate::git::delete_worktree(&git_conn, &worktree_path).await` (requires fetching the git_conn first). This is a medium-priority correctness improvement with DRY benefits.

**Note:** This requires `finalize_successful_merge` to receive either a `GitConnection` or `project_id` so it can resolve the connection. The function currently takes `repo_path: &str` which is sufficient for local, but SSH needs the connection.

---

## KISS Violations

### KISS-1: `get_diff_for_review` builds a partial `Project` struct manually

**Location:** `src-tauri/src/ipc/review_handlers.rs`, lines 24–64

**Issue:** The function manually constructs a partial `Project` struct with `name: String::new()`, `created_at: String::new()` etc. to get access to `project.is_remote()`. It could instead query the full project row (or use the project `connection_id` directly, since that is all `is_remote()` checks).

**Fix:** Replace the manual partial struct construction with:
```rust
let project = { let conn = app_state.db.lock()...; conn.query_row("SELECT id, name, path, created_at, updated_at, last_opened, connection_id FROM projects WHERE id = ?", ..., Project::from_row)? };
let git_conn = crate::db::get_git_connection(&project, &app_state).await?;
```
Or use `get_project_with_git_conn` for a single call.

### KISS-2: `println!` vs `log::` inconsistency in `process/remote.rs` and `filesystem_handlers.rs`

**Location:**
- `src-tauri/src/process/remote.rs` lines 67, 70, 154, 161, 168 — uses `println!` instead of `log::info!`
- `src-tauri/src/ipc/filesystem_handlers.rs` lines 7, 11, 40, 43 — uses `println!` instead of `log::info!`

**Issue:** Phase 32 switched most of the codebase to `log::` crate but these two files were missed. `println!` in a Tauri app goes to the process stdout which is not surfaced in production. `log::` output is routed through the Tauri logger infrastructure.

**Fix:** Replace `println!` with `log::info!` / `log::debug!` throughout both files. In `process/remote.rs` the messages are operational info (spawned PID, killed process, stream stopped), appropriate for `log::info!`. In `filesystem_handlers.rs` they are debug-level ("Found N subdirectories").

### KISS-3: `get_worktree_diff` makes two separate DB queries that could be one

**Location:** `src-tauri/src/ipc/worktree_handlers.rs`, lines 232–254

**Issue:** The function first queries `worktrees` to get `(path, branch_name, project_id)`, then immediately queries `projects` to get `repo_path`. These are two separate lock acquisitions and two queries. A single JOIN query would do it in one step.

**Fix:**
```rust
let (wt_path, branch_name, repo_path): (String, String, String) = {
    let conn = app_state.db.lock()...;
    conn.query_row(
        "SELECT w.path, w.branch_name, p.path FROM worktrees w JOIN projects p ON p.id = w.project_id WHERE w.id = ?",
        rusqlite::params![worktree_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )...
};
```

### KISS-4: `approve_task_and_merge` queries worktree info and project path in two separate sub-queries inside one lock

**Location:** `src-tauri/src/ipc/review_handlers.rs`, lines 262–287

**Issue:** The function does two separate `conn.query_row` calls inside a single lock scope — one for the task+worktree JOIN, one for `SELECT path FROM projects WHERE id = ?`. Both could be one JOIN query.

**Fix:** Combine into a single query:
```sql
SELECT t.name, w.branch_name, w.path, w.id, t.project_id, p.path
FROM tasks t
JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
JOIN projects p ON p.id = t.project_id
WHERE t.id = ?
```

---

## Common Pitfalls

### Pitfall 1: `last_insert_rowid()` vs. re-querying for inserted ID

**What goes wrong:** Querying `SELECT id ... WHERE task_id = ?` after an insert to get the row ID may return the wrong row if there are concurrent inserts (unlikely in a desktop app, but still wrong idiom).
**Prevention:** Always use `conn.last_insert_rowid()` immediately after a successful `conn.execute()` INSERT.
**Applies to:** `save_task_review`, `request_changes`, `reject_review` (the `ResumeWithInstructions` arm inserts `task_instructions` but uses last_insert_rowid implicitly via the returned instruction ID — this is fine).

### Pitfall 2: Holding `MutexGuard<Connection>` while spawning async work

**What goes wrong:** If DB lock is held when crossing an `.await` point, other handlers deadlock.
**Prevention:** All DB work must complete within a block `{ let conn = ...; ... }` that drops before any `.await`.
**Current state:** Phase 32 addressed the main cases. `finalize_successful_merge` has a clarifying comment. This pitfall is mostly resolved but reviewers should keep it in mind when adding new handlers.

### Pitfall 3: TypeScript binding generation after Rust struct changes

**What goes wrong:** Adding `#[derive(TS)]` structs without running `pnpm tauri:gen` leaves bindings stale; frontend sees old types.
**Prevention:** Any change to a struct with `#[derive(Type)] #[specta(export)]` MUST be followed by `pnpm tauri:gen`.
**Applies to:** SOLID-1 fix (adding `ReviewResult`, `MergeResult` structs).

### Pitfall 4: `connection_id IS ?` vs `connection_id = ?` for nullable SQLite columns

**What goes wrong:** `WHERE connection_id = ?` with a `None`/NULL binding never matches rows with NULL connection_id in SQLite (NULL ≠ NULL). The correct form is `IS`.
**Example:** `create_project` (line 444) uses `connection_id = ?` while `clone_project` / `create_new_project` correctly use `IS ?`.
**Prevention:** Always use `IS ?` when binding optional/nullable values in WHERE clauses.

---

## Code Examples

### Correct: using `last_insert_rowid()` after INSERT

```rust
// Source: Direct code reading of task_handlers.rs (correct pattern)
conn.execute(
    "INSERT INTO tasks (...) VALUES (...)",
    rusqlite::params![...],
).map_err(|e| e.to_string())?;
let task_id = conn.last_insert_rowid();
```

### Incorrect (current): querying for insert ID after INSERT

```rust
// Source: review_handlers.rs — fragile pattern that should be replaced
conn.execute(
    "INSERT INTO task_reviews (task_id, ...) VALUES (?, ...)",
    rusqlite::params![task_id, ...],
).map_err(|e| ...)?;
// BUG: This returns first match for task_id, not the just-inserted row
let review_id: i32 = conn.query_row(
    "SELECT id FROM task_reviews WHERE task_id = ?",
    [task_id], |row| row.get(0),
).map_err(|e| e.to_string())?;
```

### Correct: extract helper for review insert

```rust
// Proposed helper
fn insert_review_with_comments(
    conn: &rusqlite::Connection,
    task_id: i32,
    decision: &str,
    general_feedback: Option<&str>,
    per_file_comments: Option<&[(String, String)]>,
    now: &str,
) -> Result<i32, String> {
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task_id, decision, general_feedback, now, now],
    ).map_err(|e| format!("Insert review failed: {}", e))?;
    let review_id = conn.last_insert_rowid() as i32;

    if let Some(comments) = per_file_comments {
        for (file_path, comment) in comments {
            conn.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at) VALUES (?, ?, ?, ?)",
                rusqlite::params![review_id, file_path, comment, now],
            ).map_err(|e| format!("Insert comment failed: {}", e))?;
        }
    }
    Ok(review_id)
}
```

### Correct: typed return struct for IPC instead of serde_json::Value

```rust
// Proposed: typed response for review commands
#[derive(Debug, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ReviewResult {
    pub success: bool,
    pub review_id: i32,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct MergeResult {
    pub success: bool,
    pub task_status: String,
    pub conflicts: Vec<String>,
}
```

---

## Prioritized Finding List

| ID | File | Category | Severity | Description |
|----|------|----------|----------|-------------|
| R1 | review_handlers.rs | DRY | MEDIUM | `save_task_review`/`request_changes` duplicate review insert + comment loop |
| R2 | review_handlers.rs | DRY | MEDIUM | `insert_review_with_comments` should use `last_insert_rowid()` not re-query |
| R3 | review_handlers.rs | SOLID | MEDIUM | `approve_task_and_merge` / `save_task_review` / `request_changes` return `serde_json::Value` — loses type safety |
| R4 | review_handlers.rs | KISS | LOW | `get_diff_for_review` manually constructs partial `Project` struct |
| R5 | review_handlers.rs | SOLID | MEDIUM | `finalize_successful_merge` uses Node.js sidecar for worktree deletion instead of Rust git dispatcher |
| R6 | review_handlers.rs | KISS | LOW | `approve_task_and_merge` makes two queries that could be one JOIN |
| R7 | project_handlers.rs | DRY | MEDIUM | `clone_project`/`create_new_project` duplicate DB registration + maestro init block |
| R8 | project_handlers.rs | BUG | LOW | `create_project` uses `connection_id = ?` (should be `IS ?`) for nullable column |
| R9 | project_handlers.rs | SOLID | LOW | `get_project_settings`/`update_project_settings` accept `_project_id` but ignore it — misleading interface |
| R10 | ssh_handlers.rs | DRY | MEDIUM | `connect_ssh_with_*` family share 4 near-identical finalization steps |
| R11 | task_handlers.rs | DRY | LOW | `list_project_branches` does not use `get_project_with_git_conn` (only remaining old-pattern handler) |
| R12 | execution_handlers.rs | SOLID | LOW | `detect_error_type_and_suggestions` is dead code — never called |
| R13 | execution_handlers.rs | KISS | LOW | `canonicalize_repo_path` is defined as a private fn but only called once inline |
| R14 | process/remote.rs | KISS | LOW | Uses `println!` instead of `log::` (Phase 32 partial migration) |
| R15 | filesystem_handlers.rs | KISS | LOW | Uses `println!` instead of `log::` |
| R16 | worktree_handlers.rs | KISS | LOW | `get_worktree_diff` makes two separate DB lock+query calls that could be one JOIN |
| R17 | error.rs | CLEANUP | LOW | File is a comment-only stub — could be removed or left as-is |

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Typed IPC return values | Hand-roll JSON building | Rust structs with `#[derive(Type)] #[specta(export)]` | specta generates TypeScript types automatically |
| SSH connection teardown boilerplate | Copy-paste boilerplate | Extract helper function | All 4 connect handlers do the same steps |
| Review insert deduplication | Two separate functions | Shared private helper | Same code path, different parameters |

---

## Architecture Patterns (Relevant for Phase 33)

### Pattern: Private helper for shared multi-step DB operations

When multiple IPC handlers share a multi-step DB operation (query, insert, update), extract a private `fn` that takes a `&rusqlite::Connection` or `&rusqlite::Transaction` and encapsulates the steps. This is the pattern established by `upsert_imported_tasks` in `settings_handlers.rs` (Phase 32).

```rust
fn insert_review_with_comments(
    conn: &rusqlite::Connection, // or &rusqlite::Transaction
    task_id: i32,
    ...
) -> Result<i32, String> {
    // all steps in one place
}
```

### Pattern: Typed response structs for IPC commands

IPC commands that currently return `serde_json::Value` should return named structs. This enables specta to generate TypeScript types and eliminates `any`-typed responses in the frontend.

```rust
#[derive(Debug, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct MergeResult {
    pub success: bool,
    pub task_status: String,
    pub conflicts: Vec<String>,
}
```

After adding struct: run `pnpm tauri:gen` to regenerate `src/types/bindings.ts`.

### Pattern: DB registration helper for project creation

Both `clone_project` and `create_new_project` contain the same 25-line block for checking if a project exists and inserting/returning it. Extract a private `async fn register_project_in_db` that accepts `(app_state, path, name, connection_id)` and returns `Result<Project, String>`. The function handles check-or-insert and `.maestro` init.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 33 is pure Rust refactoring; no external tool dependencies are introduced. Existing dependencies (cargo, Node.js, git) are already verified by Phase 32 execution on this machine.

---

## Validation Architecture

`workflow.nyquist_validation` is not explicitly set to false in `.planning/config.json` — validation is enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust `cargo test` (built-in) + Vitest (frontend) |
| Config file | `src-tauri/Cargo.toml` (rust tests inline), `vite.config.ts` (frontend) |
| Quick run command | `cd src-tauri && cargo check` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements → Test Map

Phase 33 is a refactoring phase — no new behavior is introduced. The test gate is:

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REF-01 | `cargo check` passes after all changes | compile | `cd src-tauri && cargo check 2>&1 | tail -5` | N/A (cargo built-in) |
| REF-02 | All existing `cargo test` pass after changes | unit | `cd src-tauri && cargo test 2>&1 | tail -10` | N/A (cargo built-in) |
| REF-03 | TypeScript bindings regenerate cleanly | integration | `pnpm tauri:gen 2>&1 | tail -5` | N/A (if structs added) |

### Sampling Rate

- **Per task commit:** `cd src-tauri && cargo check`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** `cargo test` green before `/gsd:verify-work`

### Wave 0 Gaps

None — existing test infrastructure covers all refactoring requirements. No new test files needed.

---

## Open Questions

1. **Should `finalize_successful_merge` be fully migrated to the Rust git dispatcher for worktree deletion?**
   - What we know: It currently uses the Node.js sidecar (`--delete-worktree`). The Rust `delete_worktree` handler already does this correctly.
   - What's unclear: `finalize_successful_merge` doesn't currently have access to a `GitConnection` — it would need `project_id` and an `AppState` to resolve one.
   - Recommendation: Yes, migrate it. Add `app_state: &Arc<AppState>` to `finalize_successful_merge`'s signature (it already has it) and call `get_project_with_git_conn` to get the connection before calling `crate::git::delete_worktree`. This removes the Node.js sidecar dependency from the merge path.

2. **Should `serde_json::Value` return types be replaced with typed structs (SOLID-1)?**
   - What we know: Replacing them requires frontend TypeScript updates to use the new typed fields instead of `response.task_status`, `response.review_id` etc. (which currently works as untyped JSON access).
   - What's unclear: Whether the frontend TypeScript is currently typed against these values or uses `any`.
   - Recommendation: Yes, do it. The frontend likely uses `response.task_status` etc. as string access which will continue to work after the type change. The benefit is TypeScript-level type safety for future changes.

3. **Should `create_project` (the older IPC) also be updated to use `IS ?` instead of `= ?`?**
   - What we know: `create_project` (line 444) has `WHERE path = ? AND connection_id = ?` which never matches when `connection_id` is NULL. This means calling `create_project` for a local project would always insert a new row even if it already exists.
   - What's unclear: Whether `create_project` is still actively called with `connection_id = null` or if `clone_project`/`create_new_project` have replaced it for local projects.
   - Recommendation: Fix the bug (`= ?` → `IS ?`) as part of R8 regardless.

---

## Sources

### Primary (HIGH confidence)

- Direct code reading of all files in `src-tauri/src/` — authoritative ground truth
- Phase 32 PLAN files (32-01 through 32-05) — confirmed what was already fixed
- STATE.md `## Decisions` section — locked decisions from prior phases

### Secondary (MEDIUM confidence)

- CLAUDE.md — project conventions confirmed against actual code patterns
- Rust rusqlite docs patterns (`last_insert_rowid`) — well-established idiom

---

## Metadata

**Confidence breakdown:**
- Finding inventory: HIGH — derived from direct code reading, not assumptions
- Fix recommendations: HIGH — standard Rust/rusqlite patterns, well-established
- Prioritization: MEDIUM — severity judgments are subjective; planner may reorder

**Research date:** 2026-03-31
**Valid until:** 2026-04-30 (code doesn't change unless someone modifies it)
