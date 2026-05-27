# Phase 57: Data Model & Backend - Research

**Researched:** 2026-05-26
**Domain:** Rust backend — SQLite schema migration, Tauri IPC commands, ACP/PTY session management; TypeScript service layer
**Confidence:** HIGH

## Summary

Phase 57 adds two new task fields (`auto_approve`, `isolated_worktree`), a new `task_attachments` table, three attachment CRUD IPC commands, one `interrupt_task` IPC command, and the corresponding frontend service hooks in `task.service.ts`. All Rust changes are pure backend — no UI work is in scope. The frontend phases (58–62) consume these new fields and commands.

**Critical discovery:** The schema is already at V17 (bumped in the Phase 56 commit that renamed `tasks.name → tasks.title` on 2026-05-24). The STATE.md blocker "confirm current schema version" is now resolved: Phase 57 must use **V18**, not V17. `SCHEMA_VERSION` in `schema.rs` is currently `17`; the constant must be changed to `18`.

The `interrupt_task` IPC command requires searching both `app_state.acp.sessions` (ACP sessions) and `app_state.pty.session_meta` (PTY sessions) by `task_id` to find the active session key, then delegating to the existing cancellation path and resetting the task status to Backlog. The existing `cancel_acp_session` and `close_pty_session` commands are the right building blocks to mirror.

The frontend service hooks follow a strict pattern in `task.service.ts`: queries use `useQuery` with a key from `taskQueryKeys`, mutations use `useMutation` with `queryClient.invalidateQueries` in `onSuccess`. The four new hooks must be added to this same file.

**Primary recommendation:** Implement as two plans — Plan 1: schema + model changes (Rust, data only); Plan 2: four IPC handlers + `lib.rs` registration + `pnpm tauri:gen` + four service hooks in `task.service.ts`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DATA-01 | Task model has `auto_approve: bool` (default false) and `isolated_worktree: bool` (default true) fields | Task struct in `models/task.rs`, TASK_SELECT constant, schema `tasks` table — all three need updating |
| DATA-02 | `task_attachments` table with CASCADE delete on task removal | Schema V18 migration in `schema.rs`, new `TaskAttachment` model in `models/task.rs` |
| DATA-03 | IPC commands for attachment CRUD (`get_task_attachments`, `add_task_attachment`, `remove_task_attachment`) | Follow pattern from `task_handlers.rs`; register in `lib.rs`; add hooks to `task.service.ts` |
| DATA-04 | `interrupt_task` IPC command stops agent session and moves task to Backlog | Requires dual ACP+PTY session search by `task_id`; mirrors `cancel_acp_session` + status update; add mutation hook to `task.service.ts` |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Task field extension (auto_approve, isolated_worktree) | Database / Storage | API / Backend | SQLite schema + Rust model + TASK_SELECT constant |
| Task attachments table | Database / Storage | API / Backend | SQLite table + CASCADE FK + Rust model |
| Attachment CRUD IPC | API / Backend | — | Tauri #[tauri::command] handlers wrapping DB ops |
| interrupt_task IPC | API / Backend | — | Session lookup in AppState + DB status update |
| TypeScript service hooks | Frontend (API layer) | — | `task.service.ts` — TanStack Query wrappers over `api.*` calls |
| TypeScript binding regeneration | Build / Toolchain | — | `pnpm tauri:gen` runs cargo test internally |

## Standard Stack

### Core (already in Cargo.toml)
| Library | Purpose | Notes |
|---------|---------|-------|
| rusqlite | SQLite access | Schema migration, all DB queries |
| serde / serde_json | JSON serialization | Task fields, JSON-stored arrays |
| specta | TypeScript binding gen | `#[specta::specta]` on IPC commands |
| tauri-specta | Tauri+specta integration | `#[tauri::command]` + `#[specta::specta]` |
| chrono | Timestamps | `Utc::now().to_rfc3339()` for `created_at` |
| @tanstack/react-query | Frontend data fetching | `useQuery` / `useMutation` in service hooks |

[VERIFIED: direct code inspection of Cargo.toml and existing handlers]

No new dependencies needed for this phase.

## Architecture Patterns

### System Architecture Diagram

```
Frontend (Phase 62+)
    │  invoke("interrupt_task", { task_id })
    │  invoke("add_task_attachment", { task_id, filename, file_path, file_size })
    │  invoke("get_task_attachments", { task_id })
    │  invoke("remove_task_attachment", { attachment_id })
    ▼
Tauri IPC layer (lib.rs collect_commands![...])
    │
    ├─ interrupt_task ────► ACP sessions map (app_state.acp.sessions)
    │                       scan for task_id match → get log_id
    │                ────► PTY session_meta map (app_state.pty.session_meta)
    │                       scan for task_id match → get log_id
    │                ────► cancel/close session
    │                ────► DB: UPDATE tasks SET status='Backlog' WHERE id=?
    │                ────► emit "tasks-changed"
    │
    ├─ get_task_attachments ──► DB: SELECT * FROM task_attachments WHERE task_id=?
    ├─ add_task_attachment ───► DB: INSERT INTO task_attachments (...)
    └─ remove_task_attachment ► DB: DELETE FROM task_attachments WHERE id=?

Service layer (task.service.ts)
    ├─ useTaskAttachmentsQuery(taskId)      ── useQuery  → api.getTaskAttachments
    ├─ useAddTaskAttachmentMutation()       ── useMutation → api.addTaskAttachment
    ├─ useRemoveTaskAttachmentMutation()    ── useMutation → api.removeTaskAttachment
    └─ useInterruptTaskMutation()           ── useMutation → api.interruptTask
```

### Schema Migration Pattern (V18)
[VERIFIED: inspection of `src-tauri/src/db/schema.rs`]

The schema migration is **destructive** — all tables are dropped and recreated. This is the project convention (dev environment, no production data to preserve). The migration path:

1. Change `SCHEMA_VERSION` constant from `17` to `18`
2. Rename the SQL constant from `SCHEMA_V17` to `SCHEMA_V18`
3. Add `auto_approve` and `isolated_worktree` columns to the `tasks` table DDL
4. Add the new `task_attachments` table DDL
5. Update the drop list in the migration block to include `task_attachments`
6. Update `conn.execute_batch(SCHEMA_V17)` call to use `SCHEMA_V18`
7. Update schema tests to assert new columns and table exist

**tasks table additions:**
```sql
auto_approve INTEGER NOT NULL DEFAULT 0,
isolated_worktree INTEGER NOT NULL DEFAULT 1,
```
SQLite stores booleans as INTEGER (0/1). Rust side uses `bool` with rusqlite's automatic conversion.

**task_attachments table:**
```sql
CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(task_id);
```

**Drop order for migration block:** `task_attachments` must be dropped before `tasks` (FK dependency):
```sql
DROP TABLE IF EXISTS task_attachments;
DROP TABLE IF EXISTS session_aliases;
-- ... rest of existing drops ...
DROP TABLE IF EXISTS tasks;
```

### Task Struct Pattern (DATA-01)
[VERIFIED: inspection of `src-tauri/src/models/task.rs`]

The `Task` struct uses `#[specta(export)]` and `#[derive(Type)]` for TypeScript generation. Boolean fields serialize naturally with serde. The `TASK_SELECT` constant and column-indexed `from_row` method must both be updated.

Current column order (indices 0–19): id, project_id, title, description, status, priority, base_branch, archived_at, external_id, is_imported, import_source, skills, model_override, mcp_allowlist, skills_override, labels, external_url, external_updated_at, created_at, updated_at.

After adding `auto_approve` (index 20) and `isolated_worktree` (index 21):

```rust
// TASK_SELECT — add two columns at the end
pub const TASK_SELECT: &str =
    "SELECT id, project_id, title, description, status, priority, \
     base_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, labels, \
     external_url, external_updated_at, created_at, updated_at, \
     auto_approve, isolated_worktree FROM tasks";

// Task struct additions
pub auto_approve: bool,
pub isolated_worktree: bool,

// from_row additions
auto_approve: row.get::<_, bool>(20).unwrap_or(false),
isolated_worktree: row.get::<_, bool>(21).unwrap_or(true),
```

**Note:** rusqlite can read SQLite INTEGER 0/1 as `bool` via `row.get::<_, bool>(n)`. No special conversion needed.

### TaskAttachment Model (DATA-02)
[VERIFIED: pattern from existing TaskRelationship/TaskInstruction in models/task.rs]

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskAttachment {
    pub id: i32,
    pub task_id: i32,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,
    pub created_at: String,
}
```

Add to `models/mod.rs` re-exports and to `lib.rs` `pub use models::...` line.

### Attachment IPC Pattern (DATA-03)
[VERIFIED: pattern from task_handlers.rs, task_relationships CRUD]

All three handlers are synchronous (`fn`, not `async fn`) since they only touch the DB mutex — no async I/O needed. Pattern:

```rust
#[tauri::command]
#[specta::specta]
pub fn get_task_attachments(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<TaskAttachment>, String> { ... }

#[tauri::command]
#[specta::specta]
pub fn add_task_attachment(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    filename: String,
    file_path: String,
    file_size: i64,
) -> Result<TaskAttachment, String> { ... }

#[tauri::command]
#[specta::specta]
pub fn remove_task_attachment(
    app_state: State<Arc<AppState>>,
    attachment_id: i32,
) -> Result<(), String> { ... }
```

**File-to-handler placement:** These can live in `task_handlers.rs` (keeping attachment logic with tasks) or in a new `attachment_handlers.rs`. Given CLAUDE.md preference "implement in existing files unless it is a new logical component," they fit naturally in `task_handlers.rs`.

### interrupt_task Pattern (DATA-04)
[VERIFIED: inspection of AcpProcess.task_id field, cancel_acp_session, close_pty_session, get_active_sessions patterns]

`interrupt_task` is `async fn` because it must `.lock().await` on tokio Mutexes (`app_state.acp.sessions`, `app_state.pty.session_meta`). The session lookup is by `task_id` field stored on `AcpProcess` and `PtySessionMeta`.

**Session discovery pattern:**
```rust
// ACP: scan acp.sessions for task_id match
let acp_log_id: Option<i32> = {
    let sessions = app_state.acp.sessions.lock().await;
    sessions.iter()
        .find(|(_, proc)| proc.task_id == Some(task_id))
        .map(|(key, _)| *key)
};

// PTY: scan pty.session_meta for task_id match
let pty_log_id: Option<i32> = {
    let meta = app_state.pty.session_meta.lock().await;
    meta.iter()
        .find(|(_, m)| m.task_id == Some(task_id))
        .map(|(key, _)| *key)
};
```

**Stop session:** Once a `log_id` is found, the handler should:
- For ACP: send CancelRequest (best-effort) and drop the session from `acp.sessions` — same as `cancel_acp_session`. No need to call `cancel_acp_session` as an IPC command; replicate its core logic directly.
- For PTY: set the attach cancel flag, remove from `pty.sessions`, `pty.session_meta`, `ssh.pty_sessions` — same as `close_pty_session`.

**Status update:** After stopping the session (or if no session found → return early with error):
```rust
let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
let now = Utc::now().to_rfc3339();
conn.execute(
    "UPDATE tasks SET status = 'Backlog', updated_at = ? WHERE id = ?",
    rusqlite::params![&now, task_id],
).map_err(|e| e.to_string())?;
app_state.app_handle.emit("tasks-changed", ()).ok();
app_state.app_handle.emit("sessions-changed", ()).ok();
```

**Error case:** If neither ACP nor PTY has a session for `task_id`, return `Err("No active session for task {task_id}".to_string())`. This surfaces to the UI per the locked decision.

**Important:** The DB mutex (sync `std::sync::Mutex`) must not be held across `.await` points — lock it, do the update, then drop before any further async work. The pattern used in `drain_ready_queue` (load settings in a block, then async lock) is the template to follow.

### TypeScript Binding Regeneration
[VERIFIED: inspection of lib.rs test `generate_typescript_bindings`]

`pnpm tauri:gen` runs `cargo test generate_typescript_bindings` which calls `create_builder().export(...)`. All new commands must be in `collect_commands![...]` and all new exported types must derive `Type` + `#[specta(export)]`. The test writes to `src/types/bindings.ts`.

New commands to add to `collect_commands!` in `lib.rs`:
```rust
crate::ipc::get_task_attachments,
crate::ipc::add_task_attachment,
crate::ipc::remove_task_attachment,
crate::ipc::interrupt_task,
```

### Frontend Service Hook Pattern (DATA-03, DATA-04)
[VERIFIED: direct inspection of `src/services/task.service.ts`]

The `task.service.ts` file uses a single `taskQueryKeys` factory object at the top, then exports named hooks. The `api` object from `@/lib/tauri-utils` is a proxy over `commands` from `@/types/bindings` that auto-unwraps `Result<T, string>` to `Promise<T>` (throwing on error). The hooks call `api.<camelCasedCommandName>()`.

**Four hooks to add to `task.service.ts`:**

1. **Query key addition** — add `attachments` key to `taskQueryKeys`:

```typescript
attachments: (taskId: number) => [...taskQueryKeys.base, "attachments", taskId] as const,
```

2. **`useTaskAttachmentsQuery`** — read operation, uses `useQuery`:

```typescript
export function useTaskAttachmentsQuery(taskId: number | null) {
  return useQuery<TaskAttachment[]>({
    queryKey: taskQueryKeys.attachments(taskId!),
    queryFn: () => api.getTaskAttachments(taskId!),
    enabled: taskId !== null,
  });
}
```

3. **`useAddTaskAttachmentMutation`** — write, uses `useMutation`; invalidates `attachments` key on success:

```typescript
export function useAddTaskAttachmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      filename,
      filePath,
      fileSize,
    }: {
      taskId: number;
      filename: string;
      filePath: string;
      fileSize: number;
    }) => api.addTaskAttachment(taskId, filename, filePath, fileSize),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.attachments(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to add attachment"),
  });
}
```

4. **`useRemoveTaskAttachmentMutation`** — write, uses `useMutation`; invalidates `attachments` key on success:

```typescript
export function useRemoveTaskAttachmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ attachmentId }: { attachmentId: number; taskId: number }) =>
      api.removeTaskAttachment(attachmentId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.attachments(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to remove attachment"),
  });
}
```

5. **`useInterruptTaskMutation`** — write, uses `useMutation`; invalidates task lists on success (task status changes):

```typescript
export function useInterruptTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.interruptTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to interrupt task"),
  });
}
```

**Naming convention confirmed:**
- IPC command `get_task_attachments` → `api.getTaskAttachments` → hook `useTaskAttachmentsQuery`
- IPC command `add_task_attachment` → `api.addTaskAttachment` → hook `useAddTaskAttachmentMutation`
- IPC command `remove_task_attachment` → `api.removeTaskAttachment` → hook `useRemoveTaskAttachmentMutation`
- IPC command `interrupt_task` → `api.interruptTask` → hook `useInterruptTaskMutation`

**Import additions required in `task.service.ts`:**
- Add `TaskAttachment` to the import from `@/types/bindings` (after `pnpm tauri:gen` adds the type)

**`fileSize` type in the TS hook:** The Rust parameter is `file_size: i64` which specta exports as `number` in TypeScript. Use `number` in the TypeScript hook signature.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQLite boolean storage | Custom serializer | rusqlite native `bool` type | rusqlite already maps INTEGER 0/1 ↔ bool |
| JSON serialization | Manual string building | `serde_json::to_string` | Pattern used throughout (skills, labels fields) |
| Timestamp generation | Manual formatting | `chrono::Utc::now().to_rfc3339()` | Consistent with all other `created_at`/`updated_at` fields |
| ACP session teardown | Custom cleanup | Mirror `cancel_acp_session` logic | Connection server teardown logic is subtle |
| IPC Result unwrapping | Manual try/catch | `api` proxy from `tauri-utils.ts` | The proxy auto-unwraps `Result<T, string>` for all commands |

## Common Pitfalls

### Pitfall 1: Schema Version Already At V17
**What goes wrong:** Writing a "V17" migration when `SCHEMA_VERSION` is already `17` causes the `if current_version < SCHEMA_VERSION` guard to be false — no migration runs, new columns and table never created.
**Why it happens:** The STATE.md blocker flagged this risk; research confirmed V17 is already deployed.
**How to avoid:** Change `SCHEMA_VERSION` to `18`, rename the SQL constant to `SCHEMA_V18`, update all references.
**Warning signs:** `cargo test test_schema_initialization` passes but assertions for new columns fail.

### Pitfall 2: DB Mutex Held Across Await
**What goes wrong:** Holding `app_state.db.lock()` (sync Mutex) across an `.await` point causes a deadlock or panic in debug builds.
**Why it happens:** `interrupt_task` needs both tokio async locks (ACP/PTY sessions) and the sync DB mutex.
**How to avoid:** Acquire async locks first in their own scopes, resolve session keys, then acquire and release the DB mutex synchronously before any further async work. The `drain_ready_queue` pattern (loading settings in a block) is the template.
**Warning signs:** Compile warning about `MutexGuard` held across await; runtime deadlock.

### Pitfall 3: TASK_SELECT Column Index Mismatch
**What goes wrong:** Adding `auto_approve, isolated_worktree` to the DDL but not to `TASK_SELECT`, or adding them to `TASK_SELECT` but using wrong indices in `from_row`, causes runtime query errors or silently wrong values.
**Why it happens:** `from_row` uses positional indices (0, 1, 2...) that must exactly match the SELECT order.
**How to avoid:** Update `TASK_SELECT`, count indices carefully (current last is 19 for `updated_at`; new ones are 20 and 21), update `from_row` comment listing column order.
**Warning signs:** `cargo test` passes but returned tasks have `auto_approve=true` incorrectly (default was swapped).

### Pitfall 4: task_attachments Drop Order in Migration
**What goes wrong:** Dropping `tasks` before `task_attachments` in the migration block fails with FK constraint violation even with `PRAGMA foreign_keys = ON` inside the batch.
**Why it happens:** The destructive migration drops tables in order; `task_attachments` references `tasks`.
**How to avoid:** Add `DROP TABLE IF EXISTS task_attachments;` as the **first** drop in the migration batch, before `session_aliases`.
**Warning signs:** `cargo test test_schema_initialization` fails with "foreign key constraint" or SQLite "table has foreign key references" error.

### Pitfall 5: interrupt_task Missing Session Returns Wrong Error Shape
**What goes wrong:** Returning a generic Rust error that doesn't surface cleanly to the frontend.
**Why it happens:** All IPC commands return `Result<T, String>` — the error string is what the frontend receives.
**How to avoid:** Return a specific, user-readable message: `"No active session for task {task_id}"`.

### Pitfall 6: `file_size` Type Mismatch
**What goes wrong:** Using `i32` for `file_size` in the IPC command signature truncates files > 2 GB.
**Why it happens:** i32 max is ~2.1 GB.
**How to avoid:** Use `i64` for `file_size` in both the Rust struct and the IPC command parameter.

### Pitfall 7: Service Hook Import Missing TaskAttachment
**What goes wrong:** `useTaskAttachmentsQuery` fails TypeScript compilation because `TaskAttachment` is not imported in `task.service.ts`.
**Why it happens:** The type is generated by `pnpm tauri:gen` and must be added to the import from `@/types/bindings`.
**How to avoid:** In Plan 2, after `pnpm tauri:gen` generates `TaskAttachment` in bindings.ts, add it to the import line at the top of `task.service.ts`. Do not add the import in Plan 1 (the type doesn't exist yet).

## Code Examples

### Schema V18 tasks table columns to add
[VERIFIED: existing schema pattern in schema.rs]
```sql
-- Add inside tasks CREATE TABLE after labels TEXT DEFAULT '[]':
auto_approve INTEGER NOT NULL DEFAULT 0,
isolated_worktree INTEGER NOT NULL DEFAULT 1,
```

### Schema V18 task_attachments table
[VERIFIED: pattern from task_reviews table with CASCADE FK]
```sql
CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(task_id);
```

### from_row bool extraction (rusqlite)
[VERIFIED: rusqlite bool support — `row.get::<_, bool>(n)` reads INTEGER 0/1]
```rust
auto_approve: row.get::<_, bool>(20).unwrap_or(false),
isolated_worktree: row.get::<_, bool>(21).unwrap_or(true),
```

### interrupt_task ACP session search
[VERIFIED: AcpProcess.task_id field confirmed in manager.rs line 196; cancel_acp_session pattern in acp_handlers.rs line 426]
```rust
pub async fn interrupt_task(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    // Search ACP sessions
    let acp_log_id: Option<i32> = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.iter()
            .find(|(_, proc)| proc.task_id == Some(task_id))
            .map(|(key, _)| *key)
    };

    // Search PTY sessions
    let pty_log_id: Option<i32> = {
        let meta = app_state.pty.session_meta.lock().await;
        meta.iter()
            .find(|(_, m)| m.task_id == Some(task_id))
            .map(|(key, _)| *key)
    };

    if acp_log_id.is_none() && pty_log_id.is_none() {
        return Err(format!("No active session for task {}", task_id));
    }

    // Stop ACP session (mirror cancel_acp_session)
    if let Some(log_id) = acp_log_id {
        // ... cancel logic ...
    }

    // Stop PTY session (mirror close_pty_session)
    if let Some(log_id) = pty_log_id {
        // ... close logic ...
    }

    // Update task status — sync DB lock AFTER all async work is done
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "UPDATE tasks SET status = 'Backlog', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        ).map_err(|e| e.to_string())?;
    }
    app_state.app_handle.emit("tasks-changed", ()).ok();
    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}
```

### Frontend service hook — useTaskAttachmentsQuery
[VERIFIED: pattern from useTaskRelationshipsQuery in task.service.ts]
```typescript
export function useTaskAttachmentsQuery(taskId: number | null) {
  return useQuery<TaskAttachment[]>({
    queryKey: taskQueryKeys.attachments(taskId!),
    queryFn: () => api.getTaskAttachments(taskId!),
    enabled: taskId !== null,
  });
}
```

### Frontend service hook — useInterruptTaskMutation
[VERIFIED: pattern from useArchiveTaskMutation in task.service.ts]
```typescript
export function useInterruptTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.interruptTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to interrupt task"),
  });
}
```

## State of the Art

| Old | Current | Notes |
|-----|---------|-------|
| Schema V17 | Schema V18 (this phase) | V17 was used by Phase 56 rename commit |
| Task has no auto_approve/isolated_worktree | Task has both (this phase) | Defaults match existing agent behavior |
| No attachment storage | task_attachments table (this phase) | Files stored by path; DB stores metadata only |
| No interrupt IPC | interrupt_task IPC (this phase) | Stops active session and returns task to Backlog |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | rusqlite's `row.get::<_, bool>(n)` correctly reads SQLite INTEGER 0/1 as Rust bool | Code Examples | If wrong, use `row.get::<_, i32>(n).map(\|v\| v != 0)` instead |
| A2 | The `interrupt_task` command should also handle SSH PTY sessions (via `app_state.ssh.pty_sessions`) | interrupt_task Pattern | If SSH PTY sessions are in scope, add a third search block over `ssh.pty_sessions` |
| A3 | specta exports `i64` as TypeScript `number` (not `bigint`) | Frontend Service Hooks | If specta uses `bigint` for i64, fileSize type annotation in TS hook must change |

**A2 note:** The existing `close_pty_session` handler removes from `app_state.ssh.pty_sessions.lock().await.remove(&session_key)`. If SSH PTY sessions can be associated with tasks (they can — `spawn_interactive_execution` stores task_id in `pty.session_meta` regardless of local/SSH path), then `interrupt_task` should also check `app_state.ssh.pty_sessions` by matching via the `pty.session_meta` map (which is keyed by the same `log_id`). The session_meta lookup covers both.

## Open Questions

1. **Where should attachment handlers live?**
   - What we know: CLAUDE.md says "Implement functionality in existing files unless it is a new logical component"
   - What's unclear: Attachments could be a new component (`attachment_handlers.rs`) or co-located with task CRUD in `task_handlers.rs`
   - Recommendation: Add to `task_handlers.rs` — attachments are pure task CRUD, not a distinct domain

2. **Does interrupt_task need to handle SSH PTY sessions separately from local PTY?**
   - What we know: `spawn_interactive_execution` puts session metadata in `app_state.pty.session_meta` for both local and SSH sessions; the `log_id` is the same key used in both `ssh.pty_sessions` and `pty.sessions`
   - What's unclear: Whether the cleanup for SSH PTY sessions (drop `SshPtyHandle`) needs to be explicit or if session_meta removal is sufficient
   - Recommendation: Mirror `close_pty_session` exactly — it handles both cases (removes from `pty.sessions` AND `ssh.pty_sessions`) using the same `session_key`

3. **Should `useInterruptTaskMutation` also invalidate `sessions` query keys?**
   - What we know: The Rust handler emits both `"tasks-changed"` and `"sessions-changed"` events; `useTasksQuery` already listens to `"tasks-changed"` via event listener
   - What's unclear: Whether Phase 62 will also need a sessions query to be invalidated
   - Recommendation: Invalidate `taskQueryKeys.lists()` only in the service hook (task list is the primary consumer); the event listener in `useTasksQuery` covers re-fetch automatically. Sessions query invalidation can be added when Phase 62 needs it.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in test (`#[test]`) + Vitest (frontend) |
| Config file | None for Rust — uses `cargo test` |
| Quick run command | `cd src-tauri && cargo test` |
| Full suite command | `cd src-tauri && cargo test && pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | Task struct has auto_approve and isolated_worktree | unit | `cd src-tauri && cargo test test_schema_initialization` | ✅ `db/schema.rs` |
| DATA-02 | task_attachments table created with CASCADE | unit | `cd src-tauri && cargo test test_schema_initialization` | ✅ `db/schema.rs` |
| DATA-03 | Attachment CRUD round-trips | unit | `cd src-tauri && cargo test attachment` | ❌ Wave 0 |
| DATA-04 | interrupt_task stops session and sets status Backlog | unit | `cd src-tauri && cargo test interrupt` | ❌ Wave 0 |

### Wave 0 Gaps
- [ ] `src-tauri/src/ipc/task_handlers.rs` — add tests for `get_task_attachments`, `add_task_attachment`, `remove_task_attachment` round-trip using in-memory DB
- [ ] `src-tauri/src/ipc/task_handlers.rs` — add `interrupt_task` test for no-session error case (in-memory DB, no ACP/PTY sessions active)

## Environment Availability

Step 2.6: SKIPPED — no external dependencies beyond the existing Cargo workspace. All needed tools (`cargo`, `pnpm`) are already confirmed available from prior phases.

## Security Domain

This phase adds file path storage and a new IPC command. No authentication, cryptography, or network I/O is involved.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | `file_size: i64` must be non-negative; `filename` not empty |
| V4 Access Control | no | No per-user access control; project isolation at project_id level |
| V6 Cryptography | no | Files stored by path, no encryption in scope |

**Threat pattern:** `file_path` stored in DB should be validated to be within the project's `.maestro/attachments/` directory to prevent path traversal when the path is later used by the frontend for display or the backend for file operations. The Phase 62 implementation will handle actual file upload/download; Phase 57 only stores metadata — but validating the path at insert time is good hygiene.

## Project Constraints (from CLAUDE.md)

- **No logging:** No `tracing::` or `log::` calls — debug via IPC return values or frontend console
- **Error propagation:** Never `unwrap()` in IPC handlers; use `?` or explicit error handling; never `let _ =` on fallible operations silently
- **File organization:** New handlers in existing `task_handlers.rs` (not a new file), per "prefer implementing functionality in existing files"
- **Naming:** snake_case for Rust functions/variables; `auto_approve` and `isolated_worktree` match this convention
- **New modules:** Prefer flat files if needed; existing `ipc/mod.rs` is legacy — don't add new `mod.rs` files
- **`pnpm tauri:gen`:** Must be run after adding new exported types or commands to regenerate `src/types/bindings.ts`
- **Schema migration:** Destructive (no data preservation) — matches V16→V17 and all prior migrations
- **Frontend:** TanStack Query for all IPC — no direct `invoke()` calls in components; hooks in service files only

## Sources

### Primary (HIGH confidence)
- Direct inspection: `src-tauri/src/db/schema.rs` — schema version (V17 confirmed), migration pattern, DDL
- Direct inspection: `src-tauri/src/models/task.rs` — Task struct, TASK_SELECT constant (20 columns), from_row
- Direct inspection: `src-tauri/src/ipc/task_handlers.rs` — IPC command pattern, sync vs async
- Direct inspection: `src-tauri/src/ipc/acp_handlers.rs` — cancel_acp_session, interrupt_acp_turn, get_active_sessions patterns
- Direct inspection: `src-tauri/src/acp/manager.rs` — AcpProcess.task_id field (line 196)
- Direct inspection: `src-tauri/src/db/connection.rs` — AppState structure, AcpState, PtyState
- Direct inspection: `src-tauri/src/lib.rs` — collect_commands! registration pattern, generate_typescript_bindings test
- Direct inspection: `src/services/task.service.ts` — all existing hooks, `taskQueryKeys` factory, `api` usage, `createErrorToastHandler` pattern
- Direct inspection: `src/utils/helpers/tauri-utils.ts` — `api` proxy implementation, Result unwrapping
- Direct git log: `git log --oneline -- src-tauri/src/db/schema.rs` — confirmed V17 in commit f99ea83 (2026-05-24)

## Metadata

**Confidence breakdown:**
- Schema migration (V18): HIGH — code inspected directly; V17 confirmed by git log
- Task struct changes: HIGH — TASK_SELECT and from_row pattern fully understood
- Attachment CRUD: HIGH — exact pattern from task_relationships and task_instructions CRUD
- interrupt_task session lookup: HIGH — AcpProcess.task_id and PtySessionMeta.task_id confirmed
- TypeScript binding generation: HIGH — lib.rs test and pattern fully understood
- Frontend service hooks: HIGH — task.service.ts fully read; naming conventions verified against 10+ existing hooks

**Research date:** 2026-05-26
**Valid until:** 2026-06-25 (stable codebase, internal patterns)
