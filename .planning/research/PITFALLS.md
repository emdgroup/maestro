# Pitfalls Research

**Domain:** Adding Agents + Worktrees views; removing pool-based worktree system; xterm.js terminal; git diff in Rust; zombie worktree detection
**Researched:** 2026-03-29
**Confidence:** HIGH — all findings derived directly from codebase inspection of the live Rust and TypeScript source

---

## Critical Pitfalls

### Pitfall 1: Pool Removal Breaks `spawn_agent_execution` and `resume_agent_execution`

**What goes wrong:**

Both `spawn_agent_execution` (execution_handlers.rs:120) and `resume_agent_execution` (execution_handlers.rs:896) call `super::lease_worktree(...)` synchronously as step 2 of their background task setup. When you remove the pool, `lease_worktree` disappears entirely. Every call site that directly calls `lease_worktree` breaks at compile time, but more dangerously: any replacement on-demand creation that happens inside `spawn_agent_execution` needs to actually create a real git worktree on disk — the current stub path (worktree_handlers.rs:108: "TODO: Phase 4 - Invoke sidecar") just creates a DB record with a fake path and returns immediately. If you delete `lease_worktree` and replace it with real on-demand creation, that real creation must complete before the PTY is spawned, because the agent is immediately launched with `worktree_path` as its `cwd`. A non-existent directory causes PTY spawn failure.

**Why it happens:**

The pool system was designed so that real disk worktrees were lazily created "on first lease" (see worktree_handlers.rs:109 comment). In practice the TODO was never implemented — the path returned is `.worktree-pool/wt-001` which may not exist on disk. Removing the pool exposes this gap: the migration from pool to on-demand means you must implement the actual `git worktree add` before touching the execution flow.

**How to avoid:**

Implement on-demand worktree creation (real `git worktree add` via sidecar or `tokio::process::Command`) as a standalone, tested IPC command _before_ touching `spawn_agent_execution`. Replace the `lease_worktree` call site only after the new creation command is verified to produce a real directory. Keep `lease_worktree`'s signature as a shim during transition so the compile error surface is zero until you are ready.

**Warning signs:**

- PTY spawn fails with "No such file or directory" on the working directory path
- `spawn_agent_execution` returns `exec_log_id` but the execution log immediately shows "PTY spawning failed"
- Worktree DB record exists with `Leased` status but no corresponding filesystem path

**Phase to address:** The first backend phase (worktree backend overhaul). Must be complete and tested before any execution-related phase begins.

---

### Pitfall 2: Worktree Return Logic Must Be Removed, Not Just Bypassed

**What goes wrong:**

The finalization block at the end of `spawn_agent_execution`'s tokio::spawn closure (execution_handlers.rs:350-365) does `UPDATE worktrees SET status = 'Available'` after the agent finishes. With on-demand worktrees, there is no "return to pool" — the worktree must be deleted. If you remove `lease_worktree` but forget to update the finalization block, every completed execution will flip a deleted-or-nonexistent worktree back to `Available`, leaving a ghost DB row. The same pattern exists in `resume_agent_execution` (line 990-999).

The finalize path in `review_handlers.rs::finalize_successful_merge` correctly marks the worktree `Dirty` then deletes it. But the execution flow's finalization (non-merge path) does the wrong thing.

**Why it happens:**

There are two finalization paths: one at merge time (review_handlers.rs) and one at raw execution completion (execution_handlers.rs). They have different logic. The execution finalization was written for pool return; the merge finalization was written for cleanup. Removing the pool requires making both paths converge on cleanup.

**How to avoid:**

When replacing the pool, audit all locations that write `status = 'Available'` or call `return_worktree`. There are at least three: `return_worktree` IPC command, the finalization block in `spawn_agent_execution`, and the finalization block in `resume_agent_execution`. Replace each with on-demand delete logic (mark Dirty, run sidecar to remove worktree, delete DB row).

**Warning signs:**

- Worktrees table accumulates ghost rows with `Available` status that have no corresponding git worktree on disk
- `git worktree list` shows fewer worktrees than the DB shows

**Phase to address:** Same backend phase as Pitfall 1. Must be done atomically with the lease removal.

---

### Pitfall 3: `std::process::Command` Blocks the Tokio Runtime in Async IPC Handlers

**What goes wrong:**

`list_branches_local` (git/mod.rs:159) and `get_current_branch_local` (git/mod.rs:192) call `std::process::Command::new("git")` inside `async fn` bodies. `std::process::Command::output()` is a synchronous, blocking call. When called from within a tokio async context — which all `#[tauri::command]` handlers run in — this blocks the entire tokio worker thread for the duration of the git subprocess. Under Tauri 2's default multi-threaded runtime, this degrades concurrency. For git diff on large repositories (hundreds of changed files), the subprocess can take several seconds, effectively freezing all concurrent IPC for that duration.

The pattern appears again in any new git diff IPC that queries `git diff` for the Worktrees view. It is tempting to write the new `list_worktrees` or `get_worktree_diff` commands using `std::process::Command` for simplicity.

**Why it happens:**

`std::process::Command` is the obvious first choice for spawning subprocesses. The async equivalent (`tokio::process::Command`) is non-obvious and requires changing `.output()` to `.output().await`. The existing code in `review_handlers.rs` (line 97) correctly uses `tokio::process::Command` for the merge and diff sidecar calls — but the git dispatcher module was written with `std::process::Command` as a shortcut.

**How to avoid:**

All git subprocess calls in `async fn` contexts must use `tokio::process::Command`. For any new IPC command that computes git diffs (listing worktrees with diff stats, per-file diffs for the Worktrees view), use `tokio::process::Command::new("git").args([...]).output().await`. If you must use a synchronous API (e.g., `git2` crate), wrap it with `tokio::task::spawn_blocking(|| { ... }).await` to avoid blocking the async runtime.

**Warning signs:**

- All IPC calls become slow or appear to queue up when a diff is computing
- Tauri channel messages are delayed for seconds after a git diff is requested
- `tokio::runtime` thread count in profiler shows worker threads fully occupied

**Phase to address:** Any phase that adds git listing or git diff IPC for the Worktrees view backend.

---

### Pitfall 4: xterm.js Terminal Not Cleaned Up on React Component Unmount

**What goes wrong:**

xterm.js creates an internal DOM canvas, event listeners on `window` and `document`, and an internal render loop. If `Terminal.dispose()` is not called when the React component unmounts, these persist indefinitely. In a Tauri single-page application where the user navigates between Agents view and other tabs, the terminal component will mount and unmount repeatedly. Each mount creates a new `Terminal` instance; each unmount without `dispose()` leaks the old one. The Tauri channel attached to stream PTY output also keeps a background tokio task alive (see execution_handlers.rs:604-667) until the channel is detected as closed. If the React component unmounts without closing the channel, the streaming task continues writing to a dead channel silently (it returns `false` from `output_channel.send()` but doesn't error).

A second xterm.js issue: calling `terminal.open(containerRef.current)` in a `useEffect` that runs before the container has been measured results in a zero-height or zero-width terminal. xterm.js does not auto-resize on container resize unless `FitAddon` is explicitly loaded, fitted, and wired to a `ResizeObserver`. The terminal will render with the hardcoded 24-row × 80-column PTY size (process/pty.rs:85-92) and will not expand to fill the container.

**Why it happens:**

xterm.js is an imperative library that manages its own lifecycle. React's declarative model means the `Terminal` instance must be manually created in `useEffect` and manually destroyed in the cleanup function. Developers familiar with `<textarea>` or `<div>` elements forget that xterm.js has internal resource ownership that React cannot track.

The FitAddon omission happens because basic xterm.js demos work at a fixed size and the need for FitAddon only becomes apparent when the UI requires the terminal to fill a flexible container.

**How to avoid:**

Structure the terminal component with explicit lifecycle management:

```typescript
// The useEffect cleanup MUST call terminal.dispose()
useEffect(() => {
  const terminal = new Terminal({ ... });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(containerRef.current!);
  fitAddon.fit();

  const observer = new ResizeObserver(() => fitAddon.fit());
  observer.observe(containerRef.current!);

  // invoke attach_terminal with channel, store channel reference

  return () => {
    observer.disconnect();
    terminal.dispose();       // CRITICAL: releases canvas, event listeners
    // close the channel to stop the backend streaming task
  };
}, [taskId]);
```

Also call `resize_terminal` IPC after `fitAddon.fit()` to propagate the new dimensions to the PTY via SIGWINCH (resize_terminal IPC already exists at execution_handlers.rs:739).

**Warning signs:**

- Browser DevTools Memory tab shows accumulating `Terminal` instances that are never GC'd
- Multiple overlapping streams of PTY output (each attach creating a duplicate stream)
- Terminal renders at 80×24 but appears squashed inside a larger container
- Navigating away from the Agents view and back causes duplicate output lines

**Phase to address:** The Agents view frontend phase, in the initial component scaffold.

---

### Pitfall 5: Zombie Worktree Detection Race Between "No Task Linked" Check and Agent Startup

**What goes wrong:**

A "zombie" worktree detector that reads the worktrees table and checks whether an associated task is `InProgress` is inherently racy. The sequence is:

1. Frontend calls `spawn_agent_execution` for task T
2. `spawn_agent_execution` creates an execution log and leases/creates a worktree W (worktree W is now `Leased`)
3. Zombie detector runs concurrently, sees worktree W as `Leased` but the task is still `Ready` (status hasn't been transitioned to `InProgress` yet)
4. Detector flags W as zombie and schedules deletion

The existing worktree status machine is: `Available → Leased → InUse → Dirty → [deleted]`. The detector must respect this state machine. Checking only "no task is `InProgress` and worktree is `Leased`" is insufficient — `Leased` is a legitimate transient state during spawn setup.

An additional race: `cleanup_worktree` marks the worktree `Dirty` then calls a sidecar, then deletes the DB row. If the zombie detector runs between "Dirty" and "DB row deleted", it might try to delete an already-being-deleted worktree.

**Why it happens:**

The state machine transition from `Leased` to `InUse` is not currently implemented in the codebase (the `InUse` variant exists in the enum but nothing writes it). The zombie definition of "Leased but no running execution" is therefore ambiguous.

**How to avoid:**

Before implementing zombie detection:
1. Implement the `Leased → InUse` transition in `spawn_agent_execution` (set `InUse` when the PTY is successfully started, not when the lease is obtained).
2. Define zombie as: `status = 'Leased'` AND `leased_at` is more than N minutes ago (e.g. 10 minutes) AND no execution log with `status = 'running'` for the associated task. The time threshold prevents false positives during normal agent startup.
3. Never auto-delete zombies silently. Surface them in the UI as "stale" and require a user confirmation button to clean up.
4. For the `Dirty` state: the recovery function `recover_dirty_worktrees` already exists — do not re-implement zombie cleanup for `Dirty` worktrees; call the existing recovery path.

**Warning signs:**

- Active agent's worktree disappears from disk mid-execution
- Agent execution fails with "working directory not found" immediately after being marked `InProgress`
- Worktree DB row deleted but `git worktree list` still shows the path (incomplete cleanup)

**Phase to address:** The Worktrees view backend phase that adds zombie detection. The `Leased → InUse` transition must be implemented first.

---

### Pitfall 6: Attaching to a Dead PTY Session Must Not Crash the Tauri Channel

**What goes wrong:**

`attach_terminal` (execution_handlers.rs:562) looks up the task_id in `app_state.pty_sessions`. If the session doesn't exist, it returns `Err("No PTY session for task {}")`. This error travels back over the Tauri IPC channel as a rejected Promise in the frontend. If the frontend calls `attach_terminal` from within a `useEffect` that runs every time the Agents view renders (e.g., when the user clicks on a completed task), the error is expected — but if it is not caught, it surfaces as an unhandled Promise rejection.

More critically: `attach_terminal` opens a `tokio::spawn` that calls `try_clone_reader()` in a loop (execution_handlers.rs:614). If the PTY process has already exited, `try_clone_reader()` may return an error or immediately produce EOF. The loop exits cleanly, but the reader task and sender task spin up and immediately complete. This is not a crash but produces confusing behavior: the channel opens, sends nothing, and closes — which the frontend may interpret as a successful attach with an empty terminal.

For completed executions, the intended behavior is to show terminal history from the DB, not to attach to a live PTY. The `include_history: true` parameter handles this, but if `attach_terminal` is called without checking whether the task is still running first, you get a silent empty-terminal experience.

**Why it happens:**

The `pty_sessions` map in `AppState` only holds _live_ PTY sessions. It is populated when a PTY is spawned and is never persisted to the DB. After an app restart, or for tasks that finished in a previous session, the map is empty. The Agents view needs to distinguish "running" (attach to live PTY) from "finished" (render history from DB) before calling `attach_terminal`.

**How to avoid:**

In the Agents view frontend, check the `ExecutionLog.status` field before calling `attach_terminal`:
- `status = 'running'` → call `attach_terminal` with `include_history: true` (live stream + prepend history)
- `status = 'complete'` or `'failed'` → call `get_execution_logs` and render `terminal_output` directly into xterm.js via `terminal.write(historicalOutput)`. Do not call `attach_terminal` at all.

On the backend, `attach_terminal` should return an informative error (not a panic) when the session is not found, and the frontend should display a "Session ended" message rather than an empty terminal.

**Warning signs:**

- Clicking on a completed task in the Agents view shows a blank terminal instead of history
- Console shows unhandled Promise rejection from `attach_terminal`
- xterm.js renders but never receives any data for finished tasks

**Phase to address:** The Agents view frontend phase, in the terminal attach logic.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Keep `list_branches_local` using `std::process::Command` | Zero change to existing code | Blocks tokio worker thread on every branch list call in Worktrees view | Never — fix to `tokio::process::Command` in the same phase |
| Use DB worktree `path` column as sole source of truth for on-disk location | Simple — no extra lookup | Path can become stale if project is moved; `git worktree list` is authoritative | Never for deletion; always verify with `git worktree list` |
| Auto-delete zombie worktrees without UI confirmation | Fewer clicks for cleanup | Active agent worktree deleted during race; unrecoverable data loss | Never — require explicit user action |
| Skip `FitAddon` and use fixed 80x24 terminal size | Simpler initial implementation | Terminal looks wrong in any flex layout; hard to resize later | Only acceptable in first iteration if Agents view uses a fixed-size container |
| Render all execution logs in a flat list without pagination | Simpler query | With many completed tasks, the list becomes unusable | Acceptable for MVP if history is limited by newest-N query |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| xterm.js + Tauri channel | Open channel in `useEffect` without storing a reference for cleanup | Store the channel object returned from `Channel` constructor and close it in `useEffect` cleanup |
| xterm.js + FitAddon | Call `fitAddon.fit()` before `terminal.open()` | Always call `open()` first, then `fit()`, then observe for resize |
| Tauri `Channel<String>` + streaming | Assume channel is always open; ignore `send()` returning `false` | Check return value; exit background read loop when `send()` returns false (see execution_handlers.rs:649) |
| `tokio::process::Command` for git diff | Forgetting `.await` after `.output()` | Every subprocess call in async context must be `let out = cmd.output().await?` |
| git worktree + Dirty state recovery | Calling `recover_dirty_worktrees` only at project open | Also call it after any cleanup failure; the existing IPC command handles idempotent recovery |
| PTY resize + xterm.js FitAddon | Calling `resize_terminal` IPC but not `fitAddon.fit()`, or vice versa | Both must be called; FitAddon updates the DOM dimensions, `resize_terminal` updates the PTY kernel dimensions |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Polling execution status from frontend via `getExecutionLogs` | DB hammered by repeated queries; high CPU from SQLite lock contention | Use Tauri events (`emit`) from the backend when status changes; frontend only polls as fallback | At 3+ concurrent agents polling every second |
| Computing full git diff for every worktree row in the Worktrees view list | Page load takes seconds; UI freezes | Compute diff summary (changed file count) lazily on expand, not on list render | At 5+ worktrees with large diff surfaces |
| `terminal_output` stored as unbounded TEXT in `execution_logs` | DB file grows to GB; `get_execution_logs` slow | Cap terminal output at a reasonable limit (e.g. 500KB) in `append_output`; truncate from the front | After a long-running agent session (hours) |
| Loading all execution logs for all tasks in the Agents view at once | Agents view initial render slow | Query most-recent-N logs per task; use TanStack Query pagination | At 20+ completed tasks with long histories |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Constructing `git worktree add` command with unvalidated branch name from frontend | Command injection via branch name containing shell metacharacters | Pass branch name as a separate argument, never via shell string interpolation; use `tokio::process::Command::arg()` not `.arg(format!("...{}", branch_name))` |
| Exposing full PTY session output (including agent's API keys, secrets it might print) in `terminal_output` DB column | Secrets stored in plaintext in SQLite file | Consider filtering/redacting known secret patterns before persistence; at minimum, document that terminal output is persisted |
| Allowing zombie detection to delete worktrees based on DB state alone | Race condition deletes active worktree | Always verify with `git worktree list` before deletion; DB state is a hint, not ground truth |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing "No session found" error as a toast when user clicks completed task | User confused — they just wanted to see what the agent did | Silently fall back to history rendering; no error visible |
| Zombie worktree cleanup auto-runs on project open without warning | User's in-progress agent wiped if detection has a false positive | Show zombies in Worktrees view with a manual "Clean up" button; never auto-delete |
| Terminal renders at wrong size on first mount | Text wraps incorrectly; diff output misaligned | Call `fitAddon.fit()` + `resize_terminal` IPC in a `useLayoutEffect` after the container is sized |
| Worktrees view listing outdated DB state (not reflecting real git worktree list) | User sees worktrees that don't exist, or misses worktrees that do | Always read from `git worktree list` (via IPC) as the authoritative source; DB is a cache |

---

## "Looks Done But Isn't" Checklist

- [ ] **On-demand worktree creation:** The DB record exists with a valid path — verify the directory actually exists on disk with `std::fs::metadata` or `git worktree list` before marking the task `InProgress`
- [ ] **Pool removal:** Search for all callers of `lease_worktree`, `return_worktree`, `initialize_worktree_pool`, and `get_pool_status` — each must be removed or replaced, not just the primary path
- [ ] **xterm.js cleanup:** Verify `Terminal.dispose()` is called by adding a console.log in the cleanup and navigating away from the Agents view; check DevTools Memory heap snapshot for lingering `Terminal` instances
- [ ] **PTY resize propagation:** After attaching to a terminal, resize the browser window and verify the agent's output wraps correctly — the FitAddon + `resize_terminal` IPC path is only wired if both are present
- [ ] **Completed task terminal history:** Click a task in `Done` status in the Agents view and confirm terminal history renders — not an empty terminal and not an error toast
- [ ] **Zombie detection threshold:** Confirm a worktree that has been `Leased` for 9 minutes (a slow agent startup) is NOT flagged as a zombie; only test with a worktree abandoned for longer than the threshold

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Pool removal broke `spawn_agent_execution` | MEDIUM | Revert worktree_handlers.rs to stub `lease_worktree` that creates a real directory; fix execution flow next iteration |
| Return-to-pool logic left in after pool removal, ghost rows accumulate | LOW | Run `DELETE FROM worktrees WHERE status = 'Available' AND path NOT IN (SELECT path FROM git worktree list output)` to purge ghosts |
| xterm.js memory leak from missing dispose() | LOW | Add dispose() in useEffect cleanup; reload app to clear existing leaks |
| Zombie detector deleted active worktree | HIGH | Restore from `git reflog` if commits exist on the branch; otherwise task must be re-executed from scratch |
| `std::process::Command` blocking tokio causing IPC queue buildup | MEDIUM | Replace with `tokio::process::Command`; restart app to clear blocked runtime threads |
| Attach to dead PTY causes blank terminal | LOW | Check `ExecutionLog.status` before calling `attach_terminal`; render DB history for non-running executions |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Pool removal breaks spawn_agent_execution | Backend: on-demand worktree creation phase | `spawn_agent_execution` creates a real directory; agent PTY starts successfully |
| Return-to-pool logic left in | Backend: on-demand worktree creation phase | No `Available` worktrees in DB after task completion; rows are deleted |
| `std::process::Command` blocks tokio | Backend: worktree listing / git diff IPC phase | All new git subprocess calls use `tokio::process::Command`; no `std::process::Command` in async fns |
| xterm.js not disposed on unmount | Frontend: Agents view terminal component phase | Navigate away and back 5 times; DevTools Memory heap has no accumulation of Terminal objects |
| Zombie detection race condition | Backend: Worktrees view zombie detection phase | `Leased` worktrees with leased_at < threshold AND no running exec log are detected; no false positives on active agents |
| Attach to dead PTY session | Frontend: Agents view terminal attach logic | Clicking completed task shows history; no error toast; no blank terminal |

---

## Sources

- **Codebase inspection (HIGH confidence):** `src-tauri/src/ipc/worktree_handlers.rs` — pool constants, `lease_worktree`, `initialize_worktree_pool`, `cleanup_worktree`, `recover_dirty_worktrees`
- **Codebase inspection (HIGH confidence):** `src-tauri/src/ipc/execution_handlers.rs` — `spawn_agent_execution` (lines 120-122 lease call; lines 350-365 return-to-pool finalization), `attach_terminal` (lines 562-671), `resize_terminal`, `resume_agent_execution` (line 896 lease call; lines 990-999 return-to-pool)
- **Codebase inspection (HIGH confidence):** `src-tauri/src/git/mod.rs` — `std::process::Command` in `list_branches_local` and `get_current_branch_local` (async context violation); correct `tokio::process::Command` in `review_handlers.rs`
- **Codebase inspection (HIGH confidence):** `src-tauri/src/process/pty.rs` — hardcoded `PtySize { rows: 24, cols: 80 }` on spawn; `try_clone_reader()` loop in attach_terminal
- **Codebase inspection (HIGH confidence):** `src-tauri/src/db/connection.rs` — `pty_sessions: tokio::sync::Mutex<HashMap<i32, ...>>` is in-memory only; not persisted across restarts
- **xterm.js documentation (MEDIUM confidence — training data, not verified via Context7):** `Terminal.dispose()` required for cleanup; `FitAddon` required for dynamic sizing; `ResizeObserver` pattern for container resize

---
*Pitfalls research for: Maestro v1.3 — Agents & Worktrees milestone*
*Researched: 2026-03-29*
