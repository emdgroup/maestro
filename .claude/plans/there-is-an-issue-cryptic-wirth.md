# Fix: Cancel button doesn't interrupt agent and stays active after turn ends

## Context

The cancel/stop button in agent sessions has two bugs:
1. Clicking cancel does nothing — the agent keeps running
2. The button stays in "processing" state even after the agent finishes answering

Root cause: The frontend relies solely on the `acp://turn-ended` Tauri event to reset `isProcessing`. This event originates from `handle_prompt_result` in maestro-server, which is invoked as a callback (`on_receiving_result`) when the agent sends its `PromptResponse`. If the callback never fires (command loop exits, connection drops) or the agent ignores the `CancelNotification`, the frontend is stuck.

## Changes

### 1. Backend safety net: emit TurnEnded on command loop exit

**File:** `maestro-server/src/session_handler.rs` — `run_command_loop` (line 442)

Add an `Arc<AtomicBool>` tracking whether a prompt is in-flight. Set it `true` before `send_request_to`, clear it inside the `on_receiving_result` callback. After the while loop exits, if the flag is still true, write a `TurnEnded { stop_reason: "disconnected" }` to stdout.

This ensures the frontend ALWAYS gets notified that the turn ended, regardless of whether the ACP SDK callback fires.

### 2. Frontend: cancel timeout fallback

**File:** `src/components/execution/AgentActivityPanel.tsx`

After `interruptAcpTurn` succeeds, start a 5-second timeout. If `turn-ended` doesn't arrive within that window, force-reset `isProcessing = false`. Clear the timeout when `turn-ended` fires normally.

### 3. Frontend: stale processing detector

**File:** `src/components/execution/AgentActivityPanel.tsx`

Add a useEffect that runs a 30-second timer when `isProcessing` is true. Reset the timer whenever `liveState.items.length` changes (new streaming content). If 30 seconds pass with no new items, auto-reset `isProcessing`. Belt-and-suspenders for edge cases where both backend safety net and cancel timeout fail.

### 4. Backend: emit TurnEnded on failed CancelTurn dispatch

**File:** `maestro-server/src/main.rs` (line 298)

When `cmd_tx.send(CancelTurn)` fails (channel closed = session dead), emit `TurnEnded { stop_reason: "disconnected" }` immediately. Provides faster feedback than waiting for the command loop's exit path.

## Implementation Details

### Change 1 — `maestro-server/src/session_handler.rs`

```rust
use std::sync::atomic::AtomicBool;

async fn run_command_loop(
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    cx: acp::ConnectionTo<acp::Agent>,
    session_id: acp::schema::SessionId,
    so: Arc<Mutex<tokio::io::Stdout>>,
    maestro_sid: String,
) {
    let turn_in_flight = Arc::new(AtomicBool::new(false));

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SessionCommand::Prompt(content) => {
                turn_in_flight.store(true, Ordering::SeqCst);
                let so = Arc::clone(&so);
                let sid = maestro_sid.clone();
                let tif = Arc::clone(&turn_in_flight);
                let result = cx
                    .send_request_to(...)
                    .on_receiving_result(async move |result| {
                        tif.store(false, Ordering::SeqCst);
                        handle_prompt_result(result, sid, &so).await;
                        Ok(())
                    });
                if result.is_err() { break; }
            }
            // Same pattern for PromptStructured
            SessionCommand::CancelTurn => { /* unchanged */ }
            // SetModel/SetMode unchanged
        }
    }

    // Safety net: if a turn was in flight when the loop exited, notify frontend
    if turn_in_flight.load(Ordering::SeqCst) {
        let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
            session_id: maestro_sid,
            stop_reason: "disconnected".to_string(),
        }));
        let _ = send_response(&so, &msg).await;
    }
}
```

### Change 2 & 3 — `AgentActivityPanel.tsx`

```typescript
// Add ref for cancel timeout
const cancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

// Modify turn-ended listener to clear timeout
useEffect(() => {
  const unlisten = listen<string>(`acp://turn-ended/${sessionKey}`, () => {
    if (cancelTimeoutRef.current) {
      clearTimeout(cancelTimeoutRef.current);
      cancelTimeoutRef.current = null;
    }
    setIsProcessing(false);
  });
  return () => { unlisten.then((fn) => fn()); };
}, [sessionKey]);

// Modify handleCancel to set timeout
const handleCancel = useCallback(async () => {
  try {
    await api.interruptAcpTurn(sessionKey);
    cancelTimeoutRef.current = setTimeout(() => {
      cancelTimeoutRef.current = null;
      setIsProcessing(false);
      setActivityStatus(sessionKey, "idle");
    }, 5000);
  } catch {
    setIsProcessing(false);
    setActivityStatus(sessionKey, "idle");
  }
}, [sessionKey, setActivityStatus]);

// Stale processing detector (30s timeout, resets on new items)
useEffect(() => {
  if (!isProcessing) return;
  const timer = setTimeout(() => {
    setIsProcessing(false);
    setActivityStatus(sessionKey, "idle");
  }, 30000);
  return () => clearTimeout(timer);
}, [isProcessing, liveState.items.length, sessionKey, setActivityStatus]);

// Cleanup on unmount
useEffect(() => {
  return () => { if (cancelTimeoutRef.current) clearTimeout(cancelTimeoutRef.current); };
}, []);
```

### Change 4 — `maestro-server/src/main.rs`

```rust
MaestroRpcMessage::Request(ServerRequest::InterruptTurn(req)) => {
    if let Some(session) = sessions.get(&req.session_id) {
        if session.cmd_tx.send(SessionCommand::CancelTurn).await.is_err() {
            let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
                session_id: req.session_id,
                stop_reason: "disconnected".to_string(),
            }));
            let _ = send_response(&stdout, &msg).await;
        }
    }
}
```

## Verification

1. `cd maestro-server && cargo check` — Rust compiles
2. `pnpm lint` — no lint errors in frontend
3. Manual test: Start agent session → send prompt → click cancel during response → button should reset within 5s
4. Manual test: Start agent session → send prompt → let agent finish → button should reset immediately (normal TurnEnded flow unchanged)
5. Edge case: Kill maestro-server process during active turn → button should reset within 30s (stale detector)
