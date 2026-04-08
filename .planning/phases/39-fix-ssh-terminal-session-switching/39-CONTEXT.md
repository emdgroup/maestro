---
name: Phase 39 Context
description: Implementation decisions for SSH terminal session switching fix
type: project
---

# Phase 39: Fix SSH Terminal Session Switching — Context

**Gathered:** 2026-04-08
**Status:** Ready for planning
**Source:** Debug session — `.planning/debug/terminal-cached-screen-on-switch.md` + design conversation

<domain>
## Phase Boundary

Fix two distinct root causes of the "cached screen" bug when switching terminal sessions:

1. **SSH sessions**: full history replay from `pos=0` on every attach causes the terminal to appear populated with stale content on first visible frame.
2. **Local PTY sessions**: OS kernel buffer flush on fresh attach + two-reader race from no-op `detach_terminal` causes brief stale output flicker.

This phase also adds DB persistence for SSH session history so dead sessions can be recovered.

Out of scope: UI redesign of the terminal component, new features beyond session switching fidelity.

</domain>

<decisions>
## Implementation Decisions

### Frontend: Terminal mount timing (`src/components/execution/Terminal.tsx`)

- **Move `tryAttach()` inside the `requestAnimationFrame` callback, after `fitAddon.fit()`.**
  - Currently `tryAttach()` fires immediately on mount (line 83), before rAF. Data arrives and populates xterm's internal buffer before the first pixel is painted. The first visible frame shows replayed content.
  - Fix: `tryAttach()` moves inside the rAF callback after `fitAddon.fit()`. The SIGWINCH signal already fires via the `terminal.onResize` callback → `api.resizeTerminal()` when `fit()` is called with new dimensions. This triggers the running program to repaint its screen — the user sees a blank terminal for ~1 frame, then fresh repainted content arrives.

- **Write `\x1b[2J\x1b[H` (clear-screen + cursor home) before `tryAttach()`.**
  - Cosmetic guard. Ensures the terminal shows a blank screen from the moment it becomes visible, regardless of when the first real data arrives.

- **No "Loading..." indicator** — the SIGWINCH repaint is fast enough to not need it.

### Backend: SSH history buffer (`src-tauri/src/ssh/session.rs`, `src-tauri/src/process/remote.rs`)

Replace `history: Arc<Mutex<Vec<String>>>` with **`history: Arc<Mutex<String>>`** (a single accumulated String).

**Trimming logic** (run on every chunk before appending):
1. Check the incoming chunk for `\x1b[2J` (clear-screen escape sequence).
2. If found: **drop all content before and including the `\x1b[2J`** in the buffer. Start fresh from that point. This respects the semantic meaning of clear-screen — anything before it is irrelevant.
3. **Byte-cap fallback**: if the buffer exceeds a fixed cap (e.g. 512 KB) without ever receiving a clear-screen, trim from the front to the nearest `\r\n` boundary until under the cap. This prevents unbounded growth for sessions that never clear (e.g. long-running `top` or streaming logs).

**Why single String over Vec<String>**: boundary trimming is simpler on a contiguous String (find `\x1b[2J]`, truncate). A Vec of chunks would require iterating across chunk boundaries to find the sequence.

### Backend: `attach_terminal` SSH path (`src-tauri/src/ipc/execution_handlers.rs`)

**For live sessions (process still running):**
- Start at `pos = history_len` (i.e. send nothing from history). Skip all historical content.
- The SIGWINCH sent by `fitAddon.fit()` → `api.resizeTerminal()` → backend PTY resize will trigger the running program to repaint its current screen state. Live output flows from that point.

**For dead sessions (process has exited):**
- Read `terminal_output` from `execution_logs` DB row for the task.
- Send as a single write to the channel.
- This is the snapshot saved when the session ended (see DB persistence below).

### Backend: DB persistence for SSH sessions

**On session process exit** (`ssh/session.rs` or wherever session death is detected):
- Write the current `history` String to `execution_logs.terminal_output` for the associated task.

**On application close** (`main.rs` Tauri shutdown hook / `on_window_event` + `RunEvent::ExitRequested`):
- Iterate all active SSH PTY sessions in `AppState.ssh_pty_sessions`.
- For each: flush `handle.history` String to `execution_logs.terminal_output`.
- This ensures live sessions at app close are recoverable on next launch.

### Backend: Proper `detach_terminal` for local PTY (cancel token)

**Current problem**: `detach_terminal` is a no-op. The old tokio reader task keeps running and races with the new reader for the same PTY fd bytes.

**Fix**: Add a per-session cancel token (tokio `watch` channel) to `AppState` (or to the `PtySession` struct):
```rust
pub pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::watch::Sender<bool>>>>
```
- On `attach_terminal` local path: create a `watch::channel(false)`, store sender in map, pass receiver to reader task. Reader checks `receiver.changed()` before each send.
- On `detach_terminal`: look up task_id in map, send `true` to cancel. Old reader task exits cleanly.

This eliminates the two-reader race for local PTY sessions.

### Claude's Discretion

- Exact byte cap value (512 KB suggested — tune if needed)
- Whether to store the cancel token in `AppState` or in `PtySession` struct (prefer `PtySession` for encapsulation)
- Exact Tauri shutdown hook API (check `RunEvent::ExitRequested` vs `RunEvent::Exit` for correct timing)
- Whether to flush SSH history synchronously in the shutdown hook or spawn a blocking task

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Terminal component
- `src/components/execution/Terminal.tsx` — full file, contains the rAF/attach timing issue

### SSH history buffer
- `src-tauri/src/ssh/session.rs` — `SshPtyHandle` definition and `spawn_remote_pty`
- `src-tauri/src/process/remote.rs` — remote process execution and history accumulation

### IPC handlers
- `src-tauri/src/ipc/execution_handlers.rs` — `attach_terminal` (lines 195–390), `detach_terminal` (lines 547–556)

### App state and entry point
- `src-tauri/src/db/connection.rs` — `AppState` definition, `pty_sessions` map
- `src-tauri/src/main.rs` — Tauri app builder, shutdown hook location

### Debug session (root cause analysis and plan)
- `.planning/debug/terminal-cached-screen-on-switch.md` — full investigation, evidence, root cause, original plan

</canonical_refs>

<specifics>
## Specific Implementation Details

### `\x1b[2J` trimming pseudocode (Rust)
```rust
fn append_to_history(history: &mut String, chunk: &str) {
    // Find last occurrence of clear-screen in new chunk
    if let Some(pos) = chunk.rfind("\x1b[2J") {
        // Drop all history, start fresh from the clear-screen position in chunk
        history.clear();
        history.push_str(&chunk[pos..]);
    } else {
        history.push_str(chunk);
        // Byte-cap trim
        const MAX_BYTES: usize = 512 * 1024;
        if history.len() > MAX_BYTES {
            let trim_to = history.len() - MAX_BYTES;
            // Find nearest \r\n boundary after trim_to
            if let Some(newline_pos) = history[trim_to..].find("\r\n") {
                history.drain(..trim_to + newline_pos + 2);
            } else {
                history.drain(..trim_to);
            }
        }
    }
}
```

### rAF reorder (TypeScript)
```typescript
const rafId = requestAnimationFrame(() => {
  fitAddon.fit();
  // fit() triggers onResize → api.resizeTerminal() → SIGWINCH → program repaints
  // Now attach — terminal is blank, sized correctly, repaint incoming
  terminal.write('\x1b[2J\x1b[H'); // clear-screen guard
  tryAttach();
});
// Remove the tryAttach() call that was outside the rAF
```

### Live vs dead session detection in attach_terminal
The `SshPtyHandle` likely has a `child` handle. Check if the child process is still running. Alternatively: add an `is_alive: Arc<AtomicBool>` flag to `SshPtyHandle` that gets set to false in the session death handler.

</specifics>

<deferred>
## Deferred Ideas

- Loading spinner / "Connecting..." indicator in terminal — not needed given SIGWINCH repaint speed
- Limiting local PTY history replay — out of scope (local sessions don't replay history)
- Periodic SIGWINCH snapshots for backgrounded sessions — rejected; can't isolate repaint bytes from live stream
- Ring buffer based on chunk count — rejected; could cut ANSI sequences mid-stream

</deferred>

---

*Phase: 39-fix-ssh-terminal-session-switching*
*Context gathered: 2026-04-08 via debug session synthesis*
