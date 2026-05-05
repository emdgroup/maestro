# Architecture & Code Quality Improvement Plans

Two separate improvement plans: Frontend and Backend. Each item includes the problem, solution, and affected files.

---

## Plan A: Frontend (React + TypeScript + Zustand)

### Context

Frontend mixes server-state management patterns (React Query + Zustand holding same data), has inconsistent error handling across services, and leaks business logic into presentational components. These create drift bugs, re-render waste, and maintenance burden.

---

### 1. Eliminate dual source of truth for tasks

**Problem:** `KanbanBoard` fetches tasks via `useTasksQuery` then copies into Zustand boardStore via `loadTasks`. Two caches hold same data — can drift.

**Solution:** Remove task data from boardStore entirely. Components read tasks from React Query only. boardStore keeps UI-only state (selected task, terminal visibility, etc.).

**Files:**
- `src/store/boardStore.ts` — remove `tasks`, `loadTasks`, `getTasks`, `getTasksByStatus`
- `src/components/kanban/KanbanBoard.tsx` — stop calling `loadTasks`, derive column data from query result directly
- Any consumer of `useBoardStore(s => s.tasks)` — switch to `useTasksQuery`

---

### 2. Remove dead code from boardStore

**Problem:** `executeTask`, `pauseExecution`, `resumeExecution` methods throw errors with "removed" messages. Interface still declares them.

**Solution:** Delete zombie methods and their interface declarations.

**Files:**
- `src/store/boardStore.ts` — remove methods + interface entries

---

### 3. Extract business logic from TaskCard

**Problem:** `TaskCard.handleExecute` (lines 49-88) queries worktrees, conditionally creates them, spawns executions, updates store — 40 lines of orchestration in a UI component.

**Solution:** Extract to `useExecuteTask` hook in `src/utils/hooks/`. Component calls hook, hook handles orchestration.

**Files:**
- `src/components/kanban/TaskCard.tsx` — replace inline logic with hook call
- `src/utils/hooks/useExecuteTask.ts` (new) — orchestration logic lives here

---

### 4. Consistent error handling across all services

**Problem:** `task.service.ts` uses `createErrorToastHandler` consistently. `connection.service.ts` and `execution.service.ts` use inline lambdas with inconsistent message formatting.

**Solution:** All mutation `onError` callbacks use `createErrorToastHandler(actionName)`.

**Files:**
- `src/services/connection.service.ts` — replace inline error handlers
- `src/services/execution.service.ts` — replace inline error handlers
- `src/services/worktree.service.ts` — audit and fix

---

### 5. Fix hardcoded query key

**Problem:** `useArchiveTaskMutation` (task.service.ts:224) uses `["tasks", "list"]` instead of `taskQueryKeys.lists()`.

**Solution:** Replace with factory call.

**Files:**
- `src/services/task.service.ts` — one-line fix

---

### 6. Fix sessionActivityStore re-render issue

**Problem:** Uses `Map` without immer. Any `Map.set()` call triggers full re-render for all subscribers because reference never changes (Map mutated in place) OR requires manual `new Map()` clone.

**Solution:** Either wrap with immer (which handles Map natively) or switch to plain object `Record<string, Status>`.

**Files:**
- `src/store/sessionActivityStore.ts` — restructure state

---

### 7. Standardize store patterns

**Problem:** Mixed patterns — some stores use immer, some don't. `projectStore` uses nested `actions` object, others use flat methods.

**Solution:** All stores use immer + flat method pattern. Export fine-grained selector hooks (like `navigationStore` does).

**Files:**
- `src/store/projectStore.ts` — add immer, flatten, add selector hooks
- `src/store/sessionActivityStore.ts` — add immer
- `src/store/configStore.ts` — remove duplicate `resetConfig`/`clearConfig`

---

### Verification (Frontend)

```bash
pnpm test              # All unit tests pass
pnpm lint              # No new lint errors
pnpm tauri:dev         # Manual: Kanban board loads, tasks render, execute flow works
```

---

---

## Plan B: Backend (Rust + Tauri + SQLite)

### Context

Rust backend has a god-object `AppState`, no structured error types (frontend string-matches), massive duplicated ACP RPC boilerplate, and 1000+ line files that mix concerns. Testing covers protocol serialization but not handler logic.

---

### 1. Split AppState into focused sub-states

**Problem:** `AppState` (db/connection.rs) holds 10+ fields behind various Mutex types — DB, SSH, PTY, ACP, caches, locks, counters. Hard to test, hard to reason about lock ordering.

**Solution:** Extract into domain structs:
- `DbState` — `Mutex<Connection>`
- `SshState` — sessions, passwords
- `AcpState` — sessions, discovery cache, models
- `PtyState` — sessions, metadata, counter

`AppState` becomes a thin wrapper holding `Arc<DbState>`, `Arc<SshState>`, etc. Handlers destructure what they need.

**Files:**
- `src-tauri/src/db/connection.rs` — split AppState, keep `init_db`
- `src-tauri/src/acp/manager.rs` — accept `AcpState` instead of full `AppState`
- `src-tauri/src/ipc/*.rs` — update State extraction in handlers
- `src-tauri/src/lib.rs` — wire new sub-states into Tauri managed state

---

### 2. Structured error types (thiserror)

**Problem:** All handlers return `Result<T, String>`. Frontend string-matches `"PROJECT_LOCKED:"`. No error codes, lost context, no programmatic handling.

**Solution:**
- Define `MaestroError` enum with `thiserror` (variants: `DbError`, `ProjectLocked { id }`, `NotFound`, `SshError`, `AcpError`, `Validation { field, message }`, etc.)
- Internal code uses `MaestroError` with `?` propagation
- Convert to `String` at IPC boundary via `impl From<MaestroError> for String`
- Optionally: export error enum via specta for typed frontend matching (phase 2)

**Files:**
- `src-tauri/src/error.rs` (new) — define `MaestroError` enum
- `src-tauri/src/ipc/*.rs` — replace `.map_err(|e| format!(...))` with typed variants
- `src-tauri/src/db/connection.rs` — `From<rusqlite::Error> for MaestroError`

---

### 3. Deduplicate ACP one-shot RPC pattern

**Problem:** `acp_handlers.rs` has 6 nearly-identical functions that spawn maestro-server, send one request, read one response, shut down. ~200 lines repeated per variant (local + remote × 3 operations).

**Solution:** Extract generic helper:
```rust
async fn one_shot_rpc<R: DeserializeOwned>(
    app_state: &AppState,
    connection_id: Option<i32>,
    request: ServerRequest,
) -> Result<R, String>
```

Each handler becomes a 5-line wrapper calling `one_shot_rpc` with its specific request variant.

**Files:**
- `src-tauri/src/acp/manager.rs` or new `src-tauri/src/acp/rpc.rs` — generic helper
- `src-tauri/src/ipc/acp_handlers.rs` — replace 6 duplicated functions

---

### 4. Break up monolith files

**Problem:**
- `maestro-server/src/main.rs` — 1,875 lines
- `src-tauri/src/ipc/acp_handlers.rs` — 1,628 lines
- `src-tauri/src/ssh/session.rs` — 1,129 lines

**Solution:** Extract helper functions into sibling files (flat, not nested modules):

- `maestro-server/src/main.rs` → extract `session.rs` (spawn/load ACP client), `file_ops.rs` (search/read), `terminal.rs` (PTY management)
- `acp_handlers.rs` → after dedup (#3), remaining code split into `acp_spawn.rs` and `acp_query.rs`
- `ssh/session.rs` → extract `ssh/auth.rs` (authentication flows), `ssh/channel.rs` (channel management)

**Files:** Listed above. Keep `mod.rs` files for existing module directories.

---

### 5. Protocol versioning

**Problem:** No version negotiation between Tauri and maestro-server. Incompatible protocol changes = silent failures or crashes.

**Solution:** Add `Handshake` as first message after connection:
```rust
ServerRequest::Handshake { protocol_version: u32 }
ServerResponse::HandshakeOk { protocol_version: u32 }
```

If versions mismatch, server responds with `Error` and exits. Tauri surfaces "maestro-server version mismatch" to user.

**Files:**
- `maestro-protocol/src/lib.rs` — add Handshake variants, version constant
- `maestro-server/src/main.rs` — check version on startup
- `src-tauri/src/acp/manager.rs` — send handshake after spawn

---

### 6. Connection pooling or spawn_blocking for DB

**Problem:** `std::sync::Mutex<Connection>` blocks tokio runtime thread during long queries. Under load, entire async runtime stalls.

**Solution (option A — simpler):** Wrap all DB access in `tokio::task::spawn_blocking`:
```rust
let result = tokio::task::spawn_blocking(move || {
    let conn = db_state.conn.lock().unwrap();
    // query
}).await.map_err(|e| e.to_string())?;
```

**Solution (option B — more robust):** Use `r2d2` connection pool with `rusqlite`. Multiple concurrent readers (WAL allows this), single writer.

**Files:**
- `src-tauri/src/db/connection.rs` — either add `spawn_blocking` wrapper fn or replace Mutex with pool
- `src-tauri/src/ipc/*.rs` — update call sites

---

### 7. Rename `websocket/` module

**Problem:** Module does SSH PTY forwarding. Not WebSockets. Confusing.

**Solution:** Rename to `streaming/` or `pty_bridge/`.

**Files:**
- `src-tauri/src/websocket/` → `src-tauri/src/streaming/`
- `src-tauri/src/lib.rs` — update `mod` declaration
- All internal imports referencing `crate::websocket`

---

### 8. Add IPC handler tests

**Problem:** Protocol serialization tested well. Handler logic (largest code mass) untested. No integration tests with real DB.

**Solution:** Add test module to each handler file using in-memory SQLite:
```rust
#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    // Create in-memory DB, run schema, test handler logic directly
}
```

Priority targets:
- `task_handlers.rs` — validation, status transitions
- `acp_handlers.rs` — session lifecycle (after dedup)
- `project_handlers.rs` — project locking behavior

**Files:**
- `src-tauri/src/ipc/task_handlers.rs` — add `#[cfg(test)] mod tests`
- `src-tauri/src/ipc/project_handlers.rs` — add tests
- `src-tauri/src/ipc/acp_handlers.rs` — add tests

---

### Verification (Backend)

```bash
cd src-tauri && cargo check    # Compiles clean
cd src-tauri && cargo test     # All tests pass (existing + new)
pnpm tauri:gen                 # Bindings regenerate without error
pnpm tauri:dev                 # Manual: full app flow works end-to-end
```

---

## Execution Order Recommendation

**Frontend:** 1 → 2 → 5 → 6 → 4 → 3 → 7 (start with easy wins, end with refactors)

**Backend:** 2 → 3 → 1 → 7 → 4 → 5 → 6 → 8 (error types first enable everything else, tests last to cover new code)

Plans are independent — can execute in parallel or interleave.
