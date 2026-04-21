# Phase 40: SSH Disconnection Handling — Research

**Researched:** 2026-04-10
**Domain:** Rust SSH (russh 0.60), Tauri 2 event system, React connection health UX
**Confidence:** HIGH

## Summary

Phase 40 adds resilience to SSH connections: keepalive to prevent idle disconnects, heartbeat detection to notice when the connection has silently dropped, exponential backoff reconnection, a blocking full-screen UI backdrop during reconnection, PTY session cleanup when SSH is lost, and Tauri event emission so the frontend can react to connection state changes.

The project already has nearly all building blocks in place. `russh::client::Config` has `keepalive_interval` and `keepalive_max` fields that are unused today. `SshConnectionState` already has a `Reconnecting` variant and `reconnect_if_needed()` has an exponential-backoff loop. `is_transient_error()` exists in `ssh/error.rs`. `AppHandle::emit()` is available via `tauri::Emitter`. The only missing pieces are: wiring keepalive into `open_handle()`, a background heartbeat task per connection, event emission from the backend on state transitions, a new `useConnectionHealth` hook on the frontend, and a `DisconnectBackdrop` component.

**Primary recommendation:** Add `AppHandle` to `AppState`, add a heartbeat task loop in `RemoteSshSession` that emits Tauri events, and add a frontend hook + overlay component that listens to those events.

## Project Constraints (from CLAUDE.md)

No CONTEXT.md exists for Phase 40. Constraints come from CLAUDE.md and codebase conventions.

- All Rust IPC commands return `Result<T, String>`
- No `println!` / `eprintln!` in Rust backend (removed in quick-task 260408-h39)
- Direct imports only — no barrel `index.ts` re-exports
- Zustand with Immer middleware for new stores
- Rust: snake_case functions, PascalCase types
- TypeScript: camelCase functions, PascalCase components
- `pnpm tauri:gen` must be run after any Rust model or IPC command changes
- SSH scope only — local PTY sessions are unaffected by this phase

## Standard Stack

### Core (already in project)

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| russh | 0.60.0 | SSH client | `client::Config.keepalive_interval` + `keepalive_max` available [VERIFIED: docs.rs] |
| tauri | 2 | Desktop framework | `AppHandle::emit()` via `tauri::Emitter` trait [VERIFIED: docs.rs] |
| tokio | 1 (full) | Async runtime | `tokio::time::interval` for heartbeat task |
| @tauri-apps/api | ^2.10.1 | Frontend Tauri bindings | `listen()` from `@tauri-apps/api/event` [VERIFIED: package.json] |

### Supporting (already in project)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Zustand | (existing) | Frontend state | Connection health state store or hook state |
| React | 19 | UI | `DisconnectBackdrop` component |
| Tailwind CSS 4 | (existing) | Styling | Full-screen overlay classes |

### Installation

No new dependencies needed. All required libraries are already in `Cargo.toml` and `package.json`.

## Architecture Patterns

### Recommended Structure

```
src-tauri/src/ssh/
├── session.rs          — Add: AppHandle field to RemoteSshSession, keepalive config, heartbeat task
├── error.rs            — No change (is_transient_error already correct)
└── mod.rs              — Re-export any new types (SshHealthEvent if defined as struct)

src/
├── components/common/
│   └── DisconnectBackdrop.tsx     — New: full-screen blocking overlay
├── utils/hooks/
│   └── useConnectionHealth.ts     — New: Tauri event listener + connection state
└── App.tsx                        — Mount DisconnectBackdrop when project is SSH
```

### Pattern 1: russh Keepalive Configuration

**What:** Configure `client::Config` with keepalive before opening the TCP/SSH handle.
**When to use:** In `open_handle()` — the single place where `client::connect()` is called.

```rust
// Source: docs.rs/russh/0.60.0/russh/client/struct.Config.html [VERIFIED]
async fn open_handle(host: &str, port: u16) -> Result<Handle<SshClientHandler>, SshError> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),  // ADD: send keepalive every 30s
        keepalive_max: 3,                                    // ADD: close after 3 missed replies
        ..Default::default()
    });
    client::connect(config, format!("{}:{}", host, port).as_str(), SshClientHandler)
        .await
        .map_err(|e| SshError::ConnectionError(format!("Failed to connect to {}:{}: {}", host, port, e)))
}
```

The `keepalive_interval` causes russh to send SSH_MSG_GLOBAL_REQUEST (`keepalive@openssh.com`) whenever that duration passes with no data from the server. `keepalive_max` sets the number of unanswered keepalives before russh closes the connection internally. [VERIFIED: docs.rs/russh/0.60.0]

### Pattern 2: Background Heartbeat Task

**What:** A tokio task spawned per SSH connection that polls connection liveness with a null command and emits Tauri events on state transitions.
**When to use:** Spawn after successful `connect()` / `connect_with_key()` in `RemoteSshSession`.

The russh keepalive prevents *idle* disconnects but does not proactively detect *already-dead* connections — execute_command on a dead handle will block until the TCP timeout fires. A heartbeat task that periodically runs a no-cost SSH command (e.g., `true`) and checks the result detects dropped connections much faster.

```rust
// Source: [ASSUMED] — pattern derived from existing reconnect_if_needed() in session.rs
fn spawn_heartbeat_task(
    session: RemoteSshSession,   // Clone — RemoteSshSession is Clone
    app_handle: tauri::AppHandle,
    connection_id: i32,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let state = session.get_state().await;
            if state == SshConnectionState::Disconnected {
                break; // Explicit disconnect — stop heartbeat
            }
            // Probe: lightweight SSH command
            match session.execute_command("true").await {
                Ok(_) => {} // Still alive
                Err(e) if is_transient_error_str(&e.to_string()) => {
                    // Connection lost — begin exponential backoff reconnect
                    let _ = app_handle.emit("ssh-connection-lost", connection_id);
                    // reconnect loop (see Pattern 3)
                }
                Err(_) => {} // Permanent error (auth) — don't retry
            }
        }
    });
}
```

Note: `is_transient_error()` in `ssh/error.rs` takes `&SshError` not `&str`. The heartbeat needs to map the string error back, or `execute_command` needs to return `SshError` directly. The cleanest approach is to make `execute_command` return `Result<String, SshError>` in the heartbeat path, or keep a parallel private version.

### Pattern 3: Tauri Event Emission

**What:** Emit named events from Rust async contexts using `AppHandle`.
**When to use:** On connection state transitions (lost, reconnecting, reconnected).

`AppHandle` implements `Send + Sync + Clone` and can be stored in `AppState` or passed into tasks. [VERIFIED: docs.rs/tauri/2.0.0]

```rust
// Source: docs.rs/tauri/2.0.0/tauri/struct.AppHandle.html [VERIFIED]
use tauri::Emitter;

// Emit on connection lost
app_handle.emit("ssh-connection-lost", connection_id).ok();

// Emit on reconnect attempt N
app_handle.emit("ssh-reconnecting", SshReconnectingPayload {
    connection_id,
    attempt: 1,
    max_attempts: 5,
}).ok();

// Emit on reconnect success
app_handle.emit("ssh-reconnected", connection_id).ok();
```

Event payloads must be `Serialize + Clone`. Simple types (`i32`) or dedicated structs work. `.ok()` suppresses the `Result` — no frontend listeners registered yet is not an error.

### Pattern 4: Storing AppHandle in AppState

**What:** Add `AppHandle` to `AppState` so heartbeat tasks spawned from IPC handlers can emit events.
**When to use:** `AppState::new()` must accept a `tauri::AppHandle`, stored as a field.

```rust
// Extending connection.rs AppState
pub struct AppState {
    pub db: Mutex<Connection>,
    pub app_handle: tauri::AppHandle,  // ADD: for event emission
    // ... existing fields
}
```

In `main.rs` `setup()`:
```rust
let app_state = Arc::new(AppState::new(conn, app.handle().clone()));
```

`app.handle()` returns a `tauri::AppHandle` from inside the setup closure. [VERIFIED: docs.rs/tauri]

### Pattern 5: Frontend Event Listener Hook

**What:** A React hook that subscribes to Tauri events and exposes connection health state.
**When to use:** Mount in `App.tsx` when `currentProject.connection_id` is not null.

```typescript
// Source: [VERIFIED: v2.tauri.app] — listen() from @tauri-apps/api/event
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

type ConnectionHealthState = "connected" | "lost" | "reconnecting" | "failed";

export function useConnectionHealth(connectionId: number | null) {
  const [state, setState] = useState<ConnectionHealthState>("connected");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!connectionId) return;

    const unlisten = Promise.all([
      listen("ssh-connection-lost", (e) => {
        if (e.payload === connectionId) setState("lost");
      }),
      listen("ssh-reconnecting", (e: any) => {
        if (e.payload.connection_id === connectionId) {
          setState("reconnecting");
          setAttempt(e.payload.attempt);
        }
      }),
      listen("ssh-reconnected", (e) => {
        if (e.payload === connectionId) setState("connected");
      }),
    ]);

    return () => {
      unlisten.then(([u1, u2, u3]) => { u1(); u2(); u3(); });
    };
  }, [connectionId]);

  return { state, attempt };
}
```

The `listen()` function returns `Promise<UnlistenFn>`. The cleanup pattern shown above (collect unlisteners in a Promise.all, call them in the cleanup) is the standard Tauri 2 pattern. [VERIFIED: v2.tauri.app/develop/calling-rust]

### Pattern 6: DisconnectBackdrop Component

**What:** Full-screen fixed overlay that blocks interaction when SSH is disconnected.
**When to use:** Render conditionally in `App.tsx` on the SSH project branch.

```tsx
// DisconnectBackdrop.tsx
interface DisconnectBackdropProps {
  state: "lost" | "reconnecting";
  attempt?: number;
  maxAttempts?: number;
}

export function DisconnectBackdrop({ state, attempt = 0, maxAttempts = 5 }: DisconnectBackdropProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm">
      <p className="text-sm font-medium">
        {state === "lost" ? "SSH connection lost" : `Reconnecting… (${attempt}/${maxAttempts})`}
      </p>
    </div>
  );
}
```

The `z-50` ensures it sits above all other content. `backdrop-blur-sm` provides visual depth. `fixed inset-0` covers the full viewport.

### Pattern 7: PTY Session Cleanup on Connection Loss

**What:** When a connection is detected as lost, mark all SSH PTY sessions for that connection as `failed` in the DB.
**When to use:** In the heartbeat reconnect loop, after `ssh-connection-lost` is emitted, before beginning retries.

The `ssh_pty_sessions` map is keyed by `log_id`. Each `SshPtyHandle` has a `log_id`. To find which PTY sessions belong to a given `connection_id`, the heartbeat task needs access to the project-to-connection mapping.

Implementation approach: Iterate `ssh_pty_sessions`, and for each handle, check if the underlying SSH connection (by `connection_id`) is the lost one. Since PTY sessions are spawned from a specific `connection_id`, the heartbeat task can hold a reference to the `connection_id` and mark all currently-running executions for that connection as failed via DB update.

```rust
// Mark SSH PTY sessions as failed — run inside the heartbeat task on connection loss
if let Ok(conn) = app_state.db.lock() {
    let now = chrono::Utc::now().to_rfc3339();
    // Set all running execution logs that were started under this connection to failed.
    // Execution logs don't store connection_id directly — use the join through projects table.
    let _ = conn.execute(
        "UPDATE execution_logs SET status = 'failed', completed_at = ?1, \
         error_event = json_object('error_type', 'ssh_connection_lost', \
                                   'message', 'SSH connection lost', \
                                   'suggestions', json_array(), \
                                   'detected_at', ?1) \
         WHERE status = 'running' AND id IN (
             SELECT el.id FROM execution_logs el
             INNER JOIN tasks t ON t.id = el.task_id
             INNER JOIN projects p ON p.id = t.project_id
             WHERE p.connection_id = ?2
             UNION
             SELECT el2.id FROM execution_logs el2
             WHERE el2.task_id IS NULL AND el2.status = 'running'
             -- Interactive sessions (no task_id) would need connection tracking
         )",
        rusqlite::params![&now, connection_id],
    );
}
```

Note: The interactive session path (no task_id) is harder to scope — interactive PTY sessions don't have a `project_id` via `task_id`. The simplest approach for interactive sessions: since they always use a specific SSH session, the heartbeat task can also remove their entries from `ssh_pty_sessions` and mark them failed.

### Anti-Patterns to Avoid

- **Calling `reconnect_if_needed()` from the heartbeat on every tick:** `reconnect_if_needed()` is designed for inline reconnect-on-demand. The heartbeat should only call it when a failure is detected, not on every tick.
- **Blocking the tokio runtime with `std::sync::Mutex::lock()` across await points:** The shutdown hook in `main.rs` uses `try_lock()` specifically to avoid this. Heartbeat tasks are async — use `tokio::sync::Mutex` for anything awaited.
- **Storing `State<'_, Arc<AppState>>` instead of `Arc<AppState>`:** Tauri's `State<'_>` can't be stored long-term. Always extract `(*app_state).clone()` before spawning a task (existing pattern throughout the codebase).
- **Not unregistering Tauri event listeners on component unmount:** Always return the unlisten function from `useEffect`. Stale listeners cause memory leaks and double-fire events on remount.
- **Using `println!` in Rust:** Removed in quick-task 260408-h39. No `println!` or `eprintln!` in any Rust files.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSH keepalive | Custom TCP ping task | `russh::client::Config.keepalive_interval` | russh sends SSH_MSG_GLOBAL_REQUEST natively; custom TCP ping misses SSH-layer keepalive |
| Exponential backoff | Custom delay loop | Existing `reconnect_if_needed()` + `reconnect_attempts` AtomicUsize | Already implemented in `RemoteSshSession` |
| Frontend event listen | polling `get_ssh_connection_status` | `listen()` from `@tauri-apps/api/event` | Push is cheaper than poll; Tauri events fire immediately on state change |
| Overlay z-index management | Custom CSS | Tailwind `z-50 fixed inset-0` | Standard Tailwind approach already used in project |

**Key insight:** russh's keepalive handles the idle-timeout prevention automatically once configured. The heartbeat task is needed only for *detecting* already-lost connections (where the TCP session silently dropped without a FIN/RST).

## Common Pitfalls

### Pitfall 1: `SshError` vs `String` in execute_command
**What goes wrong:** `execute_command()` returns `Result<String, SshError>`, but it's called internally via `reconnect_if_needed()` which returns `Result<(), SshError>`. The heartbeat needs to distinguish transient (connection) from permanent (auth) errors. `is_transient_error()` takes `&SshError` but the heartbeat may only have a `String` error if it goes through a different code path.
**Why it happens:** The execute_command API was designed for IPC callers who get `String` errors. The heartbeat task needs structured errors.
**How to avoid:** Give the heartbeat task access to the `RemoteSshSession.execute_command()` directly (returns `Result<String, SshError>`). The heartbeat can then call `is_transient_error()` on the `SshError` variant.
**Warning signs:** `is_transient_error` is never called in the heartbeat path → all errors treated the same.

### Pitfall 2: Heartbeat Task Keeps Firing After Explicit Disconnect
**What goes wrong:** If the user manually disconnects (calls `session.disconnect()`), the heartbeat task sees `SshConnectionState::Disconnected`, tries to reconnect, and fights the explicit disconnect.
**Why it happens:** `reconnect_if_needed()` handles `Disconnected` by reconnecting. The heartbeat doesn't check if disconnect was intentional.
**How to avoid:** Add a separate `cancelled: Arc<AtomicBool>` flag to the heartbeat task, or check that `state == Disconnected` before probing and treat it as a stop signal. Alternatively, check that the connection_id is still in `app_state.ssh_sessions` before each heartbeat tick.
**Warning signs:** Reconnect events fire after the user has navigated away from an SSH project.

### Pitfall 3: AppHandle in AppState — Setup Order
**What goes wrong:** `AppState::new()` is called inside `setup()`, which runs before the full Tauri app is built. `app.handle()` must be called inside `setup()`, not before.
**Why it happens:** The `tauri::Builder` hasn't produced a runnable app yet when `setup()` is called; however, `app.handle()` is available inside the setup closure because it returns an `AppHandle` bound to the app being set up.
**How to avoid:** Pass `app.handle().clone()` to `AppState::new()` inside the `setup` function, not in `main()` before `.setup()`.
**Warning signs:** Compile error "cannot move out of borrowed content" or runtime panic on `app_handle` access before app is initialized.

### Pitfall 4: Tauri Event Listener Not Unregistered
**What goes wrong:** `useConnectionHealth` registers a listener on mount but the component unmounts (e.g., user switches to local project). The listener remains active and fires for the next SSH project, causing state updates on an unmounted component.
**Why it happens:** `listen()` returns a `Promise<UnlistenFn>`. If the `useEffect` cleanup doesn't await and call the unlisten function, the listener persists.
**How to avoid:** The cleanup function in `useEffect` must call the unlisten functions from the Promise. The pattern `unlisten.then(fns => fns.forEach(f => f()))` works correctly.
**Warning signs:** "Can't perform a state update on an unmounted component" React warning.

### Pitfall 5: Interactive PTY Session Cleanup Requires Separate Tracking
**What goes wrong:** Interactive PTY sessions (`task_id IS NULL`) created via `spawn_interactive_execution` don't link to a `project_id` in the DB. The SQL UPDATE to mark sessions failed by `connection_id` won't find them via a `tasks` JOIN.
**Why it happens:** The schema decision from Phase 30 made `execution_logs.task_id` nullable to support interactive sessions. No `connection_id` column was added.
**How to avoid:** The heartbeat task already knows which `connection_id` lost. It can iterate `app_state.ssh_pty_sessions`, remove them from the map, and mark their `log_id`s failed directly — bypassing the JOIN entirely.
**Warning signs:** Interactive sessions still show as "running" in the Agents view after SSH connection loss.

### Pitfall 6: Reconnect Backdrop Shown for Local Projects
**What goes wrong:** `DisconnectBackdrop` is rendered regardless of whether the current project is SSH or local.
**Why it happens:** The `connection_id` check is missed or `useConnectionHealth` is called with `null` connectionId but still renders the backdrop.
**How to avoid:** Only render `DisconnectBackdrop` when `currentProject.connection_id !== null` AND the health state is `"lost"` or `"reconnecting"`.
**Warning signs:** Backdrop appears when switching to a local project.

## Code Examples

### russh::client::Config with Keepalive

```rust
// Source: docs.rs/russh/0.60.0/russh/client/struct.Config.html [VERIFIED]
use std::time::Duration;
use russh::client;

let config = Arc::new(client::Config {
    inactivity_timeout: Some(Duration::from_secs(300)),
    keepalive_interval: Some(Duration::from_secs(30)),
    keepalive_max: 3,
    ..Default::default()
});
```

### AppHandle::emit() in Tauri 2

```rust
// Source: docs.rs/tauri/2.0.0/tauri/struct.AppHandle.html [VERIFIED]
use tauri::Emitter;

// Simple payload (connection_id as i32)
app_handle.emit("ssh-connection-lost", connection_id).ok();

// Struct payload (must derive Serialize + Clone)
#[derive(Clone, Serialize)]
struct ReconnectingPayload {
    connection_id: i32,
    attempt: usize,
    max_attempts: usize,
}
app_handle.emit("ssh-reconnecting", ReconnectingPayload { connection_id, attempt: 1, max_attempts: 5 }).ok();
```

### Frontend listen() with cleanup

```typescript
// Source: v2.tauri.app/develop/calling-rust [VERIFIED]
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

useEffect(() => {
  const unlisteners = Promise.all([
    listen<number>("ssh-connection-lost", (event) => {
      if (event.payload === connectionId) { /* handle */ }
    }),
    listen<number>("ssh-reconnected", (event) => {
      if (event.payload === connectionId) { /* handle */ }
    }),
  ]);

  return () => {
    unlisteners.then(([u1, u2]) => { u1(); u2(); });
  };
}, [connectionId]);
```

### Exponential Backoff (existing pattern in session.rs)

```rust
// Source: src-tauri/src/ssh/session.rs:648 [VERIFIED: codebase]
// reconnect_attempts is Arc<AtomicUsize>
let attempt = self.reconnect_attempts.load(Ordering::SeqCst);
let delay_ms = 100u64 * 2u64.pow(attempt as u32);
tokio::time::sleep(Duration::from_millis(delay_ms)).await;
self.reconnect_attempts.fetch_add(1, Ordering::SeqCst);
```

Delays: 100ms, 200ms, 400ms, 800ms, 1600ms → max 5 attempts (existing `>= 5` guard).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `inactivity_timeout` only | `keepalive_interval` + `keepalive_max` | Phase 40 (this phase) | Prevents idle disconnects proactively |
| Silent SSH failure (channel open fails → inline reconnect) | Background heartbeat → Tauri events → UI backdrop | Phase 40 | User sees connection state, can't interact with stale UI |
| PTY sessions silently stale after SSH loss | Mark failed via heartbeat task | Phase 40 | Agents view shows correct `failed` status |

**Current gap:** `open_handle()` sets `inactivity_timeout: Some(300s)` but no keepalive. The result is that SSH connections idle for >5 minutes on cloud servers that close idle TCP connections after 2-3 minutes silently drop without any detection.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Heartbeat interval of 30s is appropriate (same as keepalive_interval) | Architecture Patterns | Too frequent → extra CPU; too infrequent → slow detection; 30s is a reasonable default matching standard SSH keepalive |
| A2 | Max reconnect attempts stays at 5 (matching existing `reconnect_if_needed`) | Architecture Patterns | Could need tuning; 5 retries with exponential backoff = ~3s total before giving up |
| A3 | `DisconnectBackdrop` should fully block interaction (not just show a toast) | Architecture Patterns | If the UX preference is a toast instead, the component can be simplified |
| A4 | Interactive PTY sessions (no task_id) should be cleaned up by iterating `ssh_pty_sessions` directly | PTY Cleanup section | If the schema is extended to track connection_id on execution_logs, a JOIN approach would be cleaner |

## Open Questions (RESOLVED)

1. **Where should the heartbeat task be spawned?**
   - What we know: It needs to run after a successful `connect()` call and have access to `RemoteSshSession` + `AppHandle` + `connection_id`.
   - What's unclear: Whether to spawn it inside `RemoteSshSession.connect()` (requires AppHandle stored in the struct) or in the IPC handler after `finalize_ssh_connection()` (simpler, keeps session clean).
   - RESOLVED: Spawn in `finalize_ssh_connection()` in `ssh_handlers.rs` — it's the single call site after all auth paths succeed, and it already has `app_state` (which will contain `AppHandle`).

2. **Should `AppHandle` be stored in `AppState` or threaded as a parameter?**
   - What we know: The heartbeat task needs it. IPC handlers already get it via Tauri's injection.
   - What's unclear: Whether `AppHandle` in `AppState` vs passing it through IPC handler signatures is cleaner.
   - RESOLVED: Store in `AppState` — heartbeat tasks are long-running background tasks that outlive IPC handler call frames. Passing through IPC handlers is impractical for tasks that need to emit events minutes later.

3. **Event naming: global vs per-window?**
   - What we know: `app_handle.emit()` sends to all windows. The app has a single window.
   - What's unclear: Whether to use `emit_to()` for precision.
   - RESOLVED: Use `app_handle.emit()` (global) — single-window app, no downside.

## Environment Availability

All dependencies already in project. Step 2.6 SKIPPED — no new external dependencies.

## Validation Architecture

`nyquist_validation` not set in `.planning/config.json` — treated as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `vite.config.ts` (vitest section) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test` |
| Rust tests | `cd src-tauri && cargo test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PTY-CLEANUP | SSH PTY sessions marked failed on connection loss | Manual (requires SSH) | — | N/A |
| KEEPALIVE | russh keepalive config applied | Unit (Rust) | `cargo test` | ❌ Wave 0 |
| BACKDROP | DisconnectBackdrop renders on lost/reconnecting state | Unit (Vitest) | `pnpm test` | ❌ Wave 0 |
| HOOK | useConnectionHealth state transitions | Unit (Vitest) | `pnpm test` | ❌ Wave 0 |
| EVENTS | Tauri events emitted on state transition | Manual (integration) | — | N/A |

### Wave 0 Gaps

- [ ] `src/components/common/DisconnectBackdrop.test.tsx` — covers BACKDROP requirement
- [ ] `src/utils/hooks/useConnectionHealth.test.ts` — covers HOOK requirement (mock `listen()`)
- [ ] `src-tauri/src/ssh/tests/keepalive.rs` — covers KEEPALIVE requirement (verify config fields)

## Security Domain

SSH-scope phase. ASVS categories below:

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Auth already handled by existing connect() |
| V3 Session Management | Yes | Reconnect uses stored credentials (existing session_password / key_passphrase) |
| V4 Access Control | No | No new access gates |
| V5 Input Validation | No | No new user input surfaces |
| V6 Cryptography | No | No new crypto (russh handles it) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Reconnect stores plaintext password in session | Information Disclosure | Existing `Zeroizing<String>` wraps passwords (Phase 32) |
| Heartbeat command injection | Tampering | Command is hardcoded `"true"` — no user input |
| Event spoofing from frontend | Elevation of Privilege | Tauri events from Rust → frontend are unidirectional; frontend cannot forge backend events |

## Sources

### Primary (HIGH confidence)
- `docs.rs/russh/0.60.0/russh/client/struct.Config.html` — keepalive_interval, keepalive_max fields [VERIFIED]
- `docs.rs/tauri/2.0.0/tauri/struct.AppHandle.html` — AppHandle::emit(), Emitter trait [VERIFIED]
- `v2.tauri.app/develop/calling-rust/` — listen() pattern, unlisten cleanup [VERIFIED]
- Codebase (`src-tauri/src/ssh/session.rs`) — existing RemoteSshSession, SshConnectionState, reconnect_if_needed [VERIFIED: read directly]
- Codebase (`src-tauri/src/ssh/error.rs`) — is_transient_error, is_permanent_error [VERIFIED: read directly]
- Codebase (`src-tauri/src/db/connection.rs`) — AppState structure [VERIFIED: read directly]
- Codebase (`src-tauri/src/main.rs`) — setup() pattern, AppHandle access [VERIFIED: read directly]
- Codebase (`package.json`) — @tauri-apps/api ^2.10.1 [VERIFIED: read directly]

### Secondary (MEDIUM confidence)
- `Cargo.toml` russh 0.60.0 — confirmed version matches docs.rs lookup [VERIFIED: read directly]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all verified in official docs and codebase
- Architecture: HIGH — patterns derived from existing code in session.rs and main.rs
- Pitfalls: MEDIUM — some are [ASSUMED] from reasoning about async ownership and cleanup patterns
- Security: HIGH — follows existing Zeroizing/SshError patterns

**Research date:** 2026-04-10
**Valid until:** 2026-05-10 (russh 0.60 is stable; Tauri 2 API is stable)
