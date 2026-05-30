# Fix Windows Release Build: Console Windows, Preflight Freeze, Slow Start

## Context

Windows release builds set `windows_subsystem = "windows"` on the Tauri process (suppressing its console), but every child process spawn (`git`, `wsl.exe`, `maestro-server`, agents) allocates a new visible console window. Additionally, maestro-server blocks on agent PATH discovery before acknowledging the handshake, causing the 10s timeout to fire. Finally, `resolve_server_path_standalone()` can't find the bundled binary in the Tauri resource directory.

## Fix 1: Suppress Console Windows (CREATE_NO_WINDOW)

**Create extension trait** in both crates to avoid 35+ inline `#[cfg(windows)]` blocks:

### New files:
- `src-tauri/src/command_ext.rs`
- `maestro-server/src/command_ext.rs`

Both contain:
```rust
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

// impl for tokio::process::Command — cfg(windows) applies flag, cfg(not) is no-op
// impl for std::process::Command — same pattern
```

### Apply `.no_console_window()` at all spawn sites:

| File | Spawn count |
|------|-------------|
| `src-tauri/src/acp/manager.rs` | 2 (maestro-server, wsl.exe) |
| `src-tauri/src/acp/deploy.rs` | 2 (wsl.exe) |
| `src-tauri/src/wsl.rs` | 4 (std::process::Command — wsl.exe) |
| `src-tauri/src/git/mod.rs` | ~15 (TokioCommand — git/wsl) |
| `src-tauri/src/ipc/project_handlers.rs` | 3 (git) |
| `src-tauri/src/ipc/worktree_handlers.rs` | 4 (git/wsl) |
| `src-tauri/src/ipc/review_handlers.rs` | 2 (git/wsl) |
| `src-tauri/src/issue_tracking/github.rs` | 2 (gh) |
| `maestro-server/src/main.rs` | 1 (cmd /c tool) |
| `maestro-server/src/agent.rs` | 1 (agent binary) |
| `maestro-server/src/terminal.rs` | 1 (user commands) |

### Add `windows_subsystem` to maestro-server:
```rust
// maestro-server/src/main.rs, after doc block, before `mod agent;`
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]
```

**DO NOT apply to PTY spawns** in `src-tauri/src/process/pty.rs` — those use `portable-pty` ConPTY which handles its own console allocation.

---

## Fix 2: Fix maestro-server Resolution in Bundled Builds

**Delete `resolve_server_path_standalone()`** from `src-tauri/src/acp/resolve.rs`.

Both callers already have `app_state.app_handle` available:
- `src-tauri/src/ipc/acp_handlers.rs:756` → use `resolve_server_path(&app_state.app_handle)`
- `src-tauri/src/ipc/acp_handlers.rs:1046` → use `resolve_server_path(&app_state.app_handle)`

This ensures the Tauri resource directory is checked first (where the bundled binary lives).

---

## Fix 3: Defer Agent Discovery Until After Handshake

In `maestro-server/src/main.rs`, move `discover_agents(&registry)` from line 101 (before handshake read) to after the `HandshakeOk` response is sent (after line 129).

Before:
```
load_registry → discover_agents [SLOW: which::which per agent] → read handshake → send HandshakeOk
```

After:
```
load_registry → read handshake → send HandshakeOk → discover_agents [still slow but client no longer waiting]
```

`agents_with_spawn` is only consumed in the main dispatch loop, never during handshake.

---

---

## Fix 4: Windows npx/.cmd Agent Spawn

**Root cause:** On Windows, `npx` (and `uvx`) are `.cmd` batch files. `CreateProcess("npx")` fails silently — the process never starts, the ACP handshake never arrives, and the session stays in "spawning" indefinitely.

`probe_tool()` in `main.rs` already fixes this correctly with `cmd /c`. Apply the same pattern to agent spawning.

### Change 1: Wrap npx/uvx in `cmd /c` on Windows — `maestro-server/src/registry.rs`

In `resolve_spawn()`, replace the returned `spawn_cmd`/`spawn_args` for `npx` and `uvx` distributions with a Windows-conditional `cmd /c` prefix. `spawn_deps` stays `["npx"]` / `["uvx"]` — preflight still probes the right tool.

```rust
// npx branch (line 69-76)
#[cfg(windows)]
return Some(("cmd".to_string(), {
    let mut w = vec!["/c".to_string(), "npx".to_string()];
    w.extend(args);
    w
}, env, vec!["npx".to_string()]));
#[cfg(not(windows))]
return Some(("npx".to_string(), args, env, vec!["npx".to_string()]));

// uvx branch (line 90-96) — same pattern
#[cfg(windows)]
return Some(("cmd".to_string(), {
    let mut w = vec!["/c".to_string(), "uvx".to_string()];
    w.extend(args);
    w
}, Default::default(), vec!["uvx".to_string()]));
#[cfg(not(windows))]
return Some(("uvx".to_string(), args, Default::default(), vec!["uvx".to_string()]));
```

### Change 2: Pipe agent stderr to eprintln — `maestro-server/src/agent.rs`

Currently `.stderr(std::process::Stdio::null())` — agent startup errors are completely invisible, making diagnosis impossible on Windows.

Change to `.stderr(std::process::Stdio::piped())` and drain stderr in `bootstrap_agent_transport` (`session_handler.rs`) with a background task:

```rust
// In bootstrap_agent_transport, after child spawn:
if let Some(stderr_pipe) = child.stderr.take() {
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stderr_pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[agent-stderr] {line}");
        }
    });
}
```

---

## Implementation Order

1. Fix 3 (1 file, 2-line move) — highest impact, smallest change
2. Fix 2 (2 files, delete function + update 2 call sites)
3. Fix 1 (create 2 new files, modify 11 existing files)
4. Fix 4 (2 files: registry.rs + agent.rs + session_handler.rs)

## Verification

1. `cargo check -p maestro-server --target x86_64-pc-windows-msvc` (or host target)
2. `cargo check -p maestro --target x86_64-pc-windows-msvc` (or host target)
3. `pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc` — full release build
4. Run on Windows: confirm no console flashes, preflight passes, startup is responsive
5. Fix 4: Start a claude-code-acp session on Windows — confirm it transitions out of "spawning" to idle
