# Unify Local/Remote Code Paths in Tauri Backend

## Context

Maestro's architecture is sound: `maestro-server` acts as a transport-agnostic intermediary that runs identically on local and remote machines. The frontend is already clean — it passes `connectionId: null | number` and lets the backend decide. But the **Rust backend** (`src-tauri/src/acp/`) has ~900 lines of duplication because the transport layer (how bytes reach maestro-server) is conflated with the logic layer (what to do with those bytes).

The root cause: the codebase never exploited the fact that `russh::ChannelRx::new(read_half, None)` wraps an SSH channel as a standard `tokio::io::AsyncRead`. Instead, every remote reader manually handles `ChannelMsg::Data`, `ChannelMsg::Eof`, etc. — duplicating what `ChannelRx` already does internally.

## What NOT to Unify

- **`deploy.rs`** — Genuinely remote-only (SFTP upload of maestro-server binary). No local equivalent.
- **PTY sessions** (`PtySession` vs `SshPtyHandle`) — Structurally different (blocking `portable_pty` vs async SSH channels with ANSI history tracking). The if-else cascading in `attach_terminal` etc. is the right pattern.
- **`AcpTransportWriter` enum** — Already works well. Three variants, clean dispatch.
- **`prefetch_agent_discovery`** — Different work per path (local `which` vs remote SFTP deploy).

## Phase 1: AcpProcess Builder (~200 LOC removed, zero risk)

`AcpProcess` has ~20 fields all wrapped in `Arc<Mutex<...>>`. Constructed identically 8+ times across `manager.rs` and `acp_handlers.rs` (~25 lines each).

**Change:** Add `AcpProcess::new(params: AcpProcessParams) -> (AcpProcess, ReaderTaskContext)` that creates all the `Arc`s once and returns both the process and its paired reader context.

**Files:** `src-tauri/src/acp/manager.rs`, `src-tauri/src/ipc/acp_handlers.rs`

## Phase 2: Unify Read Side (~250 LOC removed, low risk)

The key insight: `russh::ChannelRx::new(read_half, None)` implements `AsyncRead`. And `maestro_protocol::read_message()` already accepts `impl AsyncRead + Unpin`. So both local (`BufReader<ChildStdout>`) and remote paths can share a single reader.

**Type:** `type BoxedReader = Box<dyn tokio::io::AsyncRead + Unpin + Send>;`

### 2a. Unify handshake
- `perform_handshake_local()` + `perform_handshake_remote()` → single `perform_handshake(reader: &mut (impl AsyncRead + Unpin))`
- Local caller: pass `&mut child_stdout`
- Remote caller: wrap `ChannelRx::new(read_half, None)`, pass that

### 2b. Unify dedicated reader tasks
- `spawn_reader_task` + `spawn_remote_reader_task` → single function taking `BoxedReader`
- Local: `Box::new(BufReader::new(child_stdout))`
- Remote: `Box::new(BufReader::new(ChannelRx::new(read_half, None)))`
- Body identical — `read_message()` already works on `AsyncRead`

### 2c. Unify shared reader tasks
- `spawn_shared_reader_task` + `spawn_shared_remote_reader_task` → same approach
- Cleanup logic (remove from map, emit events) already identical

### 2d. Unify one-shot RPC
- `one_shot_rpc_local` + `one_shot_rpc_remote` → single `one_shot_rpc(reader, writer, request, timeout)`
- `read_next_frame_local` + `read_next_frame_remote` → single `read_next_frame(reader, buf)`

**Files:** `src-tauri/src/acp/manager.rs`, `src-tauri/src/acp/rpc.rs`

**Behavioral note:** `ChannelRx` with `ext: None` filters for `Data` only, returns `Pending` for other message types (ExtendedData, WindowAdjusted), returns `Ok(())` (EOF) for `Eof`. This matches the current manual handling where ExtendedData is dropped and Eof breaks the loop.

## Phase 3: Unify ProjectServer Structs (~150 LOC removed, low-medium risk)

`ProjectServer` and `RemoteProjectServer` are near-identical. Differ only in `ProjectServer` holding a `Child`.

**Change:**
```rust
pub struct ProjectServer {
    pub child: Option<Child>,  // None for remote
    pub writer_tx: mpsc::Sender<Vec<u8>>,
    pub pre_init_pending: Arc<Mutex<HashMap<String, oneshot::Sender<...>>>>,
}
```

- Collapse `project_servers` + `remote_project_servers` into single map in `AcpState`
- Merge `spawn_project_server` + `spawn_remote_project_server` — only transport setup differs, rest shared
- Merge `pre_initialize_via_project_server` + `pre_initialize_via_remote_project_server` — trivially identical once single map

**Files:** `src-tauri/src/acp/manager.rs`, `src-tauri/src/acp/mod.rs`, `src-tauri/src/ipc/acp_handlers.rs`

**Depends on:** Phase 2 (unified reader for shared reader task)

## Phase 4: Unify One-Shot RPC Callers (~100 LOC removed, low risk)

After Phase 2 provides unified `one_shot_rpc`, collapse:
- `query_list_agents_local` + `query_list_agents_remote` → single function
- `query_session_list_local` + `query_session_list_remote` → single function
- `query_session_close_local` + `query_session_close_remote` → single function

Add helper:
```rust
async fn setup_one_shot_connection(
    app_state: &AppState,
    connection_id: Option<i32>,
) -> Result<(BoxedReader, BoxedWriter, Option<Child>), String>
```

**Files:** `src-tauri/src/acp/rpc.rs`, `src-tauri/src/ipc/acp_handlers.rs`

**Depends on:** Phase 2

## Phase 5: Simplify spawn/load IPC Handlers (~200 LOC removed, medium risk)

After Phases 1-3, the 4-way branch (local shared / local dedicated / remote shared / remote dedicated) in `spawn_acp_session` and `load_acp_session` reduces to 2: shared server path (unified) vs dedicated process path (differs only in obtaining `BoxedReader + BoxedWriter`).

**Files:** `src-tauri/src/ipc/acp_handlers.rs`, `src-tauri/src/acp/manager.rs`

**Depends on:** Phases 1-3

## Summary

| Phase | Target | LOC Removed | Risk | Depends On |
|-------|--------|-------------|------|------------|
| 1 | AcpProcess builder | ~200 | Zero | None |
| 2 | Reader/handshake/RPC unification | ~250 | Low | None |
| 3 | ProjectServer struct merge | ~150 | Low-Med | Phase 2 |
| 4 | One-shot RPC callers | ~100 | Low | Phase 2 |
| 5 | spawn/load handler simplification | ~200 | Medium | 1-3 |
| **Total** | | **~900** | | |

**Execution order:** Phases 1 and 2 are independent (can parallelize). Then 3 and 4. Then 5.

## Verification

After each phase:
1. `cargo check` — compilation
2. `cargo test` — existing tests pass
3. Manual test: spawn local ACP session, verify streaming works
4. Manual test: spawn remote ACP session over SSH, verify streaming works
5. Test shared project server path (local + remote)
6. Test session list/close operations (local + remote)

## Critical Files

- `src-tauri/src/acp/manager.rs` — bulk of duplication lives here
- `src-tauri/src/acp/rpc.rs` — one-shot RPC duplication
- `src-tauri/src/acp/mod.rs` — AcpState struct with dual maps
- `src-tauri/src/ipc/acp_handlers.rs` — IPC handlers with 4-way branching
