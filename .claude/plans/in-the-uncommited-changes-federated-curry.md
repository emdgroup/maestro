# Fix: Session History Not Displaying on Load

## Context

Two issues from the refactoring:
1. **Original 3 symptoms** (no agents, no sessions, no history button) — FIXED by restoring `prefetch_agent_discovery` in `project_handlers.rs`.
2. **Session history not displayed** when loading a previous session — affects both local and remote. This is the current issue.

## Previous Fix Attempt (router ordering)

Moved `router.register()` before `cx.send_request(load_req).block_task()` in `load_session_on_connection` (`session_handler.rs:1116-1120`). Also added `unregister` method to `SessionRouter` (`sessions.rs`). This fix is **structurally correct** but did not resolve the symptom.

## Deep Analysis

Exhaustive code trace of the full pipeline:

1. **Tauri `try_session_load_via_project_server`** — creates `AcpProcess` with `enable_replay_buffer: true`, inserts into sessions map BEFORE sending request. Correct.
2. **maestro-server `load_session_on_connection`** — registers router route BEFORE `block_task()`. Correct (after our fix).
3. **`handle_notification`** — looks up route, writes `SessionUpdate` to stdout. Route exists. Correct.
4. **Tauri shared reader** — `handle_shared_server_message` extracts `log_id`, finds session in map, calls `handle_server_message` which buffers in `replay_buffer`. Correct.
5. **Frontend `useAcpActivity`** — registers 3 listeners, then calls `drainAcpReplay`. After drain, buffer is `None`, future events emit directly. Correct.
6. **Frontend `processEvent`** — handles `agent_message_chunk`, `tool_call`, `user_message_chunk`, etc. Correct.
7. **Rendering** — `groupToolCalls` → `groupIntoAgentSections` → renders via `AgentResponseSection`. No filtering that would drop history items.

**Every code path checks out.** No obvious bug found by static analysis.

## Key Finding

User reports `drainAcpReplay` "returns null" — this is the normal `Ok(())` return (the function always returns Ok regardless of whether the session was found or events were buffered). **We cannot distinguish success from "session not found" without logging.**

Note: The `replay_buffer` returns `Ok(())` silently when session is not in map (line 1193-1194 of acp_handlers.rs). This is a silent failure.

## Root Cause Hypotheses (ordered by likelihood)

### H1: Agent doesn't actually send history during session/load
ACP spec says `session/load` replays history. But agent implementation may not emit `SessionNotification` events during load. Need runtime verification.

### H2: Notifications arrive but ACP library swallows errors
The `handle_notification` handler returns `acp::Result<()>`. If the ACP library silently drops errors from notification handlers, events would vanish.

### H3: Timing race — drain fires before events buffered, then events arrive but listeners miss them
Unlikely since listeners are registered before drain, and post-drain events emit directly to registered listeners.

## Proposed Fix: Add Debug Logging

Since static analysis is inconclusive, add temporary `eprintln!` instrumentation at key points to identify where events drop:

### Files to Modify

1. **`maestro-server/src/session_handler.rs`** — `handle_notification` (line 254):
   ```rust
   eprintln!("[maestro-server] handle_notification: acp_sid={}, maestro_sid={}", acp_sid, maestro_sid);
   ```

2. **`maestro-server/src/session_handler.rs`** — `load_session_on_connection` before/after `block_task()`:
   ```rust
   eprintln!("[maestro-server] load_session_on_connection: sending session/load for {}", resume_session_id);
   // ... block_task ...
   eprintln!("[maestro-server] load_session_on_connection: session/load returned");
   ```

3. **`src-tauri/src/acp/manager.rs`** — `handle_server_message` SessionUpdate branch (line 616):
   ```rust
   eprintln!("[tauri] handle_server_message: SessionUpdate for log_id={}", log_id);
   ```

4. **`src-tauri/src/ipc/acp_handlers.rs`** — `drain_acp_replay` (line 1196):
   ```rust
   eprintln!("[tauri] drain_acp_replay: log_id={}, buffered_count={}", log_id, buffered.len());
   ```

### Expected Outcomes
- If `handle_notification` never fires → H1 confirmed (agent doesn't send history)
- If `handle_notification` fires but `handle_server_message` doesn't → routing/parsing issue
- If `handle_server_message` fires but drain returns 0 → timing race (H3)
- If drain returns >0 but UI is empty → frontend rendering bug

## Verification
1. `cargo check --workspace` passes
2. Load a previous session (local)
3. Check stderr output for debug lines
4. Identify which stage drops events
5. Remove debug logging after root cause identified
