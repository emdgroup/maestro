# Code Reduction: Safe Rust Deduplication

## Context

Scanned codebase for duplication. Identified ~200 lines reducible via extracting shared helpers from copy-pasted logic blocks. UI component files kept (treeshaked). Only pursuing refactors where two functions are provably identical except for 2-3 parameters.

## Approach

- Preserve exact same behavior (same error messages, same response types)
- Verify with `cargo check` (workspace root) + `cargo test` (affected crate) after each
- Independent commits per refactor

---

## Refactor 1: manager.rs — Unify cold session launchers (~50 lines saved)

**File:** `src-tauri/src/acp/manager.rs` lines 577-699

**Problem:** `spawn_acp_session_cold` and `load_acp_session_cold` are 59-line copies. Only differences:
1. Initial message constructed (SpawnRequest vs SessionLoadRequest)
2. `AcpProcessParams.task` — real `TaskMetadata` vs `TaskMetadata::default()`
3. `AcpProcessParams.initial_acp_session_id` — `None` vs `Some(...)`
4. `AcpProcessParams.enable_replay_buffer` — `false` vs `true`
5. Error string for Remote ("SpawnRequest" vs "SessionLoad")

**Solution:** Extract shared body into private helper:

```rust
async fn launch_cold_session(
    target: TransportTarget<'_>,
    initial_msg: MaestroRpcMessage,
    remote_error_label: &str,
    params: AcpProcessParams,
    log_id: i32,
    req: &SessionRequest,
) -> Result<(), String> {
    // transport open + write (existing match body)
    // AcpProcess::create + insert + spawn_reader_task
}
```

Both callers become ~12 lines (build message + build params + call helper).

---

## Refactor 2: connection.rs — Extract one-shot ACP RPC helper (~45 lines saved)

**File:** `maestro-server/src/session/connection.rs` lines 35-165

**Problem:** `run_session_list` and `run_session_close` share 50+ identical lines:
- Spawn subprocess, take stdin/stdout, create transport (lines 42-47 = 116-121)
- Builder with `.name("maestro-server").on_receive_notification(noop).connect_with(...)` 
- Send `InitializeRequest`, handle init error

Only difference: the actual request sent after init + result type.

**Solution:** Extract helper that handles lifecycle up to post-init:

```rust
async fn one_shot_acp_request<T, F>(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(acp::ConnectionTo<acp::Agent>) -> Pin<Box<dyn Future<Output = Result<T, String>> + Send>> + Send + 'static,
    T: Send + 'static,
```

Both callers become thin wrappers passing only their specific request logic.

---

## Refactor 3: main.rs — Forward-command helper (~40 lines saved)

**File:** `maestro-server/src/main.rs` lines 367-455

**Problem:** Three handlers (SetModel, SetMode, SetConfigOption) are identical 28-line blocks:
1. Look up session by id → if not found, error "unknown session: {id}"
2. Send command via `cmd_tx` → if send fails, error "session {id} connection closed"

**Solution:** Extract helper:

```rust
async fn forward_to_session(
    sessions: &SessionMap,
    session_id: &str,
    cmd: SessionCommand,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> bool  // true = sent ok, false = error response already sent
```

Three match arms shrink to ~5 lines each (extract fields + call forward_to_session).

---

## Refactor 4: session_handlers.rs — Transport resolution (~35 lines saved)

**File:** `src-tauri/src/acp/session_handlers.rs`

**Problem:** Cold-path `match connection_key { Ssh => ..., Wsl => ..., Local => ... }` appears twice (spawn at lines 174-242, load at lines 338-389). WSL logic (distro lookup + cache/deploy fallback + cfg gate) is duplicated verbatim.

**Solution:** Extract:

```rust
async fn resolve_cold_transport<'a>(
    connection_key: ConnectionKey,
    app_state: &'a AppState,
) -> Result<TransportTarget<'a>, String>
```

Note: Lifetime challenge — `TransportTarget` borrows SSH session and path strings. May need to return an owned variant or store in a local. If lifetime ergonomics get ugly, skip this one.

---

## Execution Order

1. Refactor 1 (manager.rs) — cleanest, lowest risk, biggest savings
2. Refactor 3 (main.rs forward) — trivial extraction, purely mechanical
3. Refactor 2 (connection.rs) — moderate complexity due to generics/Pin
4. Refactor 4 (session_handlers.rs) — only if lifetimes cooperate; skip if not

## Verification

After each refactor:
1. `cargo check` — workspace root
2. `cargo test` — in affected crate (maestro-server or src-tauri)

## Excluded

- Unused UI components — treeshaked, no action
- Protocol "dead code" — false positives (cross-crate)
- IPC handler "dead code" — Tauri entry points
- command_loop.rs refactors (2f, 2g) — savings too small for generic complexity
- Fast-path/cold-path macro — too clever, obscures control flow
