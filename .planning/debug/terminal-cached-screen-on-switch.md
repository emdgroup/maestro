---
status: investigating
trigger: "When switching between agent sessions, the terminal appears to paint a cached/stale screen before drawing the current session's correct screen content."
created: 2026-04-08T00:00:00Z
updated: 2026-04-08T00:00:00Z
---

## Current Focus

hypothesis: Multiple independent causes exist for both SSH and local sessions. SSH sessions replay full history on every attach (by design), meaning the "cached screen" is actually the entire session history being written sequentially to a fresh xterm — giving the appearance of a stale screen. For local sessions, the PTY OS buffer feeds its last-written bytes immediately on attach even without explicit history replay, and additionally the cleanup/remount cycle has a timing gap where the old xterm canvas briefly persists in the DOM.

test: Traced code paths for both session types end-to-end
expecting: Confirmed — root causes identified, no ambiguity remains
next_action: Write plan section

## Symptoms

expected: Switching sessions shows the correct (current) terminal content immediately
actual: A cached/previously-rendered screen appears briefly before the actual session content is drawn
errors: None — purely visual
reproduction: Open Agents view with multiple running agent sessions, switch between them
started: Unknown. The terminal component was recently modified to fix a resize flash (rAF deferred fit()). Whether this is a pre-existing issue or new is unclear.

## Eliminated

- hypothesis: The stale screen is an actual DOM artifact from the old xterm instance persisting across remount
  evidence: React's key={terminalSessionId} guarantees a full DOM unmount before mounting the new component. The old terminal.dispose() runs in the cleanup function of the useEffect. The issue is not a lingering DOM node — it is new content written to a blank xterm that visually resembles old content.
  timestamp: 2026-04-08

- hypothesis: Local PTY sessions replay buffered history the same way SSH sessions do
  evidence: attach_terminal (execution_handlers.rs line 264) only sends history when include_history.unwrap_or(false) is true. Frontend always passes null (line 73 Terminal.tsx), which unwrap_or treats as false. No explicit history replay occurs for local sessions.
  timestamp: 2026-04-08

## Evidence

- timestamp: 2026-04-08
  checked: AgentMonitor.tsx lines 68-72, 193-196
  found: terminalSessionId = selectedExecution.task_id ?? selectedExecution.id. TerminalComponent receives key={terminalSessionId}. React destroys the old component and mounts a new one each time terminalSessionId changes. The key is the task_id (a stable integer), not a random UUID, so if two sessions map to the same task_id they would NOT remount — but in practice each running execution has a distinct task_id or uses its own log_id for interactive sessions.
  implication: Full DOM unmount/remount on every session switch is confirmed. There is no persistent DOM bleed-through.

- timestamp: 2026-04-08
  checked: Terminal.tsx useEffect lines 19-105
  found: Sequence on mount: (1) new Terminal() created, (2) terminal.open(terminalRef.current) — xterm renders its blank canvas into the DOM, (3) fitAddon loaded but fit() deferred to rAF, (4) new Channel<string>() created, (5) api.attachTerminal(taskId, channel, null) called immediately — no await before channel messages can arrive, (6) channel.onmessage wired to terminal.write(). The attach call is fire-and-forget.
  implication: There is a window where the backend begins streaming data (possibly a large history replay for SSH) before the rAF fires. xterm will process writes to its internal buffer immediately, but the first visual paint happens after the rAF. For SSH sessions this means the first-ever visible frame may already show many lines of replayed history all at once — "screen appears with stale content."

- timestamp: 2026-04-08
  checked: execution_handlers.rs attach_terminal, SSH path (lines 218-252)
  found: For SSH sessions (ssh_pty_sessions map), attach_terminal ALWAYS starts pos=0 and replays every chunk ever accumulated in handle.history. There is no include_history gating for SSH. Every attach sends the complete session history from the beginning. The chunks are driven by a notify loop — the replay happens as fast as the Tauri IPC channel can deliver them.
  implication: On session switch, a fresh xterm immediately receives 100s of lines of terminal output. xterm processes escape sequences, moves the cursor around, and the terminal is left in whatever visual state the session is currently in. This is the INTENDED behaviour — but the rapid sequential write of history creates the visual impression of "a stale cached screen appearing."

- timestamp: 2026-04-08
  checked: execution_handlers.rs attach_terminal, local PTY path (lines 255-390)
  found: For local sessions, include_history=null → false, so no DB history is sent. However, the PTY master reader (try_clone_reader()) creates a NEW OS file descriptor clone of the PTY master. The OS PTY kernel buffer retains unread bytes. When a new reader attaches, it reads from the current buffer position — it does NOT replay from the start. But the PTY kernel buffer (typically 4096 bytes on Linux) holds the most recently written but unread bytes if no consumer was reading. On session switch, these buffered bytes arrive in the first read() burst.
  implication: Local session "cached screen" is the OS PTY kernel buffer contents flushed to the new xterm immediately on attach. This is typically just the last screen's worth of output — the most recent partial line or prompt — rather than a full history replay.

- timestamp: 2026-04-08
  checked: Terminal.tsx cleanup (lines 99-104) and mount ordering
  found: cleanup runs: cancelAnimationFrame, resizeObserver.disconnect, api.detachTerminal (fire-and-forget IPC), terminal.dispose(). detachTerminal in execution_handlers.rs is a no-op (line 548-555) — it does nothing. The actual channel sender keeps running in the tokio background task until output_channel.send() fails (channel closed). The Tauri Channel is a one-shot IPC — when the frontend Channel object is garbage collected, send() will fail and the background task exits. However, there is a timing gap: React's cleanup runs, terminal.dispose() invalidates the xterm instance, but the tokio sender task may fire one more send() before detecting the closed channel. This extra write goes to a disposed terminal (harmless), not to the new terminal.
  implication: No inter-session data bleed. Old session data does NOT reach the new xterm.

- timestamp: 2026-04-08
  checked: Terminal.tsx rAF deferral (lines 58-60) vs immediate attachTerminal call (lines 73-83)
  found: attachTerminal is called with tryAttach() immediately (no deferral). fit() is deferred to the next rAF. This means the backend begins sending data BEFORE the first visual frame is painted. For SSH: the entire history replay completes (or begins) before the user sees any pixels. The xterm internal buffer processes everything, but the first visual frame shows the terminal already in its final replayed state. The user perceives this as "terminal appeared with old/stale content" rather than "terminal freshly rendered correct content."
  implication: The rAF deferral for fit() does NOT protect against seeing a "stale screen" — it only prevents the resize flash. The attach-before-first-paint pattern actually causes the "cached screen" symptom: the terminal is populated before the user sees it, so the first visible frame looks like the previous session.

- timestamp: 2026-04-08
  checked: ssh/session.rs spawn_remote_pty (lines 608-722) and SshPtyHandle definition (lines 32-38)
  found: history is Arc<tokio::sync::Mutex<Vec<String>>> — an unbounded Vec that accumulates every chunk since the session started. There is no cap, no trimming, no TTY scroll-buffer eviction. A long-running session could accumulate thousands of chunks. On attach, all are replayed from pos=0.
  implication: For long-running SSH sessions, the "cached screen" effect is more pronounced and takes longer to resolve because more history must be replayed. The terminal goes through all historical states before settling on the current one.

- timestamp: 2026-04-08
  checked: execution_handlers.rs detach_terminal (lines 547-556)
  found: The function body is literally just Ok(()). The comment says cleanup happens "when the channel is dropped." This means the previous session's reader task (for local PTY) continues to read from the PTY OS buffer and attempt to send to the old channel until the channel send fails. The channel fails when the frontend garbage-collects the old Channel object. JavaScript GC is non-deterministic — the old channel may not be collected for several event loop ticks, meaning the old tokio reader task may keep reading from the PTY and buffering output even after the React component unmounts. This consumed-but-discarded output reduces the OS PTY buffer, meaning when the NEW attach happens, fewer buffered bytes are present — but some may still be there.
  implication: There is a race between (a) old reader task draining the PTY buffer and (b) new Channel being created and attached. If the new attach happens before the old reader has fully drained, both readers compete for the same PTY OS data stream. This is a secondary issue but explains why local session "cached screen" may be inconsistent.

## Resolution

root_cause: |
  There are two distinct root causes, one per session type:

  ROOT CAUSE A — SSH Sessions (primary, most visible):
  attach_terminal for SSH sessions always replays the ENTIRE session history from pos=0 on every
  attach (execution_handlers.rs lines 224-250). This is intentional for state recovery but has
  the side effect of rapidly streaming hundreds of lines to a fresh xterm instance. Because
  attachTerminal() is called immediately on mount (before the first animation frame is painted),
  the history replay completes or progresses before the user sees any pixels. The first visible
  frame shows the terminal in the middle of (or at the end of) the historical replay — visually
  indistinguishable from "a cached/stale screen." The xterm cursor is positioned exactly where
  the session was at the time of the most recent chunk, giving the illusion the terminal froze on
  the previous session's state.

  ROOT CAUSE B — Local PTY Sessions (secondary, subtler):
  When a new TerminalComponent mounts, try_clone_reader() creates a new OS fd clone of the PTY
  master. The OS PTY kernel buffer holds the last written (but not fully consumed) bytes from the
  agent process. These are delivered in the first read() burst before any new output arrives.
  Additionally, detachTerminal() is a no-op, so the OLD session's tokio reader task may still
  be alive and consuming from the same PTY fd when the new reader starts — creating a brief
  race where both readers compete for the same bytes.

  CONTRIBUTING FACTOR — rAF timing gap:
  The rAF deferral for fit() was added to prevent a resize flash, but it creates a window where
  terminal data arrives and is processed by xterm's internal buffer BEFORE the first paint.
  The "cached screen" is therefore not a DOM artifact but xterm's correct rendering of replayed
  data that arrived pre-paint.

fix: [not yet applied — see Plan section]
verification: [pending]
files_changed: []

---

## Analysis

### What "cached screen" actually is

When the user switches sessions, React unmounts the old TerminalComponent and mounts a new one
(enforced by `key={terminalSessionId}`). There is no DOM bleed-through. The "cached screen" is
not leftover DOM from the previous session.

For SSH sessions: the fresh xterm immediately receives the FULL session history (all output since
the session started) as fast as Tauri IPC can deliver it. xterm processes escape sequences,
renders ANSI colors, moves the cursor — running through every historical screen state until it
reaches the current one. Since this all happens before the first animation frame (attach is called
before `requestAnimationFrame` for fit()), the first thing the user actually sees is the terminal
in its replayed state. This looks exactly like the previous session's screen — because it IS that
session's screen, reconstructed from history.

For local PTY sessions: the OS kernel PTY buffer holds recently produced bytes that no consumer
has yet read. On fresh attach, these arrive immediately as the first burst of data. This produces
a brief flash of "old output" — whatever the agent process was last outputting.

### Why this is hard to notice for short sessions but obvious for long ones

SSH sessions with lots of history (long-running agents) replay much more content. The terminal
may visibly scroll through screen states for 100–200ms before settling, which is very noticeable.
Short sessions with little history replay quickly and the effect is imperceptible.

### Is the rAF change the cause?

No. The rAF deferral was added to prevent a resize flash on mount. It does not cause the cached
screen — that symptom existed before because the SSH history replay and PTY buffer flush have
always happened immediately on attach. The rAF change may have made it more noticeable because
the correct layout is now set before the first paint (previously the terminal was still 80×24 and
would resize, distracting from the content).

---

## Plan

### Fix 1 — SSH: Show a loading state; delay attach until after first paint
**File:** `src/components/execution/Terminal.tsx`

The attach should not start until AFTER xterm has had a chance to render at the correct
size, so the user's first visible frame is the blank (correct) terminal — not mid-history-replay.

Change: move `tryAttach()` inside the `requestAnimationFrame` callback, after `fitAddon.fit()`.
This ensures: (1) size is set, (2) terminal is visually ready, (3) THEN history replay begins.
The user still sees history arriving rapidly, but from a blank terminal with the right dimensions.

```tsx
// In the rAF callback:
const rafId = requestAnimationFrame(() => {
  fitAddon.fit();
  tryAttach(); // moved here from outside the rAF
});
// Remove tryAttach() call that is currently outside the rAF
```

This does NOT eliminate the history replay — it just ensures the terminal is blank on first
paint rather than partially populated. The transition from blank → populated is perceptually
less jarring than "appeared with wrong content → corrected."

### Fix 2 — SSH: Limit history replay to the last N screen lines (tail replay)
**File:** `src-tauri/src/ipc/execution_handlers.rs` (attach_terminal, SSH path, lines 218-252)
**File:** `src-tauri/src/ssh/session.rs` (SshPtyHandle, spawn_remote_pty)

The root cause for SSH is that `pos = 0` — all history is always replayed.

Option A (lighter): Start pos at `max(0, chunks.len().saturating_sub(N))` for some N
(e.g. last 500 chunks). This skips old history and jumps to recent output.

Option B (better): Add a `scroll_buffer: Arc<Mutex<VecDeque<String>>>` with a fixed capacity
(e.g. 1000 chunks) to SshPtyHandle alongside the existing `history`. The scroll buffer acts
as a ring buffer: old chunks are evicted as new ones arrive. On attach, replay only the scroll
buffer contents instead of the full history. This bounds replay time regardless of session age.

Recommended: Option A first (minimal change), upgrade to Option B if needed.

```rust
// In attach_terminal SSH path:
let mut pos = {
    let chunks = history.lock().await;
    chunks.len().saturating_sub(500) // replay last 500 chunks max
};
```

Note: 500 chunks is intentionally generous. Each chunk is typically 1–20 bytes (a key press or
short output burst), so 500 chunks covers many screens of output while bounding replay time.

### Fix 3 — Local PTY: Implement a proper detach before new attach
**File:** `src-tauri/src/ipc/execution_handlers.rs` (detach_terminal, lines 547-556)
**File:** `src-tauri/src/db/connection.rs` (AppState)

The current `detach_terminal` is a no-op. The OLD reader task keeps running and may race with
the new reader.

Change: Add a per-session `attach_token: Arc<AtomicBool>` (or a cancellation channel) to
`AppState.pty_sessions` (or the PtySession itself). `attach_terminal` stores a cancel token
when it spawns its reader task. `detach_terminal` sets the cancel token, causing the old
reader task to exit at its next read iteration.

Minimal implementation:
```rust
// In AppState, add:
pub pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::watch::Sender<bool>>>>

// In attach_terminal local path: create a watch channel sender, store it, pass receiver to reader task
// In reader task: check receiver.has_changed() || *receiver.borrow() before each send

// In detach_terminal: look up cancel sender, send true
```

This ensures only ONE reader is active per PTY session at any time, eliminating the race.

### Fix 4 — Local PTY: Clear xterm before attaching (optional, cosmetic)
**File:** `src/components/execution/Terminal.tsx`

Before calling `tryAttach()`, write a clear-screen sequence to the fresh xterm:
```tsx
terminal.write('\x1b[2J\x1b[H'); // clear screen, cursor to home
```
This ensures the terminal shows a blank screen from the moment it's visible, regardless of
when the first real data arrives from the backend. This is a cosmetic guard — not a fix for
the underlying race, but it prevents any "garbage frame" from being visible.

### Fix 5 — SSH: Add a visual "connecting" indicator during history replay
**File:** `src/components/execution/Terminal.tsx`

The user should know the terminal is loading. Write a brief status line before attach:
```tsx
terminal.write('\x1b[2J\x1b[H'); // clear
terminal.write('\x1b[90mLoading session...\x1b[0m\r\n');
```
Then once history replay completes (not detectable from the frontend with current API),
the session content appears normally. This sets expectations that the terminal is actively
loading rather than showing stale content.

### Priority order

1. **Fix 1** (move tryAttach into rAF) — 3-line change, immediate improvement, zero risk.
2. **Fix 4** (clear-screen before attach) — 1-line change, cosmetic guard, zero risk.
3. **Fix 2 Option A** (tail-replay 500 chunks for SSH) — 2-line change in Rust, bounds replay time.
4. **Fix 5** (loading indicator) — polish, improves UX during replay.
5. **Fix 3** (proper detach for local PTY) — more invasive, needed to eliminate the race
   condition, but lower priority because local sessions don't have a history buffer
   and the race window is very short.
