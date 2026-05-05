# Fix: Loaded ACP sessions show no messages (race condition)

## Context

When resuming an ACP session from the history panel, no messages display — not user messages, not agent responses, nothing. New sessions work fine. The previous fix (removing `user_message` filter + `liveUserMessages`) is already applied but didn't solve the full problem.

**Root cause**: Race condition between event emission and React subscription.

Flow when loading a session:
1. `load_acp_session` IPC → spawns `maestro-server`, starts reader task
2. Reader receives `SessionLoadOk` → emits `sessions-changed`
3. Reader receives replay `SessionUpdate` events → emits them **immediately** (local: `replay_buffer: None`)
4. Frontend receives `sessions-changed` → invalidates query → re-fetches → re-renders → mounts `AgentActivityPanel` → `useEffect` subscribes
5. **Step 3 events are already gone by step 4**

The `replay_buffer` mechanism was designed for this (comment at `manager.rs:504-506`) but was only half-implemented:
- `AcpProcess.replay_buffer` field exists (`Some(vec)` = buffer, `None` = emit directly)
- Local loaded sessions incorrectly use `None` (no buffering) — `acp_handlers.rs:940`
- Remote loaded sessions use `Some(Vec::new())` (buffering ON) but there's **no drain command**
- The comment references `drain_session_replay` which doesn't exist

## Fix

### 1. `src-tauri/src/ipc/acp_handlers.rs` — Enable buffering + add drain command

**a)** Line 940: Change local loaded session `replay_buffer` from `None` to `Some(Vec::new())`:
```rust
let replay_buffer = Arc::new(std::sync::Mutex::new(Some(Vec::new())));
```

**b)** Add new IPC command (place after `load_acp_session`):
```rust
#[tauri::command]
#[specta::specta]
pub async fn drain_acp_replay(
    app_state: State<'_, Arc<AppState>>,
    app_handle: AppHandle,
    log_id: i32,
) -> Result<(), String> {
    let replay_arc = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).map(|s| Arc::clone(&s.replay_buffer))
    };
    let Some(replay_arc) = replay_arc else {
        return Ok(());
    };
    let buffered = {
        let mut buf = replay_arc.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        buf.take().unwrap_or_default()
    };
    for payload in buffered {
        let _ = app_handle.emit(&format!("acp://session-update/{}", log_id), &payload);
    }
    Ok(())
}
```

`take()` sets buffer to `None` → future events from reader task emit directly (the `if let Some(ref mut vec)` check in `handle_server_message` falls through).

### 2. `src-tauri/src/lib.rs` — Register new command

Add `crate::ipc::drain_acp_replay` to command list (after `load_acp_session`).

### 3. Regenerate bindings

`pnpm tauri:gen` to generate `drainAcpReplay` in `bindings.ts`.

### 4. `src/components/execution/activity/useAcpActivity.ts` — Call drain after subscribe

After all three `listen()` calls resolve, flush the buffer:
```typescript
useEffect(() => {
  if (logId == null) return;

  const unlisteners = Promise.all([
    listen<unknown>(`acp://session-update/${logId}`, (event) => {
      dispatch({ type: "event", payload: event.payload as SessionUpdatePayload });
    }),
    listen<null>(`acp://session-ended/${logId}`, () => {
      dispatch({ type: "session_ended" });
    }),
    listen<string>(`acp://turn-ended/${logId}`, () => {
      dispatch({ type: "turn_ended" });
    }),
  ]).then((listeners) => {
    api.drainAcpReplay(logId).catch(console.error);
    return listeners;
  });

  return () => {
    unlisteners.then(([u1, u2, u3]) => { u1(); u2(); u3(); });
  };
}, [logId]);
```

For fresh sessions (`replay_buffer: None`), `drain` is a no-op — `take()` on `None` returns `None`, `unwrap_or_default()` yields empty vec, no events emitted.

## Verification

1. `cargo check` — compiles
2. `pnpm tauri:gen` — regenerate bindings
3. `pnpm exec tsc --noEmit` — TypeScript clean
4. `pnpm test` — no regressions
5. Manual: start session → send messages → close panel → reopen from history → full conversation visible
6. Manual: fresh new session still works normally (drain is no-op)
