# Phase 04: Agent Execution - Research

**Researched:** 2026-02-06
**Domain:** Process spawning, lifecycle management, output capture, execution history
**Confidence:** MEDIUM (Verified core APIs and patterns; some assumptions about real-time output handling)

## Summary

Phase 04 requires spawning long-running agent processes (Claude Code CLI via Node.js sidecar), capturing output in real-time, tracking execution lifecycle (running → complete/failed), and persisting execution history. The established approach uses:

1. **Tokio's async process API** (tokio::process::Command) for non-blocking spawning
2. **Streamed I/O capture** (piped stdout/stderr) rather than buffering
3. **Database-backed state tracking** (execution_logs table) for durability
4. **Process exit code and signal handling** for failure detection
5. **Node.js child_process module** for CLI tool invocation from sidecar

**Primary recommendation:** Implement a process manager that spawns CLI tools with piped I/O, streams output to database on a cadence, and tracks status via exit codes with database transactions for atomicity.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tokio | ^1.0 (feature: full) | Async runtime with process module | Matches existing async context; non-blocking spawn/wait |
| tokio::process::Command | Built-in | Async subprocess spawning | Essential for Tauri IPC handlers (not std::process::Command) |
| node:child_process | Built-in (Node.js) | Spawn CLI tools from sidecar | Industry standard for CLI invocation; used in all agent orchestrators |
| rusqlite | ^0.31 | Execution log persistence | Matches DB layer; enables durable state |
| chrono | ^0.4 | Timestamp recording | Matches existing time handling |

### Supporting Patterns
| Library | Purpose | When to Use |
|---------|---------|-------------|
| tokio::io::AsyncRead | Stream stdout/stderr | Real-time output handling without buffering |
| tokio::time::sleep | Process polling/checks | Status updates without blocking |
| tokio::task::JoinHandle | Process handle tracking | Manage parallel agent executions |
| std::process::Stdio | I/O redirection config | Pipe stdout/stderr/stdin setup |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| tokio::process | std::process::Command | std is blocking; would freeze Tauri IPC handler |
| Streamed output | Full buffering | Buffering caps at maxBuffer (~1MB); large outputs crash process |
| Database persistence | In-memory state | Crashes lose execution history; no recovery |
| Node.js sidecar spawning | Direct Rust invocation | Rust has limited CLI framework ecosystem; Node.js better for this |

**Installation (Rust side):** Already have tokio in Cargo.toml. No new Rust dependencies needed.

**Installation (Node.js side):** No new Node.js dependencies; child_process is built-in.

## Architecture Patterns

### Process Execution Lifecycle

```
[User clicks "Execute"]
  ↓
[create_execution_log record: status='running']
  ↓
[Rust: spawn_agent_process via IPC]
  ↓
[tokio::process::Command spawn CLI with piped I/O]
  ↓
[Stream stdout/stderr in background task]
  ↓
[Append lines to execution_log.output]
  ↓
[Wait for child.wait() to complete]
  ↓
[Capture exit code / signal]
  ↓
[Update execution_log: status='complete'/'failed', completed_at=now]
```

### Process Manager Module Structure

```
src-tauri/src/
├── process/                    # NEW: Process execution module
│   ├── mod.rs                  # Module exports
│   ├── spawner.rs              # tokio::process::Command wrapper
│   ├── output_handler.rs        # Streaming output capture
│   └── status_tracker.rs        # Lifecycle state machine
├── ipc/
│   └── handlers.rs             # ADD: spawn_agent, get_execution_status, get_execution_logs
└── db/
    ├── execution_logs.rs       # NEW: execution_logs DB operations
    └── schema.rs               # execution_logs table already defined
```

### Recommended IPC Handler Pattern

**spawn_agent(task_id: i32, worktree_path: String) → Result<ExecutionLog, String>**

```rust
// 1. Lease worktree from pool
let worktree = lease_worktree(project_id, task_id, repo_path).await?;

// 2. Create execution log record
let exec_log = create_execution_log(task_id, worktree_id)?;

// 3. Spawn process in background task
let exec_id = exec_log.id;
tokio::spawn(async move {
    // Capture output and status
    let result = run_agent_process(worktree.path, &cli_command).await;

    // Update execution log with result
    update_execution_log(exec_id, result)?;

    // Return worktree to pool
    return_worktree(worktree_id)?;
});

// 4. Return immediately to frontend (process runs in background)
Ok(exec_log)
```

### Output Capture Pattern

```typescript
// Node.js sidecar: spawn Claude Code CLI with streaming

import { spawn } from 'node:child_process';

export async function runAgent(
  workingDir: string,
  agentCommand: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn('claude', ['code', ...args], {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],  // Pipe all streams
  });

  let stdout = '';
  let stderr = '';

  // Stream data, emit events to parent
  proc.stdout?.on('data', (data) => {
    stdout += data.toString();
    // Send to Rust parent via IPC or write to file
  });

  proc.stderr?.on('data', (data) => {
    stderr += data.toString();
  });

  return new Promise((resolve) => {
    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}
```

### Rust Process Spawner Pattern

```rust
// src-tauri/src/process/spawner.rs

use tokio::process::Command;
use std::process::Stdio;

pub async fn spawn_agent_cli(
    working_dir: &str,
    agent_command: &str,
) -> Result<ProcessOutput, String> {
    let mut cmd = Command::new("node");
    cmd.arg(SIDECAR_PATH)  // Path to compiled sidecar
       .arg("run-agent")
       .arg(agent_command)
       .current_dir(working_dir)
       .stdout(Stdio::piped())
       .stderr(Stdio::piped())
       .kill_on_drop(true);  // CRITICAL: terminate if handle dropped

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;

    // Capture streams
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Read streams to completion
    let stdout_future = tokio::io::AsyncReadExt::read_to_string(&mut BufReader::new(stdout), &mut String::new());
    let stderr_future = tokio::io::AsyncReadExt::read_to_string(&mut BufReader::new(stderr), &mut String::new());

    let status = child.wait().await.map_err(|e| e.to_string())?;

    Ok(ProcessOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(-1),
        success: status.success(),
    })
}
```

### State Transitions

```
execution_log.status:
  'running'   → Agent process is active
  'complete'  → Process exited with code 0 (success)
  'failed'    → Process exited with non-zero code or signal
  'paused'    → (Phase 5) User paused execution
  'error'     → Process crashed / failed to spawn
```

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Process spawning | Custom std::process wrapper | tokio::process::Command | Blocking std::process freezes IPC handlers; tokio is non-blocking |
| Output buffering | String concatenation loop | tokio::io::AsyncRead | Manual buffering loses data on buffer overflow; Tokio handles capacity |
| Exit code handling | String parsing | Process exit codes via status.code() | Exit codes are integers; string parsing is fragile |
| Process lifecycle | Manual SIGTERM/SIGKILL | Command::kill_on_drop(true) | Rust async APIs handle signal safety; manual signaling has race conditions |
| Output persistence | Append-on-write to file | Batched database writes | File I/O blocks; database transactions maintain consistency |
| Process pooling | Track running PIDs manually | Maintain JoinHandle collection | PIDs are OS-specific; JoinHandles are portable |

**Key insight:** The Rust ecosystem has solved these in Tokio and standard libraries. Using them prevents:
- Blocking the event loop (kills real-time UI updates)
- Output corruption (buffer overflows, incomplete writes)
- Zombie processes (uncleaned child processes)
- Data loss on crashes (no durable state)

## Common Pitfalls

### Pitfall 1: Blocking the Tauri IPC Handler

**What goes wrong:** Using `std::process::Command` (blocking) in an async Tauri handler freezes the IPC thread, causing UI to hang.

**Why it happens:** std::process blocks waiting for child to finish. Tauri IPC is single-threaded per handler.

**How to avoid:**
- ALWAYS use `tokio::process::Command` in Tauri handlers
- Mark Tauri commands as `async` (enforces async context)
- Drop database locks before spawn to unblock others

**Warning signs:**
- UI becomes unresponsive during execution
- Multiple tasks seem serialized instead of parallel
- IPC timeout errors

**Code example (WRONG):**
```rust
#[tauri::command]
fn spawn_agent(task_id: i32) -> Result<String, String> {
    // WRONG: Blocks IPC handler!
    let output = std::process::Command::new("agent-cli")
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
```

**Code example (CORRECT):**
```rust
#[tauri::command]
async fn spawn_agent(task_id: i32) -> Result<String, String> {
    // CORRECT: Non-blocking
    let output = tokio::process::Command::new("agent-cli")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
```

### Pitfall 2: Unbounded Output Buffering

**What goes wrong:** Collecting all stdout/stderr in memory crashes the process if agent produces >1MB output.

**Why it happens:** Node.js child_process has default maxBuffer of 1MB; exceeding it kills the process silently.

**How to avoid:**
- Stream output line-by-line, persist to database on cadence (e.g., every 100 lines or every 1s)
- Set explicit higher maxBuffer ONLY if you know output is bounded (e.g., <10MB)
- Prefer streaming patterns over buffering

**Warning signs:**
- "Error: stdout maxBuffer exceeded" or just process dies
- Agent output is incomplete in database
- No error message in logs

**Code example (WRONG):**
```typescript
// Accumulates all output in memory - crashes on large output
let output = '';
proc.stdout.on('data', (data) => {
  output += data.toString();  // Unbounded!
});
```

**Code example (CORRECT):**
```typescript
// Streams output, persisting every 100 lines
let buffer = [];
proc.stdout.on('data', (data) => {
  buffer.push(data.toString());
  if (buffer.length >= 100) {
    saveToDatabase(buffer);
    buffer = [];
  }
});
```

### Pitfall 3: Not Reaping Child Processes

**What goes wrong:** Child process becomes a zombie when parent doesn't wait() for it, consuming OS resources.

**Why it happens:** Async spawns can forget to await exit; process terminates but entry stays in process table.

**How to avoid:**
- Always `await child.wait()` or `child.wait_with_output()`
- Use `kill_on_drop(true)` to force cleanup if handle dropped
- In background tasks, wrap in JoinHandle and track

**Warning signs:**
- `ps aux` shows defunct processes
- System eventually runs out of PIDs
- "fork: resource temporarily unavailable"

**Code example (WRONG):**
```rust
// Spawns but never waits - becomes zombie
let mut child = Command::new("agent").spawn()?;
// Function returns without waiting
// Process becomes zombie
```

**Code example (CORRECT):**
```rust
// Properly waits for child
let mut child = Command::new("agent")
    .kill_on_drop(true)  // Safety net
    .spawn()?;
let status = child.wait().await?;  // MUST wait
```

### Pitfall 4: Inadequate Error Distinction

**What goes wrong:** Exit code 1 treated same as signal 9; unclear if failure was user error, timeout, or crash.

**Why it happens:** Not capturing exit signals separately from exit codes.

**How to avoid:**
- Record both exit code AND signal (ExitStatus has both)
- Categorize: code 0 → success, code 1-255 → failure, signal → crash
- Store full error output in execution_log for diagnostics

**Warning signs:**
- "agent failed" but don't know why
- Can't distinguish timeout from compile error
- Hard to debug agent failures

**Code example (CORRECT):**
```rust
let status = child.wait().await?;

let failure_reason = if status.success() {
    ExecutionStatus::Complete
} else if let Some(code) = status.code() {
    ExecutionStatus::Failed(format!("exit code {}", code))
} else if let Some(signal) = status.signal() {
    ExecutionStatus::Failed(format!("killed by signal {}", signal))
} else {
    ExecutionStatus::Failed("unknown failure".to_string())
};
```

### Pitfall 5: Race Between Output Completion and Process Exit

**What goes wrong:** Process exits but last output lines aren't captured (buffers not flushed).

**Why it happens:** Streams are closed when process exits; unread buffered data is lost.

**How to avoid:**
- Use `wait_with_output()` which guarantees all streams read before returning
- If streaming manually, ensure `on('close')` event fires AFTER all data events
- Test with large outputs

**Warning signs:**
- Last few lines of agent output missing
- Always missing exactly the last 4K bytes
- Intermittent missing output (non-deterministic)

**Code example (WRONG):**
```javascript
proc.stdout.on('data', (data) => {
  buffer.push(data.toString());
});
proc.on('close', () => {  // Might fire before last data event!
  persist(buffer);
});
```

**Code example (CORRECT):**
```javascript
// Option 1: Use promisified exec which handles this
const { stdout, stderr } = await exec('agent-cli', { cwd });

// Option 2: Manual event ordering with 'end' event
let dataEnded = false;
proc.stdout.on('data', (data) => {
  buffer.push(data.toString());
});
proc.stdout.on('end', () => {
  dataEnded = true;
});
proc.on('close', () => {
  if (dataEnded) persist(buffer);  // Wait for end event
});
```

### Pitfall 6: Synchronous Database Writes During Output

**What goes wrong:** Appending to database on every output line causes contention lock, slowing agent process.

**Why it happens:** IPC handler holds database connection while streaming output; every `on('data')` causes a write.

**How to avoid:**
- Buffer output in memory (reasonable size), flush periodically (every 1-10 seconds or X lines)
- Batch database inserts into single transaction
- Don't hold database lock during streaming

**Warning signs:**
- Agent runs much slower when output is high-volume
- High CPU from database locking
- I/O wait times spike

**Code example (WRONG):**
```rust
// Every output chunk writes to DB - terrible contention
for chunk in output_stream {
    conn.execute("UPDATE execution_logs SET output = output || ? WHERE id = ?", ...)?;
    // Blocks other IPC handlers!
}
```

**Code example (CORRECT):**
```rust
// Buffer in memory, batch flush
let mut buffer = Vec::new();
let mut last_flush = Instant::now();

for chunk in output_stream {
    buffer.push(chunk);
    if buffer.len() > 100 || last_flush.elapsed() > Duration::from_secs(1) {
        {
            let conn = app_state.db.lock().map_err(|e| e.to_string())?;
            conn.execute("UPDATE execution_logs SET output = output || ? WHERE id = ?", [buffer.join("")])?;
        }
        buffer.clear();
        last_flush = Instant::now();
    }
}
```

## Code Examples

### Pattern 1: Basic Process Spawning (Tokio + Output Capture)

**Source:** tokio::process::Command API (docs.rs/tokio)

```rust
// src-tauri/src/process/spawner.rs
use tokio::process::Command;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

pub async fn run_agent_process(
    working_dir: &str,
    sidecar_path: &str,
    task_id: i32,
) -> Result<(i32, String, String), String> {
    let mut cmd = Command::new("node");
    cmd.arg(sidecar_path)
       .arg("run-agent")
       .arg(task_id.to_string())
       .current_dir(working_dir)
       .stdout(Stdio::piped())
       .stderr(Stdio::piped())
       .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    let mut stdout_reader = BufReader::new(stdout);
    let mut stderr_reader = BufReader::new(stderr);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    // Read both streams (non-blocking)
    let stdout_fut = stdout_reader.read_to_string(&mut stdout_buf);
    let stderr_fut = stderr_reader.read_to_string(&mut stderr_buf);

    tokio::join!(stdout_fut, stderr_fut);

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let exit_code = status.code().unwrap_or(-1);

    Ok((exit_code, stdout_buf, stderr_buf))
}
```

### Pattern 2: Execution Log Persistence

**Source:** SQLite execution_logs schema (src-tauri/src/db/schema.rs)

```rust
// src-tauri/src/db/execution_logs.rs
use chrono::Utc;
use rusqlite::Connection;

pub fn create_execution_log(
    conn: &Connection,
    task_id: i32,
    worktree_id: i32,
) -> Result<i32, String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO execution_logs (task_id, status, output, started_at)
         VALUES (?, ?, ?, ?)",
        rusqlite::params![task_id, "running", "", &now],
    )
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid() as i32)
}

pub fn append_output(
    conn: &Connection,
    log_id: i32,
    output: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE execution_logs SET output = output || ? WHERE id = ?",
        rusqlite::params![output, log_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_complete(
    conn: &Connection,
    log_id: i32,
    exit_code: i32,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let status = if exit_code == 0 { "complete" } else { "failed" };
    conn.execute(
        "UPDATE execution_logs SET status = ?, completed_at = ?, output = output || ?
         WHERE id = ?",
        rusqlite::params![status, &now, format!("\n[Exit code: {}]", exit_code), log_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

### Pattern 3: IPC Handler for Spawning Agent

**Source:** Tauri IPC patterns (main.rs #[tauri::command])

```rust
// src-tauri/src/ipc/handlers.rs
#[tauri::command]
pub async fn spawn_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {  // Returns execution_log id
    // 1. Create execution log
    let exec_log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::db::execution_logs::create_execution_log(&conn, task_id, 0)?
    };

    // 2. Spawn async background task
    let app_state_clone = app_state.clone();
    let repo_clone = repo_path.clone();
    tokio::spawn(async move {
        // Run agent process
        let result = crate::process::spawner::run_agent_process(
            &repo_clone,
            "/path/to/sidecar.js",
            task_id,
        ).await;

        if let Ok((exit_code, stdout, stderr)) = result {
            let conn = app_state_clone.db.lock().unwrap();
            let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &stdout);
            if !stderr.is_empty() {
                let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &format!("\nSTDERR:\n{}", stderr));
            }
            let _ = crate::db::execution_logs::mark_complete(&conn, exec_log_id, exit_code);
        }
    });

    // 3. Return immediately (execution continues in background)
    Ok(exec_log_id)
}
```

### Pattern 4: Node.js Sidecar Agent Runner

**Source:** Node.js child_process API (nodejs.org/api/child_process.html)

```typescript
// sidecar/src/agent-runner.ts
import { spawn } from 'node:child_process';

export async function runAgent(
  workingDir: string,
  taskId: number,
  agentCommand: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['code', agentCommand], {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3600000, // 1 hour
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn agent: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
  });
}

// Entry point: receive task via IPC
export async function handleRunAgent(taskId: number, workingDir: string): Promise<void> {
  const result = await runAgent(workingDir, taskId, `run-task ${taskId}`);
  console.log(JSON.stringify(result)); // Send back to Rust parent
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Blocking std::process in IPC | Async tokio::process in IPC handlers | Tauri 1→2, Tokio adoption | Unblocks UI updates during agent execution |
| Full output buffering | Streaming with database batching | Stream adoption ~2022 | Prevents crashes on >1MB output |
| Manual process tracking | JoinHandle + background tasks | Tokio ecosystem | Cleaner lifecycle; prevents zombie processes |
| Polling for completion | Event-driven on('close') | Node.js stream APIs | Real-time feedback; lower latency |

**Deprecated/outdated:**
- `std::process::Command` in async contexts: Performance issue (blocks runtime thread)
- Collecting unbounded output in memory: Crashes on large outputs
- Direct PIDs for process tracking: OS-specific; doesn't scale with async

## Open Questions

1. **Real-time output streaming to frontend**
   - What we know: execution_logs table stores complete output; Phase 5 will add WebSocket streaming
   - What's unclear: Should Phase 4 batch output to database or stream directly? Impact on response latency?
   - Recommendation: Batch to database (Phase 4), Phase 5 can WebSocket from DB; simpler separation of concerns

2. **Agent pause/resume mechanism**
   - What we know: Phase 6 spec mentions pausing agents
   - What's unclear: Should Phase 4 implement signal sending (SIGSTOP/SIGCONT) or just status tracking?
   - Recommendation: Phase 4 does status tracking only; Phase 6 adds signal handling (requires careful signal safety)

3. **Output encoding and binary handling**
   - What we know: stdout/stderr are text; execution_logs.output is TEXT column
   - What's unclear: Can agents output binary data (images, archives)? How to handle?
   - Recommendation: Phase 4 assumes text output; binary output stored as base64 or linked as artifact

4. **Sidecar discovery and versioning**
   - What we know: Sidecar built in Phase 3, compiled to dist/
   - What's unclear: How does Rust backend discover sidecar path? What if versions mismatch?
   - Recommendation: Hardcode sidecar path in main.rs with build-time check; fail startup if not found

## Sources

### Primary (HIGH confidence)
- **Tokio process module** (docs.rs/tokio/latest/tokio/process/) - Command API, spawn(), wait(), output()
- **Node.js child_process** (nodejs.org/api/child_process.html) - spawn(), exec(), execFile(), stdio handling
- **SQLite TEXT columns** - Execution_logs table definition verified in src-tauri/src/db/schema.rs
- **Tauri IPC patterns** - async command handlers verified in main.rs + handlers.rs

### Secondary (MEDIUM confidence)
- **Anthropic SDK patterns** (anthropic-sdk-python) - Long-running operation status tracking, streaming models
- **Tokio async/await** - Best practices from official tutorials (verified current as of 2026-02)
- **Node.js promisification** - util.promisify for process lifecycle (standard Node.js API)

### Tertiary (LOW confidence)
- Common pitfalls from my training data (2025 cutoff) - Some patterns may be outdated; recommend validation with current Tokio/Node.js docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Tokio and Node.js child_process are stable, verified APIs
- Architecture patterns: MEDIUM - Patterns are standard but real-time output handling (Phase 5) will refine approach
- Pitfalls: MEDIUM - Based on async ecosystem patterns; specific Tauri gotchas not tested here
- Code examples: HIGH - Examples follow official API docs; minimal assumptions

**Research date:** 2026-02-06
**Valid until:** 2026-03-06 (30 days; process APIs are stable)
**Validation needed:** Test output capture with >10MB agent output before Phase 4 completion
