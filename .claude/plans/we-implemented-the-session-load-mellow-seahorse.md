# Fix incomplete session history on ACP session load

## Context

Session load (`session/load`) works by asking the agent to replay its entire conversation history as a burst of `SessionNotification` events. The oldest messages arrive first. Currently, history is incomplete because:

1. **Race condition (primary cause)**: The reader task starts emitting Tauri events immediately, but the frontend listener isn't registered until React mounts the component and the `useEffect` fires. Events emitted during this window (containing the oldest messages) are silently dropped.

2. **`user_message` filter**: `useAcpActivity.ts:159` drops all `user_message` events in the live listener path, so historical user messages from the replay never appear.

3. **Missing handshake (correctness bug)**: `spawn_loaded_acp_session` sends `SessionLoad` as the first message without performing the protocol handshake. `maestro-server` expects `Handshake` first and rejects anything else. This likely works in testing only because the running binary predates the handshake requirement, but will break on next rebuild.

## Plan

### 1. Add handshake to `spawn_loaded_acp_session` (local path)

**File**: `src-tauri/src/ipc/acp_handlers.rs` (line ~912)

Before sending `SessionLoad`, send `Handshake` and wait for `HandshakeOk` — same pattern as `spawn_acp_process` in `manager.rs:210-214`. Use `perform_handshake_local` from `manager.rs`.

### 2. Add handshake to `spawn_loaded_acp_session_remote` (remote path)

**File**: `src-tauri/src/ipc/acp_handlers.rs` (line ~992)

Same fix for the SSH path — send handshake bytes first, then read `HandshakeOk` before sending `SessionLoad`.

### 3. Buffer replay events until frontend listener is ready

**File**: `src-tauri/src/acp/manager.rs`

Strategy: buffer `SessionUpdate` events in the `AcpProcess` struct until the frontend signals it's listening, then flush. Approach:

- Add `replay_buffer: Arc<Mutex<Option<Vec<serde_json::Value>>>>` to `AcpProcess` — initialized to `Some(vec![])` for loaded sessions, `None` for fresh spawns.
- In `handle_server_message`, if `replay_buffer` is `Some`, push updates there instead of emitting.
- Add new IPC command `drain_session_replay(log_id)` that takes the buffer, sets it to `None`, and emits all buffered events + switches to direct emit mode.

**File**: `src/components/execution/activity/useAcpActivity.ts`

- After `listen()` callbacks are registered, call `invoke("drain_session_replay", { logId })` to flush buffered events and enable live streaming.

### 4. Allow `user_message` events during session load replay

**File**: `src/components/execution/activity/useAcpActivity.ts` (line 159)

Remove the blanket `user_message` filter. Instead, only filter user_message events that arrive AFTER the replay drain completes (i.e., during normal live operation). Approach:

- Add a `isReplaying` ref that starts `true` for loaded sessions.
- `drain_session_replay` IPC return flips it to `false`.
- Only filter `user_message` when `isReplaying.current === false`.

## Files to modify

- `src-tauri/src/ipc/acp_handlers.rs` — add handshake to both load paths
- `src-tauri/src/acp/manager.rs` — add replay buffer logic to `AcpProcess` and `handle_server_message`
- `src-tauri/src/acp/mod.rs` — add `replay_buffer` field to `AcpProcess`
- `src-tauri/src/ipc/mod.rs` — register new `drain_session_replay` command
- `src/components/execution/activity/useAcpActivity.ts` — drain call + user_message filter fix

## Existing functions to reuse

- `perform_handshake_local` in `src-tauri/src/acp/manager.rs:214`
- `write_to_acp_session_raw` in `src-tauri/src/acp/manager.rs`
- `serialize_message` in `src-tauri/src/acp/manager.rs`
- `session_id_for` in `src-tauri/src/ipc/acp_handlers.rs`

## Verification

1. `cargo check` in `src-tauri/` — confirms compilation
2. `pnpm lint` — confirms frontend builds
3. Manual test: load a session with significant history, verify oldest messages appear
4. Confirm user messages (blue bubbles) show in replayed history
5. Confirm handshake works: rebuild both Tauri and maestro-server, verify session load still succeeds
