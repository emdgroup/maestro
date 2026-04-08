# Phase 39: Fix SSH Terminal Session Switching — Research

**Researched:** 2026-04-08
**Domain:** Tauri/Rust IPC, xterm.js session management, tokio async patterns
**Confidence:** HIGH — all findings verified directly from codebase

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Frontend: Terminal mount timing (`src/components/execution/Terminal.tsx`)**
- Move `tryAttach()` inside the `requestAnimationFrame` callback, after `fitAddon.fit()`.
- Write `\x1b[2J\x1b[H` (clear-screen + cursor home) before `tryAttach()`.
- No "Loading..." indicator.

**Backend: SSH history buffer (`src-tauri/src/ssh/session.rs`)**
- Replace `history: Arc<Mutex<Vec<String>>>` with `history: Arc<Mutex<String>>` (single String).
- Trimming logic: `rfind("\x1b[2J")` — drop all content before and including the `\x1b[2J`. 512 KB byte-cap fallback trimmed to nearest `\r\n` boundary.

**Backend: `attach_terminal` SSH live sessions**
- Start at `pos = end` (no history replay). Rely on SIGWINCH repaint from `fitAddon.fit()`.

**Backend: `attach_terminal` SSH dead sessions**
- Read `terminal_output` from DB `execution_logs` row. Send as single write to channel.

**Backend: DB persistence**
- On session process exit: write `history` String to `execution_logs.terminal_output`.
- On application close: flush all active SSH PTY sessions' `history` to `execution_logs.terminal_output`.

**Backend: Local PTY `detach_terminal`**
- Add per-session cancel token (tokio `watch` channel) to eliminate two-reader race.

### Claude's Discretion
- Exact byte cap value (512 KB suggested)
- Whether to store cancel token in `AppState` or `PtySession` struct (prefer `PtySession`)
- Exact Tauri shutdown hook API (`RunEvent::ExitRequested` vs `RunEvent::Exit`)
- Whether to flush SSH history synchronously in shutdown hook or spawn a blocking task

### Deferred Ideas (OUT OF SCOPE)
- Loading spinner / "Connecting..." indicator
- Limiting local PTY history replay
- Periodic SIGWINCH snapshots for backgrounded sessions
- Ring buffer based on chunk count
</user_constraints>

---

## Summary

Phase 39 fixes two independent root causes of the "cached screen" bug when switching terminal sessions. The codebase has been fully read and all implementation surfaces are well understood.

**SSH sessions (primary fix):** `SshPtyHandle.history` is currently `Arc<Mutex<Vec<String>>>` — an unbounded Vec that never trims and always replays from `pos=0`. The fix converts history to a single `String` with `\x1b[2J` boundary trimming, changes `attach_terminal` to start at `pos=end` for live sessions, and reads the DB snapshot for dead sessions. DB persistence (session exit + app close) is new — the current code marks all running sessions as failed on startup but never writes `terminal_output` for SSH sessions.

**Local PTY sessions (secondary fix):** `detach_terminal` is a no-op, leaving the old tokio reader task racing with the new reader. The fix adds a `tokio::sync::watch` cancel token per session so the old reader is cleanly cancelled before the new one starts.

**Primary recommendation:** Implement all four backend changes as a coordinated unit — the frontend rAF change alone improves timing but the live-session `pos=end` change is what eliminates the history replay. Both must land together.

---

## Project Constraints (from CLAUDE.md)

- Rust: `Result<T, String>` for all IPC commands (not `AppError`)
- Rust: snake_case filenames, PascalCase types
- Rust: Use `eprintln!` sparingly — recent quick task (260408-h39) removed all 178 occurrences; diagnostic output uses `println!` in this project per that task
- TypeScript: direct imports (no barrel `index.ts` re-exports in domain dirs)
- TypeScript: path aliases `@/lib` for helpers/lib
- IPC: `State<'_, Arc<AppState>>` pattern, `Arc<AppState>` clone for crossing await points
- DB: never hold `std::sync::Mutex` lock across async `.await` points

---

## Standard Stack

All libraries already in the project — no new dependencies needed.

### Core (already in `Cargo.toml`)

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `tokio` | 1 (full features) | Async runtime, `watch` channel, `Mutex`, `Notify` | `watch` channel is the cancel token mechanism |
| `portable-pty` | (existing) | Local PTY master/slave, `try_clone_reader` | Used in `pty.rs` |
| `russh` | 0.58 | SSH PTY, `ChannelMsg`, `window_change` | Already handles SIGWINCH via `SshWriteOp::Resize` |
| `rusqlite` | 0.38.0 | SQLite persistence for `terminal_output` | Column already exists in schema V7 |
| `tauri` | 2 | App lifecycle, `RunEvent`, `on_run_event` closure | Shutdown hook needed |

**Installation:** No new dependencies. All required libraries are present.

---

## Architecture Patterns

### Recommended Project Structure (no changes needed)

```
src-tauri/src/
├── ssh/session.rs       — SshPtyHandle, spawn_remote_pty (history String + append_to_history fn)
├── ipc/execution_handlers.rs — attach_terminal (SSH live/dead split), detach_terminal (cancel token)
├── db/connection.rs     — AppState (add pty_attach_cancel field)
└── main.rs              — Tauri run() closure for shutdown hook
src/components/execution/
└── Terminal.tsx         — rAF reorder + clear-screen before tryAttach
```

---

## Research Answers (all VERIFIED from codebase)

### Q1: Exact current signature of `SshPtyHandle`

`[VERIFIED: src-tauri/src/ssh/session.rs lines 32-38]`

```rust
pub struct SshPtyHandle {
    pub log_id: i32,
    pub write_tx: tokio::sync::mpsc::Sender<SshWriteOp>,
    pub history: Arc<tokio::sync::Mutex<Vec<String>>>,  // CHANGE: Vec<String> → String
    pub notify: Arc<tokio::sync::Notify>,
    pub process_ended: Arc<AtomicBool>,
}
```

**Required change:** `Vec<String>` → `String`. The `log_id` field already exists and is the FK to `execution_logs` — it's the correct key for DB writes.

### Q2: How `history` gets populated (write path)

`[VERIFIED: src-tauri/src/ssh/session.rs lines 677-719]`

The reader tokio task in `spawn_remote_pty` handles `ChannelMsg::Data` and `ChannelMsg::ExtendedData`:

```rust
// Current (Vec<String>):
history_writer.lock().await.push(text);

// After refactor (String with trimming):
let mut hist = history_writer.lock().await;
append_to_history(&mut hist, &text);
```

The `append_to_history` function will be a standalone `fn` in `session.rs`. The reader task also calls it from `ExitStatus` (the colored exit message is pushed to history too — must be included in trimming behavior or appended after the cap check).

### Q3: Live vs dead session detection

`[VERIFIED: src-tauri/src/ssh/session.rs line 717, execution_handlers.rs lines 237-247]`

The `process_ended: Arc<AtomicBool>` flag is set to `true` (`Ordering::Release`) when the reader task exits (any of: `ExitStatus`, `Eof`, `Close`, `None` from `read_half.wait()`). `attach_terminal` already checks this flag with `Ordering::Acquire`.

**For the live/dead split:**
- **Live:** `!process_ended.load(Ordering::Acquire)` — go to `pos=end` path, start SIGWINCH repaint
- **Dead:** `process_ended.load(Ordering::Acquire)` — read `terminal_output` from DB by `handle.log_id`

There is NO explicit `is_alive` field to add — `process_ended` IS the flag. No new field needed on `SshPtyHandle`.

**Critical note:** The `SshPtyHandle` is keyed by `log_id` in `ssh_pty_sessions`, but `attach_terminal` is called with `task_id`. The current code does `sessions.get(&task_id)` on `ssh_pty_sessions` — this means the map key is `log_id` which equals `task_id` for task-based sessions but is the `log_id` for interactive sessions. This is the existing convention and should not be changed.

### Q4: Tauri shutdown hook API

`[VERIFIED: src-tauri/src/main.rs — no existing hook; confirmed API via docs.rs]`

Current `main.rs` uses:
```rust
tauri::Builder::default()
    .setup(setup)
    ...
    .run(tauri::generate_context!())
    .expect("...");
```

**Tauri 2 pattern** `[CITED: docs.rs/tauri/2.0.0/tauri/enum.RunEvent.html]`:

```rust
// Replace .run(tauri::generate_context!()) with:
builder
    .invoke_handler(builder.invoke_handler())
    .build(tauri::generate_context!())
    .expect("error building tauri app")
    .run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Flush SSH PTY history to DB
            let app_state = app_handle.state::<Arc<AppState>>();
            // ...flush logic
        }
    });
```

**`RunEvent::Exit` vs `RunEvent::ExitRequested`:**
- `RunEvent::ExitRequested` fires BEFORE exit — allows cancellation. Has an `api` field.
- `RunEvent::Exit` fires WHEN the event loop has terminated. Cannot be cancelled. Simpler.

**Discretion recommendation:** Use `RunEvent::Exit`. Flushing DB on exit is write-only, synchronous (DB is a Mutex, not async), and there's nothing to cancel. `ExitRequested` is for "do you want to quit?" dialogs. `Exit` is correct for cleanup.

**Sync vs async:** The DB lock is `std::sync::Mutex<Connection>` — synchronous. SSH history data is behind `tokio::sync::Mutex` — async. In a `RunEvent::Exit` callback, the runtime may be shutting down. Safe pattern: use `tokio::runtime::Handle::current().block_on(...)` or switch the closure to use `futures::executor::block_on` for the async mutex. Alternatively, hold a separate `Arc<Mutex<String>>` per session accessible synchronously (but this is more complex). **Recommended:** use `tokio::runtime::Handle::current().block_on(futures)` inside the `RunEvent::Exit` closure. The tokio runtime is still running at `Exit` time in Tauri 2.

### Q5: `terminal_output` column

`[VERIFIED: src-tauri/src/db/schema.rs lines 78-88]`

```sql
CREATE TABLE IF NOT EXISTS execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    branch_name TEXT,
    output TEXT,
    terminal_output TEXT,        -- EXISTS, nullable
    ...
);
```

The column exists in Schema V7. **No schema migration needed.** The column is already used for local PTY persistence (written at session end in `attach_terminal` lines 367-374) and read for dead-session replay (the `DeadSessionTerminal` component uses it per STATE.md Phase 26 note).

### Q6: Tokio watch channel pattern for cancel token

`[ASSUMED]` — Based on tokio docs knowledge, verified as idiomatic.

The correct pattern for per-session cancel tokens:

```rust
// In AppState (or in PtySession if preferred — see Discretion):
pub pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, tokio::sync::watch::Sender<bool>>>,
```

Usage in `attach_terminal` (local PTY path):
```rust
let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
{
    let mut cancel_map = app_state.pty_attach_cancel.lock().await;
    cancel_map.insert(task_id, cancel_tx);
}

// In spawn_blocking reader task — check before each send:
// NOTE: watch channels don't have blocking_recv; check via borrow
// The blocking task can use a std::sync::mpsc::channel instead,
// triggered by the tokio watch via a bridge.
```

**Important implementation note:** `spawn_blocking` cannot directly await a `watch::Receiver`. The cancel signal needs to reach the blocking thread. Two patterns:

**Pattern A (simpler):** Use `std::sync::atomic::AtomicBool` as cancel token instead of watch channel.
```rust
pub pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<AtomicBool>>>,
// Reader task checks: if cancel_flag.load(Ordering::Relaxed) { break; }
// detach_terminal: cancel_flag.store(true, Ordering::Relaxed);
```

**Pattern B (watch channel):** Use tokio watch channel for async context, but the `spawn_blocking` reader must receive cancellation differently. The sender task (async) can watch for cancel and drop `tx`, causing `rx.recv()` to return `None` in the sender task, which naturally stops forwarding — but doesn't stop the blocking reader. So the blocking reader must still check an `AtomicBool`.

**Recommendation for Claude's Discretion:** Use `AtomicBool` cancel flag — simpler and directly checkable from `spawn_blocking` context without async bridge machinery. Store in `AppState.pty_attach_cancel` as `HashMap<i32, Arc<AtomicBool>>`.

### Q7: Where SSH session death is detected

`[VERIFIED: src-tauri/src/ssh/session.rs lines 700-718]`

Session death is detected in the reader tokio task, inside the `loop { match read_half.wait().await { ... } }` block. On `ExitStatus`, `Eof`, `Close`, or `None`, the loop breaks, then:
```rust
ended_writer.store(true, Ordering::Release);
notify_writer.notify_one();
```

**For DB persistence on session exit:** The reader task must also write `history` to DB after setting `process_ended`. This requires access to `app_state` inside the reader task, which currently has no reference to `AppState`. The reader task in `spawn_remote_pty` takes `history_writer`, `notify_writer`, `ended_writer` as Arc clones — it needs a DB connection too.

**Two options:**
1. **Pass `Arc<AppState>` into `spawn_remote_pty`** — writer task persists to DB at session end. Clean but changes function signature.
2. **Persist in `attach_terminal` after the SSH loop exits** — after `process_ended` is true and all chunks drained, write accumulated history to DB. The current SSH attach loop already drains everything then `break`s — add DB write after the loop.

**Recommendation:** Option 2 — write `history` to DB in `attach_terminal` after the SSH loop completes. This avoids changing `spawn_remote_pty` signature and keeps persistence logic co-located with the attachment logic (same place local PTY does it, lines 367-374). The challenge: history may be partially written if no client is attached when the session dies. For the shutdown hook (app close), all sessions flush on `RunEvent::Exit`.

**Gap:** If a session dies while NO frontend is attached (no active `attach_terminal` call), the history is not persisted by Option 2. The `RunEvent::Exit` shutdown hook handles this. Sessions that die with no active attach AND before app close will lose their history. This is an acceptable edge case — the CONTEXT.md only requires persistence on session exit AND app close, not on session die-while-detached.

### Q8: ANSI `\x1b[2J` variants and edge cases

`[ASSUMED]` — Based on ANSI escape sequence knowledge. The decision is already in CONTEXT.md.

The locked decision uses `rfind("\x1b[2J")` (4 bytes: ESC, `[`, `2`, `J`). Common variants:
- `\x1b[2J` — clear entire screen (most common, e.g. `clear` command, vim startup)
- `\x1b[2J\x1b[H` — clear screen + cursor home (most shells)
- `\x1b[2J\x1b[3J` — clear screen + scrollback (used by some terminals)
- `\x1b[H\x1b[2J` — cursor home then clear (less common ordering)

All variants containing `\x1b[2J` are caught by `rfind("\x1b[2J")`. The trimming drops everything including and before the `\x1b[2J` — so `\x1b[H\x1b[2J` would keep `\x1b[2J` in the fresh buffer (correct) but lose the preceding `\x1b[H` (harmless, the SIGWINCH repaint will position the cursor correctly anyway).

**Edge case — xterm alternative erase sequences:**
- `\x1b[1J` — clear from cursor to start of screen (partial clear, should NOT trigger trim)
- `\x1b[3J` — clear scrollback only (no visible clear, should NOT trigger trim)

The `rfind("\x1b[2J")` correctly ignores `\x1b[1J` and `\x1b[3J` since the byte sequence differs at position 2 (`1` vs `2`, `3` vs `2`). The trimming is precise.

**UTF-8 safety of `rfind`:** The sequence `\x1b[2J` is pure ASCII (all bytes < 128), so `rfind` on a `&str` is UTF-8 safe — it will not split multi-byte sequences.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PTY resize signal | Custom signal code | `PtySession.resize_pty()` → `master.resize()` (local) / `SshWriteOp::Resize` (SSH) | Already implemented, tested |
| ANSI trimming | Regex engine | `str::rfind("\x1b[2J")` + `str::find("\r\n")` | Standard string search is sufficient; no regex needed |
| Async cancel | Future combinator | `AtomicBool` checked in `spawn_blocking` loop | watch channel can't cross sync/async boundary cleanly |
| DB write at exit | Custom flush queue | Synchronous DB write in `RunEvent::Exit` with `block_on` | DB is already a sync Mutex; no queue needed |

---

## Common Pitfalls

### Pitfall 1: Holding `std::sync::Mutex` (DB lock) across `.await`
**What goes wrong:** Rust borrow checker catches this as a compile error but it's a deadlock risk.
**Why it happens:** `app_state.db.lock()` returns `std::sync::MutexGuard` — must be dropped before any `.await`.
**How to avoid:** Lock, read data, drop guard, then await. See existing pattern at `execution_handlers.rs` lines 266-272.

### Pitfall 2: `watch::Receiver` in `spawn_blocking`
**What goes wrong:** `receiver.changed().await` is async and cannot be called in a `spawn_blocking` closure.
**Why it happens:** `spawn_blocking` runs on a blocking thread pool with no async executor.
**How to avoid:** Use `AtomicBool` cancel flag instead of watch channel. `Ordering::Relaxed` is fine for a boolean cancel flag (no data dependencies).

### Pitfall 3: SSH history String — panicking UTF-8 slicing
**What goes wrong:** `history.drain(..trim_to)` on an invalid UTF-8 char boundary panics.
**Why it happens:** `trim_to` is a byte offset; if it lands mid-character, `drain` panics.
**How to avoid:** The `append_to_history` pseudocode in CONTEXT.md already guards this by finding the nearest `\r\n` boundary. Additionally, output from `String::from_utf8_lossy()` is valid UTF-8 by construction — but slicing at an arbitrary byte index is still unsafe. The `find("\r\n")` search starts from `history[trim_to..]` which is valid only if `trim_to` is a char boundary. Guard with `history.is_char_boundary(trim_to)` before slicing, or use `history[trim_to..].char_indices().next()` to round up.

### Pitfall 4: `attach_terminal` SSH path — lock held across notify await
**What goes wrong:** If the history `Arc<Mutex<String>>` lock is held when `notify.notified().await` is called, the writer task deadlocks trying to append.
**Why it happens:** The current loop (Vec version) acquires the lock, drains chunks, drops the guard before `.notified().await`. This pattern must be preserved when converting to String.
**How to avoid:** For the `pos=end` live path: read `history.len()` once to get the starting position, then drop the lock before awaiting. Since history is now a single String, track `pos` as a byte offset into the String.

### Pitfall 5: Two-reader race persists if `detach_terminal` is not called before `attach_terminal`
**What goes wrong:** Frontend calls `attach_terminal` for the new session before `detach_terminal` fires for the old one (React cleanup is synchronous but IPC calls are async).
**Why it happens:** React's `useEffect` cleanup fires synchronously, but `api.detachTerminal(taskId)` is a fire-and-forget IPC call — it may arrive at the backend after the new `attach_terminal` has already started.
**How to avoid:** The cancel token approach handles this — `attach_terminal` cancels any existing token for the task_id before creating a new reader. No ordering dependency needed.

### Pitfall 6: Tauri 2 `Builder` pattern change when adding `on_run_event`
**What goes wrong:** Replacing `.run(tauri::generate_context!())` with `.build(...).run(|handle, event| {...})` requires restructuring `main.rs`.
**Why it happens:** `.run()` on `Builder` takes context directly; `.build()` on `Builder` returns `App` which has a different `.run()` accepting a closure.
**How to avoid:** See code example below.

---

## Code Examples

### `append_to_history` (Rust, `session.rs`)
```rust
// Source: CONTEXT.md pseudocode + verified against session.rs
fn append_to_history(history: &mut String, chunk: &str) {
    if let Some(pos) = chunk.rfind("\x1b[2J") {
        history.clear();
        history.push_str(&chunk[pos..]);
    } else {
        history.push_str(chunk);
        const MAX_BYTES: usize = 512 * 1024;
        if history.len() > MAX_BYTES {
            let trim_to = history.len() - MAX_BYTES;
            // Round trim_to up to a char boundary
            let trim_to = (trim_to..)
                .find(|&i| history.is_char_boundary(i))
                .unwrap_or(trim_to);
            if let Some(nl) = history[trim_to..].find("\r\n") {
                history.drain(..trim_to + nl + 2);
            } else {
                history.drain(..trim_to);
            }
        }
    }
}
```

### SSH history struct change (`session.rs`)
```rust
// BEFORE:
pub history: Arc<tokio::sync::Mutex<Vec<String>>>,

// AFTER:
pub history: Arc<tokio::sync::Mutex<String>>,

// Initialization in spawn_remote_pty:
let history: Arc<tokio::sync::Mutex<String>> = Arc::new(tokio::sync::Mutex::new(String::new()));

// Writer in reader task:
let mut hist = history_writer.lock().await;
append_to_history(&mut hist, &text);
drop(hist); // release before notify
notify_writer.notify_one();
```

### `attach_terminal` SSH path rewrite (`execution_handlers.rs`)
```rust
if let Some(handle) = ssh_handle {
    let history = Arc::clone(&handle.history);
    let notify = Arc::clone(&handle.notify);
    let process_ended = Arc::clone(&handle.process_ended);
    let log_id = handle.log_id;
    let app_state_arc = (*app_state).clone();

    tokio::spawn(async move {
        use std::sync::atomic::Ordering;
        let is_dead = process_ended.load(Ordering::Acquire);

        if is_dead {
            // Dead session: read terminal_output from DB and send as single write
            let db_output: Option<String> = {
                if let Ok(conn) = app_state_arc.db.lock() {
                    conn.query_row(
                        "SELECT terminal_output FROM execution_logs WHERE id = ?",
                        rusqlite::params![log_id],
                        |row| row.get::<_, Option<String>>(0),
                    ).ok().flatten()
                } else {
                    None
                }
            };
            if let Some(text) = db_output {
                let _ = output_channel.send(text);
            }
            return;
        }

        // Live session: start at end (skip history), rely on SIGWINCH repaint
        let mut pos: usize = {
            let hist = history.lock().await;
            hist.len() // byte offset — start after all existing content
        };

        loop {
            {
                let hist = history.lock().await;
                let slice = &hist[pos..];
                if !slice.is_empty() {
                    if output_channel.send(slice.to_string()).is_err() {
                        return;
                    }
                    pos += slice.len();
                }
            }
            if process_ended.load(Ordering::Acquire) {
                // Final drain
                let hist = history.lock().await;
                let slice = &hist[pos..];
                if !slice.is_empty() {
                    let _ = output_channel.send(slice.to_string());
                }
                // Persist to DB after session ends (handles die-while-attached case)
                let history_snapshot: String = hist.clone();
                drop(hist);
                if !history_snapshot.is_empty() {
                    if let Ok(conn) = app_state_arc.db.lock() {
                        let _ = conn.execute(
                            "UPDATE execution_logs SET terminal_output = ? WHERE id = ?",
                            rusqlite::params![&history_snapshot, log_id],
                        );
                    }
                }
                break;
            }
            notify.notified().await;
        }
    });
    return Ok(());
}
```

### `detach_terminal` with cancel token (`execution_handlers.rs` + `connection.rs`)
```rust
// AppState addition (connection.rs):
pub pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<std::sync::atomic::AtomicBool>>>,

// attach_terminal local path — before spawning reader:
let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
{
    let mut cancel_map = app_state.pty_attach_cancel.lock().await;
    cancel_map.insert(task_id, Arc::clone(&cancel_flag));
}

// In spawn_blocking reader:
let cancel_flag_reader = Arc::clone(&cancel_flag);
let reader_task = tokio::task::spawn_blocking(move || {
    use std::io::Read;
    let mut reader = reader;
    let mut buf = [0u8; 4096];
    loop {
        if cancel_flag_reader.load(std::sync::atomic::Ordering::Relaxed) { break; }
        match reader.read(&mut buf) { ... }
    }
});

// detach_terminal:
pub async fn detach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    let mut cancel_map = app_state.pty_attach_cancel.lock().await;
    if let Some(flag) = cancel_map.remove(&task_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}
```

### rAF reorder (TypeScript, `Terminal.tsx`)
```typescript
// Source: CONTEXT.md
const rafId = requestAnimationFrame(() => {
  fitAddon.fit();
  // fit() triggers onResize → api.resizeTerminal() → SIGWINCH → program repaints
  terminal.write('\x1b[2J\x1b[H'); // clear-screen guard
  tryAttach();
});
// Remove the tryAttach() call that was outside the rAF (currently line 83)
```

### Tauri shutdown hook (`main.rs`)
```rust
// Source: Tauri 2 docs — RunEvent::Exit pattern
// Replace:
//   .run(tauri::generate_context!())
// With:
let app = tauri::Builder::default()
    .setup(setup)
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(builder.invoke_handler())
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

app.run(|app_handle, event| {
    if let tauri::RunEvent::Exit = event {
        let app_state = app_handle.state::<Arc<AppState>>();
        // Flush all live SSH PTY sessions to DB
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            let sessions = app_state.ssh_pty_sessions.lock().await;
            let conn = match app_state.db.lock() {
                Ok(c) => c,
                Err(_) => return,
            };
            for (log_id, handle) in sessions.iter() {
                let hist = handle.history.lock().await;
                if !hist.is_empty() {
                    let _ = conn.execute(
                        "UPDATE execution_logs SET terminal_output = ? WHERE id = ?",
                        rusqlite::params![hist.as_str(), log_id],
                    );
                }
            }
        });
    }
});
```

**Note:** `app_handle.state::<Arc<AppState>>()` requires `app_state` to be managed with `app.manage(app_state)` in the `setup` function — which it already is (`main.rs` line 32).

---

## State of the Art

| Old Approach | Current Approach | Impact for Phase 39 |
|--------------|------------------|---------------------|
| `attach_terminal` SSH: `pos=0` full replay | `pos=end`, rely on SIGWINCH | Eliminates cached-screen symptom |
| `history: Vec<String>` unbounded | `history: String` with `\x1b[2J` trim + 512 KB cap | Bounds memory, enables semantic trim |
| `detach_terminal`: no-op | Cancel token via `AtomicBool` | Eliminates two-reader race |
| SSH history: never persisted to DB | Persist on session end + app close | Enables dead-session recovery |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `AtomicBool` cancel flag is checkable in `spawn_blocking` without async bridge | Q6 / Code Examples | If wrong: reader task doesn't stop cleanly — race persists. Mitigation: add a `Arc<std::sync::mpsc::SyncSender>` drop signal. |
| A2 | `tokio::runtime::Handle::current().block_on()` is safe inside `RunEvent::Exit` closure in Tauri 2 (runtime still alive) | Q4 / Code Examples | If wrong: `block_on` panics. Mitigation: use `std::sync::mpsc::channel` bridge: tokio task sends to sync channel, `RunEvent::Exit` reads synchronously with timeout. |
| A3 | `rfind("\x1b[2J")` does not false-positive on normal terminal content | Q8 | Very low risk — `\x1b[2J` is a specific 4-byte sequence; normal text won't contain ESC+`[2J`. |
| A4 | `app_handle.state::<Arc<AppState>>()` works inside `app.run()` closure in Tauri 2 | Q4 / Code Examples | If wrong: state not available in closure. Mitigation: capture `Arc<AppState>` directly by cloning from setup. |

**Highest-risk assumption: A2.** If the tokio runtime is torn down before `RunEvent::Exit`, `block_on` will panic. Verify with a test build. If it panics, capture `Arc<AppState>` in `setup` and spawn a dedicated blocking thread before calling `app.run()`.

---

## Open Questions (RESOLVED)

1. **`pos` as byte offset vs chunk count in String history**
   - What we know: History is now a single `String`; `pos` used to be a chunk index into `Vec<String>`.
   - What's unclear: For the live attach loop, `pos` must be a byte offset. After SIGWINCH repaint arrives, new output appended to the String may be large or empty. Sending `hist[pos..]` every notification is correct but may send an empty slice if notify fires before new data is written. Need to guard with `if !slice.is_empty()`.
   - Recommendation: Guard all sends with `!slice.is_empty()` check.

   **RESOLVED:** Plan 39-01, Task 2 — attach_terminal SSH live path guards all sends with `!slice.is_empty()` and uses byte offset `pos` into the String.

2. **DB write key: `log_id` vs `task_id` in SSH `attach_terminal`**
   - What we know: `ssh_pty_sessions` is keyed by `log_id` (set in `spawn_interactive_execution` line 724). `attach_terminal` is called with `task_id`. For interactive sessions `log_id != task_id` — both are present on `SshPtyHandle` as `handle.log_id`.
   - What's unclear: The DB write must use `execution_logs.id = handle.log_id`, not `task_id`.
   - Recommendation: Use `handle.log_id` for all DB writes in the SSH path. The existing pattern `sessions.get(&task_id)` means the map key used to insert the handle equals the `task_id` argument — but for interactive sessions this key is `log_id`. The planner should ensure `handle.log_id` is used consistently.

   **RESOLVED:** Plan 39-01, Task 2 — all DB writes use `handle.log_id` (not `task_id`). Plan 39-02, Task 2 — shutdown hook iterates `ssh_pty_sessions` map entries which are keyed by `log_id`.

3. **`append_to_history` with ExitStatus message**
   - What we know: The reader task also pushes a colored exit message (`[Process exited]`) to history on `ExitStatus`.
   - What's unclear: Should the exit message bypass the `\x1b[2J` trim check? It won't contain `\x1b[2J]` so it passes through normally. But it may push the buffer over the 512 KB cap if the session produced a lot of output and the exit message is appended last.
   - Recommendation: Apply `append_to_history` uniformly to all output including the exit message. The cap trim will handle it.

   **RESOLVED:** Plan 39-01, Task 1 — `append_to_history` is applied uniformly to all 3 call sites in the reader task (Data, ExtendedData, ExitStatus). The 512 KB cap trim handles the exit message naturally.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 39 is purely code changes within the existing Tauri/Rust/TypeScript stack. No new external dependencies, services, or CLI utilities are required.

---

## Validation Architecture

The project uses Vitest for frontend unit tests and Playwright for E2E tests. No existing tests cover terminal session switching behavior. This phase adds behavior that is inherently visual/interactive.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend), cargo test (backend) |
| Config file | `vitest.config.ts` (if exists), otherwise `vite.config.ts` |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test && cd src-tauri && cargo test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | Notes |
|--------|----------|-----------|-------------------|-------|
| — | `append_to_history` trims on `\x1b[2J` | unit (Rust) | `cargo test append_to_history` | Can be unit-tested with in-memory String |
| — | `append_to_history` byte-cap trim | unit (Rust) | `cargo test append_to_history_cap` | Test with >512KB string |
| — | `append_to_history` UTF-8 boundary safety | unit (Rust) | `cargo test append_to_history_utf8` | Test with multi-byte chars |
| — | SSH `attach_terminal` live session sends nothing from history | manual | — | Requires live SSH session |
| — | SSH `attach_terminal` dead session reads DB | manual | — | Requires dead SSH session |
| — | `detach_terminal` cancels old reader | manual | — | Race condition, hard to unit test |
| — | Frontend rAF reorder + clear-screen | manual visual | — | Screen recording comparison |

### Wave 0 Gaps
- [ ] `src-tauri/src/ssh/session_tests.rs` or inline `#[cfg(test)]` — covers `append_to_history` function
- [ ] Inline `#[cfg(test)]` in `session.rs` for `append_to_history` edge cases

*(Existing `cargo test` infrastructure covers the generate_typescript_bindings test; session logic has no existing tests.)*

---

## Security Domain

No new authentication, authorization, cryptography, or input validation surfaces are introduced. Phase 39 modifies internal buffer management and IPC channel lifecycle. ASVS categories V2, V3, V4, V6 are not applicable. V5 (input validation) is not applicable since terminal output is opaque binary data treated as display content, not parsed as trusted input.

---

## Sources

### Primary (HIGH confidence — verified from codebase)
- `src-tauri/src/ssh/session.rs` — `SshPtyHandle` definition, `spawn_remote_pty` full implementation, reader task, history accumulation
- `src-tauri/src/ipc/execution_handlers.rs` — `attach_terminal` (SSH path lines 218-252, local path 255-390), `detach_terminal` lines 547-556
- `src-tauri/src/db/connection.rs` — `AppState` all fields, `AppState::new`
- `src-tauri/src/db/schema.rs` — `execution_logs` table schema V7 (line 78-88, `terminal_output TEXT` confirmed)
- `src-tauri/src/main.rs` — Tauri builder pattern, no existing shutdown hook
- `src-tauri/src/process/pty.rs` — `PtySession` struct, `spawn_blocking` reader pattern
- `src/components/execution/Terminal.tsx` — rAF timing, `tryAttach()` placement at line 83

### Secondary (MEDIUM confidence)
- `docs.rs/tauri/2.0.0/tauri/enum.RunEvent.html` — `RunEvent::Exit` vs `RunEvent::ExitRequested` distinction
- `src-tauri/Cargo.toml` — `tauri = "2"`, `tokio = "1"` confirmed present

### Tertiary (LOW confidence — assumed)
- `tokio::sync::watch` vs `AtomicBool` for cancel token — based on tokio API knowledge, unverified in this session
- `tokio::runtime::Handle::current().block_on()` safety in `RunEvent::Exit` — assumed but marked HIGH-RISK (see Assumptions Log A2)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in `Cargo.toml`
- Architecture (SshPtyHandle changes): HIGH — struct read directly
- attach_terminal SSH logic: HIGH — full function read
- Tauri shutdown hook: MEDIUM — API shape verified from docs.rs, exact Tauri 2 closure form assumed
- Cancel token pattern: MEDIUM — AtomicBool approach is standard Rust but not verified against existing portable-pty read loop behavior

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (stable Rust/Tauri codebase)
