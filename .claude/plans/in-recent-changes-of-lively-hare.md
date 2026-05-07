# Analysis: Zed #54431 vs Maestro Drain Buffer

## Context

Both solve the same race condition conceptually: during `session/load`, the agent replays history as `session/update` notifications before responding. If the consumer isn't ready, those events are lost.

## Architectural Difference (Why Zed's Fix Doesn't Apply)

| | Zed | Maestro |
|--|-----|---------|
| **Runtime** | Single-process, GPUI executor | Cross-runtime: Rust → Tauri events → React |
| **Event delivery** | Rust function call into `handle_session_notification` which does `sessions.get(&id)` | `app_handle.emit()` — fire-and-forget pub/sub |
| **Root cause** | HashMap lookup fails → notification discarded | No JS listener registered yet → event lost to void |
| **Fix** | Pre-register session in HashMap before RPC | Buffer events until frontend calls drain |

Zed's "pre-register with placeholders" trick works because their notification handler is a Rust function that does a synchronous map lookup. Making the session findable = problem solved, no buffering needed.

Maestro's problem is fundamentally different: `app_handle.emit()` doesn't look anything up — it broadcasts to subscribers. If there are zero subscribers (React hasn't mounted), the event vanishes. There's no map to pre-register in.

## Assessment: Maestro's Implementation is Already Correct

The drain buffer pattern is the right solution for cross-runtime pub/sub:

1. `replay_buffer = Some(Vec::new())` — created before reader task starts (no window for loss)
2. Reader task checks buffer — if `Some`, accumulates; if `None`, emits directly
3. Frontend registers listeners → calls `drainAcpReplay` → `buf.take()` atomically flushes + disables buffering
4. Future events emit directly (buffer = `None`)

This is minimal and correct. The one-shot `Option::take()` transition is elegant.

## Minor Observations (Not Actionable)

- `replay_buffer.lock()` returning `Err` (line 507 of manager.rs) silently falls through to `emit()` — poisoned mutex would emit unbuffered rather than buffering. Acceptable: mutex poisoning requires a panic in another thread holding the lock, which shouldn't happen.
- The `Arc<Mutex<Option<Vec<Value>>>>` threading through `handle_server_message` params is verbose but necessary given the function signature.

## Conclusion

**No changes recommended.** Maestro's drain buffer is the correct pattern for its architecture. Zed's approach is inapplicable due to the cross-runtime boundary. The current implementation is already minimal and handles the sequencing correctly.

One thing Zed does better: regression tests for the race condition (`test_load_session_replays_notifications_sent_before_response`). Maestro could benefit from a similar integration test that verifies no events are dropped during session load — but that's testing infrastructure, not a code simplification.
