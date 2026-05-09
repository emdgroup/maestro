# Fix: Cancel button doesn't interrupt agent + stays active after finish

## Context

Two bugs with the cancel button in agent sessions:
1. Clicking cancel does nothing — agent keeps running
2. Cancel button remains visible after agent finishes answering

Root causes:
- **Bug 1**: `CancelNotification` is cooperative (ACP protocol). Agent can ignore it. No fallback mechanism exists.
- **Bug 2**: When `send_request_to` fails in `run_command_loop`, the loop breaks without emitting `TurnEnded`. Frontend never learns the turn ended, so `isProcessing` stays `true`.
- **Bug 2 (secondary)**: The `acp://session-error` event is emitted by Tauri but no frontend listener resets `isProcessing`.

## Changes

### 1. Backend: Emit `TurnEnded` on abnormal loop exit

**File:** `maestro-server/src/session_handler.rs` — `run_command_loop` (~line 442)

Add `broke_on_error` flag. When `send_request_to` returns `Err`, set flag and break. After the while loop, if flag is set, emit synthetic `TurnEnded { stop_reason: "error" }`.

```rust
async fn run_command_loop(...) {
    let mut broke_on_error = false;

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SessionCommand::Prompt(content) => {
                // ... existing code ...
                if result.is_err() {
                    broke_on_error = true;
                    break;
                }
            }
            SessionCommand::PromptStructured(blocks) => {
                // ... existing code ...
                if result.is_err() {
                    broke_on_error = true;
                    break;
                }
            }
            // CancelTurn, SetModel, SetMode unchanged
        }
    }

    // Emit synthetic TurnEnded so frontend resets isProcessing
    if broke_on_error {
        let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
            session_id: maestro_sid,
            stop_reason: "error".to_string(),
        }));
        let _ = send_response(&so, &msg).await;
    }
}
```

### 2. Frontend: Add `session-error` listener to reset `isProcessing`

**File:** `src/components/execution/AgentActivityPanel.tsx` — existing useEffect at line 81

Add listener for `acp://session-error/${sessionKey}` that resets `isProcessing` and activity status.

### 3. Frontend: Cancel with timeout fallback

**File:** `src/components/execution/AgentActivityPanel.tsx` — `handleCancel` at line 300

Replace with:
1. Send cooperative `interruptAcpTurn`
2. Start 5s timeout
3. If no `turn-ended` / `session-ended` arrives within timeout → reset UI + call `cancelAcpSession` (force-kill)
4. Clean up listeners/timeout on success or unmount

Add a `cancelCleanupRef` for timeout + one-shot listener management. Also clear cancel state at start of `handleSend` (prevents stale timeout firing after new prompt).

## Verification

1. `cd maestro-server && cargo check` — Rust compiles
2. `pnpm lint` — no frontend lint errors
3. Manual test: spawn session, send prompt, click cancel → agent should stop within 5s
4. Manual test: spawn session, send prompt, wait for finish → button should disappear immediately
5. Edge case: kill maestro-server process mid-turn → button should reset (via session-error or session-ended)

## Files to modify

- `maestro-server/src/session_handler.rs` (backend fix)
- `src/components/execution/AgentActivityPanel.tsx` (frontend: error listener + cancel timeout)
