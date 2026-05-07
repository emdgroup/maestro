# Simplify: Code Review Fixes

## Context

Large changeset (~3200 lines across 41 files) adding ACP modes support, pre-initialize protocol, shared project servers, and frontend working-files/review-changes panels. Three review agents identified duplicated logic, parameter sprawl, and unnecessary re-renders.

## Fixes to Apply

### 1. Merge duplicate `useMemo` iterations (AgentActivityPanel)

**File:** `src/components/execution/AgentActivityPanel.tsx` lines 130-159

Two separate `useMemo` blocks iterate all `liveState.items` for the same filter. Merge into single pass:

```typescript
const { workingFiles, sessionChangedFiles } = useMemo(() => {
  const working = new Set<string>();
  const changed = new Set<string>();
  for (const item of liveState.items) {
    if (item.type !== "toolCall") continue;
    for (const c of item.item.content) {
      if (c.type === "diff") {
        changed.add(c.path);
        if (isWorkingFile(c.path)) working.add(c.path);
      }
    }
  }
  return { workingFiles: [...working], sessionChangedFiles: [...changed] };
}, [liveState.items]);
```

Remove the two separate `useEffect` + ref patterns for calling parent callbacks. Replace with single effect on the combined result.

---

### 2. Add shallow equality guard in AgentMonitor Map updaters

**File:** `src/components/execution/AgentMonitor.tsx` lines 75-89

Both `handleWorkingFilesChange` and `handleSessionChangedFilesChange` create new Map on every call even when data hasn't changed. Add equality check:

```typescript
const handleWorkingFilesChange = useCallback((sessionKey: number, files: string[]) => {
  setSessionWorkingFiles((prev) => {
    const existing = prev.get(sessionKey);
    if (existing && existing.length === files.length && existing.every((f, i) => f === files[i])) return prev;
    const next = new Map(prev);
    next.set(sessionKey, files);
    return next;
  });
}, []);
```

Same pattern for `handleSessionChangedFilesChange`.

---

### 3. Extract `upsert_session_alias` helper (manager.rs)

**File:** `src-tauri/src/acp/manager.rs`

Same SQL INSERT appears at lines ~573, ~631, ~966. Extract to:

```rust
pub(crate) fn upsert_session_alias(
    conn: &rusqlite::Connection,
    project_id: i32,
    agent_id: &str,
    acp_session_id: &str,
    display_name: &str,
) {
    let _ = conn.execute(
        "INSERT INTO session_aliases (project_id, agent_id, acp_session_id, display_name) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(project_id, agent_id, acp_session_id) DO UPDATE SET display_name = excluded.display_name",
        rusqlite::params![project_id, agent_id, acp_session_id, display_name],
    );
}
```

Call from all 3 reader task sites + `rename_acp_session` in `acp_handlers.rs`.

---

### 4. Extract cache-update helper for SpawnOk/SessionLoadOk (manager.rs)

**File:** `src-tauri/src/acp/manager.rs` lines 709-762

Same "if models → update cache + emit; if modes → update cache + emit; if caps → update cache + emit" pattern repeated for SpawnOk and SessionLoadOk. Extract:

```rust
fn apply_capabilities_to_caches(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    caps: Option<&PromptCapabilitiesInfo>,
    models_cache: &std::sync::Mutex<Option<SessionModelState>>,
    modes_cache: &std::sync::Mutex<Option<SessionModeState>>,
    capabilities_cache: &std::sync::Mutex<Option<PromptCapabilitiesInfo>>,
    app_handle: &tauri::AppHandle,
    log_id: i32,
) { ... }
```

---

### 5. Introduce `ReaderTaskContext` struct to reduce 16-param functions

**File:** `src-tauri/src/acp/manager.rs` lines 538-555 and 594-611

Bundle the shared Arc params into a struct:

```rust
struct ReaderTaskContext {
    log_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<AppState>,
    models_cache: Arc<std::sync::Mutex<Option<SessionModelState>>>,
    modes_cache: Arc<std::sync::Mutex<Option<SessionModeState>>>,
    capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
    replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    session_name: Option<String>,
    agent_id: String,
    project_id: Option<i32>,
}
```

Both `spawn_reader_task` and `spawn_remote_reader_task` take `(source, cancel_rx, ctx: ReaderTaskContext)`.

---

## Skipped (acceptable)

- **ACP builder chain 3x duplication** in session_handler.rs — documented separately in `.claude/plans/acp-builder-dedup.md` for later.
- **Stringly-typed `"session-"` prefix** — architectural concern, not a simplify fix.
- **AgentsView always-mounted** — intentional design (comment documents reasoning).
- **agent_cache never cleaned** — tiny memory per entry, low urgency.
- **ConnectionHandlers pub fields** — crate-internal type, acceptable.

## Verification

1. `cargo check` in `src-tauri/` — no compile errors
2. `cargo test` in `src-tauri/` — all pass
3. `pnpm lint` — no new warnings
4. `pnpm test` — frontend tests pass
5. Manual: spawn ACP session, verify models/modes/capabilities still show, rename session alias persists
