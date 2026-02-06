# Phase 5 Research: Real-time Monitoring

**Phase:** 5 - Real-time Monitoring
**Researched:** 2026-02-06
**Mode:** Ecosystem

## Executive Summary

Real-time terminal streaming in Tauri requires three integrated components: PTY management (portable-pty), WebSocket streaming (tokio-tungstenite), and terminal UI (xterm.js with AttachAddon). The architecture should use Tauri's native channel system for frontend streaming rather than raw WebSockets, as channels provide type-safe, structured communication. PTY must be spawned in Rust backend to maintain process lifecycle control.

**Key Decision:** Use portable-pty + Tauri channels + xterm.js AttachAddon (not standalone WebSocket server).

## Standard Stack

### Backend (Rust)

**PTY Management:**
- `portable-pty` v0.8+ - Cross-platform PTY spawning and control
- **Why:** Official cross-platform PTY abstraction, handles Windows ConPTY and Unix PTY differences
- **Don't use:** Manual libc PTY calls, platform-specific code

**Async Runtime:**
- `tokio` v1.x with "full" features (already in project)
- `tokio::sync::mpsc` for buffering between PTY reader and channel sender

**WebSocket (Alternative - NOT RECOMMENDED):**
- `tokio-tungstenite` v0.20+ - Async WebSocket implementation
- **Why NOT recommended:** Tauri channels are simpler, type-safe, and integrate better

**Recommended Approach:**
- Use `tauri::ipc::Channel<String>` for streaming output to frontend
- Use PTY master reader/writer for bidirectional terminal I/O
- Use `tokio::sync::mpsc` for buffering PTY output before sending to frontend

### Frontend (React + TypeScript)

**Terminal Emulator:**
- `@xterm/xterm` v5.3+ - Full-featured terminal emulator
- `@xterm/addon-attach` v0.9+ - WebSocket/channel attachment addon
- `@xterm/addon-fit` v0.8+ - Auto-sizing terminal to container

**React Integration:**
- Create `TerminalComponent` wrapper with useEffect for lifecycle
- Use `useRef` to store Terminal instance
- Load addons after terminal.open() in useEffect

## Architecture Patterns

### 1. PTY Spawning (Rust Backend)

```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

// Spawn PTY with process
let pty_system = native_pty_system();
let pair = pty_system.openpty(PtySize {
    rows: 24,
    cols: 80,
    pixel_width: 0,
    pixel_height: 0,
})?;

let cmd = CommandBuilder::new("node");
cmd.arg("sidecar.js");
let child = pair.slave.spawn_command(cmd)?;

// Clone reader/writer for separate tasks
let mut reader = pair.master.try_clone_reader()?;
let mut writer = pair.master.take_writer()?;
```

**Pattern:** Spawn PTY in Tauri command, store reader/writer in AppState with Arc<Mutex<>> for sharing.

### 2. Streaming Output via Tauri Channels

```rust
#[tauri::command]
async fn attach_terminal(
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    // Get PTY reader from AppState
    let mut reader = get_pty_reader(task_id)?;

    // Buffer and send chunks
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let output = String::from_utf8_lossy(&buf[..n]).to_string();
                    if output_channel.send(output).is_err() {
                        break; // Channel closed (frontend detached)
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}
```

**Pattern:** Spawn background task, stream until EOF or channel close.

### 3. Buffering with Backpressure

```rust
use tokio::sync::mpsc;

// Create bounded channel (backpressure when full)
let (tx, mut rx) = mpsc::channel::<String>(100);

// PTY reader task
tokio::spawn(async move {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf).await {
            Ok(n) if n > 0 => {
                let output = String::from_utf8_lossy(&buf[..n]).to_string();
                if tx.send(output).await.is_err() {
                    break; // Receiver dropped
                }
            }
            _ => break,
        }
    }
});

// Frontend sender task
tokio::spawn(async move {
    while let Some(output) = rx.recv().await {
        if output_channel.send(output).is_err() {
            break;
        }
    }
});
```

**Pattern:** Use bounded mpsc channel (100 messages) to buffer between PTY and frontend, prevents memory explosion.

### 4. Bidirectional Input (Frontend → PTY)

```rust
#[tauri::command]
async fn send_terminal_input(
    task_id: i32,
    input: String,
) -> Result<(), String> {
    let mut writer = get_pty_writer(task_id)?;
    writer.write_all(input.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

**Pattern:** Separate command for sending input, frontend calls on keypress.

### 5. Frontend Terminal Component (React)

```typescript
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';

export function TerminalComponent({ taskId }: { taskId: number }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current!);
    fitAddon.fit();

    xtermRef.current = terminal;

    // Set up Tauri channel for streaming output
    const channel = new Channel<string>();
    channel.onmessage = (output) => {
      terminal.write(output);
    };

    // Attach to backend PTY
    invoke('attach_terminal', { taskId, outputChannel: channel });

    // Send input to backend
    terminal.onData((data) => {
      invoke('send_terminal_input', { taskId, input: data });
    });

    // Cleanup
    return () => {
      terminal.dispose();
    };
  }, [taskId]);

  return <div ref={terminalRef} style={{ width: '100%', height: '100%' }} />;
}
```

**Pattern:** useEffect mounts terminal, sets up channel, cleans up on unmount.

### 6. Attach/Detach State Management

**Frontend State:**
```typescript
const [isAttached, setIsAttached] = useState(false);

const attach = async () => {
  // Create new channel and invoke attach_terminal
  setIsAttached(true);
};

const detach = () => {
  // Drop channel (Rust side detects channel close and stops streaming)
  setIsAttached(false);
};
```

**Backend Detection:**
```rust
// Tauri channels automatically detect when frontend drops the channel
// The send() will return Err, breaking the streaming loop
if output_channel.send(output).is_err() {
    println!("Frontend detached");
    break;
}
```

**Pattern:** No explicit detach command needed, rely on channel drop detection.

## Don't Hand-Roll

1. **PTY Management** - Use portable-pty, not manual Unix/Windows PTY code
2. **Terminal Emulator** - Use xterm.js, not custom canvas rendering
3. **ANSI Parsing** - xterm.js handles escape sequences, don't write parser
4. **WebSocket Server** - Use Tauri channels, not tokio-tungstenite for this use case
5. **Terminal Resizing** - Use FitAddon, not manual dimension calculation
6. **Backpressure** - Use tokio::sync::mpsc bounded channels, not unbounded Vec buffering

## Common Pitfalls

### 1. PTY Process Lifecycle

**Problem:** PTY process outlives Tauri app or gets orphaned.

**Solution:**
- Store `Box<dyn Child>` in AppState alongside PTY pair
- Call `child.kill()` in cleanup handlers
- Use `kill_on_drop(true)` for tokio::process::Command if spawning via Command instead of PTY

### 2. Blocking PTY Reads

**Problem:** Synchronous `read()` blocks Tauri IPC thread.

**Solution:**
- Use `tokio::spawn` to move PTY reading to separate task
- Never call blocking I/O in `#[tauri::command]` handler body

### 3. Memory Explosion from Buffering

**Problem:** Unbounded buffering when frontend is slow or disconnected.

**Solution:**
- Use `mpsc::channel(100)` (bounded) not `mpsc::unbounded_channel()`
- Bounded channel applies backpressure: writer waits when buffer full
- Terminal output will slow down naturally (acceptable for terminal UI)

### 4. Race Condition: PTY Spawn vs Attach

**Problem:** Frontend attaches before PTY is spawned, or PTY output lost before attach.

**Solution:**
- Create PTY and start buffering immediately when task execution starts
- Store buffer in AppState (e.g., `CircularBuffer<String>` with last 10000 lines)
- When frontend attaches, send buffer history first, then live stream
- Use `tokio::sync::broadcast` if multiple frontends can attach (broadcast to all subscribers)

### 5. Unicode Corruption

**Problem:** Reading PTY mid-UTF8 sequence causes `String::from_utf8_lossy` to insert �.

**Solution:**
- Use `Utf8LossyDecoder` from `utf8-lossy` crate
- Or buffer incomplete UTF-8 bytes and retry with next read
- portable-pty documentation notes this issue explicitly

### 6. Terminal Resizing Not Propagated

**Problem:** Terminal renders wrong when resized, PTY doesn't know new dimensions.

**Solution:**
```rust
#[tauri::command]
async fn resize_terminal(task_id: i32, cols: u16, rows: u16) -> Result<(), String> {
    let pty_pair = get_pty_pair(task_id)?;
    pty_pair.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;
    Ok(())
}
```

Frontend:
```typescript
terminal.onResize(({ cols, rows }) => {
  invoke('resize_terminal', { taskId, cols, rows });
});
```

### 7. Channel Drop Not Detected

**Problem:** Backend keeps streaming after frontend detaches, wastes CPU.

**Solution:**
- Tauri channels automatically return `Err` when dropped
- Always check `channel.send()` result and break loop on error

### 8. Zombie Processes

**Problem:** PTY child process continues after parent dies.

**Solution:**
- Store `Box<dyn Child>` handle in AppState
- Implement cleanup logic in `drop()` or explicit `cleanup_task` command
- Call `child.kill()` and `child.wait()`

## Code Examples

See Architecture Patterns section above for complete examples.

## Testing Strategies

1. **Unit Test PTY Spawning:**
   - Spawn echo process, write input, verify output
   - Test PTY resize propagation

2. **Integration Test Streaming:**
   - Spawn long-running process (e.g., `ping localhost`)
   - Attach channel, collect output for 5 seconds
   - Verify output chunks received

3. **Manual Test Attach/Detach:**
   - Start agent execution
   - Attach terminal, verify live output
   - Detach, verify backend stops streaming (check CPU)
   - Re-attach, verify output resumes

4. **Stress Test Buffering:**
   - Spawn process that outputs 100MB rapidly
   - Verify bounded buffer prevents OOM
   - Verify backpressure slows output rate

## Dependencies to Add

```toml
[dependencies]
portable-pty = "0.8"
tokio = { version = "1", features = ["full"] } # Already present
```

Frontend:
```json
{
  "dependencies": {
    "@xterm/xterm": "^5.3.0",
    "@xterm/addon-fit": "^0.8.0"
  }
}
```

## Integration with Existing Code

**Phase 4 Integration:**
- Current `spawn_agent_cli` in `src-tauri/src/process/spawner.rs` waits for process completion
- Phase 5 needs separate PTY-based spawner that returns immediately
- Refactor: `spawn_agent_cli_pty()` returns PTY pair + child handle stored in AppState
- Keep existing `spawn_agent_cli()` for non-interactive execution (logs only)

**AppState Schema:**
```rust
pub struct PtySession {
    pub task_id: i32,
    pub master: Box<dyn MasterPty>,
    pub child: Box<dyn Child>,
    pub buffer: Arc<Mutex<CircularBuffer<String>>>,
}

pub struct AppState {
    pub db_conn: Mutex<Connection>,
    pub pty_sessions: Mutex<HashMap<i32, PtySession>>,
}
```

## Performance Considerations

- **Buffering:** 100-message bounded channel = ~400KB max (4KB chunks)
- **History Buffer:** CircularBuffer of 10K lines = ~10MB per session
- **Max Concurrent Sessions:** 5 worktrees × 10MB = 50MB for all terminal buffers (acceptable)
- **CPU:** PTY reading is I/O-bound, minimal CPU overhead per session

## Security Considerations

1. **Input Validation:** No validation needed (PTY process owns security boundary)
2. **Output Sanitization:** xterm.js handles ANSI escape sequences safely (no XSS)
3. **Process Isolation:** Already handled by worktree isolation (Phase 3)
4. **Localhost Only:** No network exposure (Tauri IPC is local)

## Confidence Levels

- **portable-pty for PTY:** High (official docs, widely used in Alacritty, WezTerm)
- **Tauri channels for streaming:** High (official recommendation in Tauri docs)
- **xterm.js for terminal UI:** High (used in VS Code, official frontend standard)
- **tokio::sync::mpsc for buffering:** High (standard pattern in async Rust)
- **Bounded channel backpressure:** Medium (prevents OOM but may slow output visibly)

## Open Questions

1. **Searchable history:** Requirements say "Terminal output is captured and searchable in execution history"
   - **Answer:** Store output to database table (execution_logs) as it streams
   - Separate from in-memory buffer (database for persistence, buffer for UI)

2. **Multiple attach sessions:** Can multiple frontend windows attach to same PTY?
   - **Answer:** Yes, use `tokio::sync::broadcast` instead of Tauri channel
   - Plans should support single attach first, broadcast is enhancement

3. **Reconnection:** What happens if app restarts mid-execution?
   - **Answer:** PTY child dies (kill_on_drop), can't reconnect to dead process
   - Future enhancement: Persistent background daemon (out of scope for Phase 5)

## References

- portable-pty docs: https://docs.rs/portable-pty/latest/portable_pty/
- tokio-tungstenite examples: https://github.com/snapview/tokio-tungstenite/tree/master/examples
- xterm.js documentation: https://xtermjs.org/docs/
- Tauri IPC channels: https://tauri.app/develop/calling-rust/ (streaming section)
- Context7 research queries executed 2026-02-06

---

**Research Complete:** 2026-02-06
**Confidence:** High for all core components
**Recommendation:** Proceed with planning using portable-pty + Tauri channels + xterm.js
