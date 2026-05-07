# Plan: Persist session name to `session_aliases` on ACP session creation

## Context

When a user creates a new ACP session and specifies a name in the SpawnSessionDialog, the name is stored in-memory on `AcpProcess.session_name` but never written to the `session_aliases` SQLite table. The `acp_session_id` (the key for the alias table) isn't known at spawn time — it arrives asynchronously in a `SpawnOk` response from maestro-server. Consequence: when listing historical sessions from the agent, user's chosen name is lost.

## Approach

Handle alias persistence in the reader task immediately after `SpawnOk` arrives. The reader task already has `app_state: Arc<AppState>` (and thus DB access). No polling, no new sync primitives.

## Changes

### 1. Add `project_id` to `AcpProcess` — `src-tauri/src/acp/manager.rs`

```rust
pub struct AcpProcess {
    // ...existing fields...
    pub project_id: Option<i32>,  // new — needed to key session_aliases
}
```

### 2. Pass `project_id` through spawn functions — `src-tauri/src/acp/manager.rs`

Add `project_id: Option<i32>` param to `spawn_acp_process` (line 189) and `spawn_acp_process_remote` (line 291). Set on AcpProcess construction.

### 3. Change `handle_server_message` to return `Option<String>` — `src-tauri/src/acp/manager.rs`

Return the `acp_session_id` when `SpawnOk` provides one. All other arms return `None`.

### 4. Persist alias in reader tasks — `src-tauri/src/acp/manager.rs`

In both `spawn_reader_task` and `spawn_remote_reader_task`, add params: `session_name: Option<String>`, `agent_id: String`, `project_id: Option<i32>`.

After `handle_server_message` returns `Some(native_id)`:

```rust
if let (Some(pid), Some(ref name)) = (project_id, &session_name) {
    if let Ok(conn) = app_state.db.lock() {
        let _ = conn.execute(
            "INSERT INTO session_aliases (project_id, agent_id, acp_session_id, display_name)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, agent_id, acp_session_id) DO UPDATE SET display_name = excluded.display_name",
            rusqlite::params![pid, agent_id, native_id, name],
        );
    }
}
```

### 5. Update caller — `src-tauri/src/ipc/acp_handlers.rs`

Pass `Some(project_id)` to both `spawn_acp_process` and `spawn_acp_process_remote` calls in `spawn_acp_session`.

### 6. Thread params from spawn fns to reader tasks — `src-tauri/src/acp/manager.rs`

Clone `session_name` before moving into AcpProcess struct. Pass `session_name`, `agent_id.to_string()`, and `project_id` to reader task constructors.

## Files modified

- `src-tauri/src/acp/manager.rs` — struct field, fn signatures, reader task logic
- `src-tauri/src/ipc/acp_handlers.rs` — pass project_id

## Edge cases

- `SpawnOk` without `acp_session_id`: guarded by `if let Some`
- DB lock failure: silently skips, user can rename later
- Duplicate SpawnOk: `ON CONFLICT DO UPDATE` handles idempotency
- Auto-generated names: persisted same as user-specified (frontend always provides one)

## Verification

1. `cargo check` in `src-tauri/`
2. `cargo test` in `src-tauri/`
3. Manual: spawn ACP session with custom name → stop session → list historical sessions → verify name shows
