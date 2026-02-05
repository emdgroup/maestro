# Architecture Research: AI Agent Orchestration Desktop Tool

**Domain:** AI agent orchestration and autonomous code generation
**Researched:** 2026-02-04
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            TAURI 2 APPLICATION SHELL                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     REACT FRONTEND (Web Layer)                         │  │
│  │  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐                  │  │
│  │  │ Kanban View  │  │ Agent Panel  │  │ Terminal View│                  │  │
│  │  │ (Workflows)  │  │ (Controls)   │  │ (Streaming)  │                  │  │
│  │  └──────┬───────┘  └──────┬──────┘  └──────┬───────┘                  │  │
│  │         │                 │                │                           │  │
│  │         └─────────────────┴────────────────┘                           │  │
│  │         │ WebSocket (real-time streams) & IPC (commands)              │  │
│  │         ↓                                                               │  │
│  └─────────┼───────────────────────────────────────────────────────────────┘  │
│            │                                                                    │
├────────────┼───────────────────────────────────────────────────────────────────┤
│ TAURI IPC  │                                                                    │
│ LAYER      │ Commands (JSON serialized) & Events (WebSocket bridge)            │
│            │                                                                    │
├────────────┼───────────────────────────────────────────────────────────────────┤
│            ↓                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │              RUST BACKEND (Tauri Command Handler Layer)                 │  │
│  │  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────────┐      │  │
│  │  │ Command Router   │  │ State Manager   │  │ Event Dispatcher │      │  │
│  │  │ (invoke parsing) │  │ (app state)     │  │ (send to UI)     │      │  │
│  │  └────────┬─────────┘  └────────┬────────┘  └────────┬─────────┘      │  │
│  │           │                     │                    │                 │  │
│  │  ┌────────▼─────────────────────▼────────────────────▼─────────────┐  │  │
│  │  │                  Core Services Layer                            │  │  │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │  │
│  │  │  │ Process Mgr  │  │ Git Manager  │  │ DB Manager   │          │  │  │
│  │  │  │ (spawn CLI)  │  │ (worktrees)  │  │ (SQLite)     │          │  │  │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘          │  │  │
│  │  └────────┬─────────────────┬──────────────────────────┬──────────┘  │  │
│  │           │                 │                          │             │  │
│  └───────────┼─────────────────┼──────────────────────────┼─────────────┘  │
│              │                 │                          │                 │
└──────────────┼─────────────────┼──────────────────────────┼─────────────────┘
               │                 │                          │
┌──────────────▼─────────────────▼──────────────────────────▼─────────────────┐
│                    EXTERNAL SYSTEM LAYER                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
│  │ Node.js      │  │ Git CLI      │  │ SQLite       │                       │
│  │ Sidecar      │  │ (system)     │  │ Database     │                       │
│  │ (Claude Code)│  │ (worktree)   │  │ (state)      │                       │
│  └──────────────┘  └──────────────┘  └──────────────┘                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **React Frontend** | UI rendering, user interactions, real-time display updates | React with hooks (useState, useEffect, useContext), WebSocket for streaming |
| **Tauri IPC Layer** | Command routing from frontend to backend, event delivery to frontend | Tauri's `invoke()` API and event system |
| **Rust Command Handler** | Parse commands, dispatch to services, aggregate responses | Tauri `#[tauri::command]` macros, JSON-RPC pattern |
| **Process Manager** | Spawn CLI processes, capture output, manage lifecycle, error handling | `std::process::Command`, Tokio async spawning |
| **Git Manager** | Create/destroy worktrees, manage branches, handle conflicts | `git` CLI invocations or `gitoxide` library |
| **State Manager** | Coordinate app state, orchestrate workflows, manage agent tasks | In-memory app state + SQLite persistence |
| **Database Manager** | Persist workflows, agent state, execution logs, git metadata | SQLite with connection pooling |
| **Node.js Sidecar** | Run Claude Code CLI, isolated from main process, controlled lifetime | Node.js child process via `tauri::process::Command` |
| **WebSocket Bridge** | Stream terminal output, real-time logs, agent progress | ws or tokio-tungstenite over localhost |

## Recommended Project Structure

```
src/
├── commands/              # Tauri command handlers
│   ├── mod.rs             # Command registry
│   ├── agent.rs           # Agent lifecycle commands
│   ├── workflow.rs        # Workflow commands
│   ├── process.rs         # Process spawning commands
│   ├── git.rs             # Git operations
│   └── state.rs           # State queries
│
├── services/              # Business logic and external integration
│   ├── mod.rs
│   ├── process_manager.rs # Spawn and manage child processes
│   ├── git_manager.rs     # Git worktree operations
│   ├── agent_orchestrator.rs # Coordinate agents and workflows
│   ├── state_coordinator.rs # App state management
│   ├── db_manager.rs      # SQLite operations
│   └── sidecar_launcher.rs # Node.js sidecar lifecycle
│
├── models/                # Data structures
│   ├── mod.rs
│   ├── agent.rs           # Agent state, task definitions
│   ├── workflow.rs        # Workflow, task, step definitions
│   ├── process.rs         # Process handle, execution state
│   └── event.rs           # Event types sent to frontend
│
├── db/                    # Database layer
│   ├── mod.rs
│   ├── schema.rs          # Table definitions
│   ├── migrations.rs      # Initial schema setup
│   └── queries.rs         # Prepared statements
│
├── ipc/                   # IPC communication helpers
│   ├── mod.rs
│   ├── protocol.rs        # Command/response structures
│   └── error_handling.rs  # IPC error formats
│
├── utils/                 # Helper utilities
│   ├── mod.rs
│   ├── paths.rs           # Project and worktree paths
│   ├── environment.rs     # Environment setup
│   └── logging.rs         # Structured logging
│
└── main.rs                # App initialization, setup

frontend/src/
├── components/
│   ├── KanbanBoard.tsx     # Workflow visualization
│   ├── AgentControl.tsx    # Agent lifecycle UI
│   ├── TerminalView.tsx    # Real-time output streaming
│   ├── TaskPanel.tsx       # Task details and controls
│   └── StateMonitor.tsx    # System state display
│
├── hooks/
│   ├── useProcessOutput.ts # WebSocket subscription hook
│   ├── useAgentState.ts    # Agent state management
│   ├── useWorkflow.ts      # Workflow management
│   └── useIPC.ts           # Tauri IPC abstraction
│
├── services/
│   ├── ipcClient.ts        # Tauri invoke wrapper
│   ├── websocketClient.ts  # Terminal streaming
│   └── stateService.ts     # Frontend state sync
│
├── store/
│   ├── workflowStore.ts    # Workflow state (React Context)
│   ├── agentStore.ts       # Agent state (React Context)
│   └── uiStore.ts          # UI state (React Context)
│
└── App.tsx
```

### Structure Rationale

- **commands/:** Separates Tauri command handlers from business logic for clean API surface definition
- **services/:** Isolates business logic (git, process, orchestration) for testability and reuse
- **models/:** Centralized data structure definitions ensures consistency across layers
- **db/:** Dedicated database layer allows easy migration or replacement later
- **ipc/:** Isolates protocol definitions and marshaling for maintainability
- **frontend/components/:** React components organized by feature domain
- **frontend/hooks/:** Custom hooks encapsulate IPC and WebSocket logic for reusability
- **frontend/store/:** React Context-based state management avoids prop drilling across deep UI trees

## Architectural Patterns

### Pattern 1: Command-Response IPC with Error Propagation

**What:** Frontend invokes Tauri commands (async) with JSON payloads. Backend executes command, returns JSON result or error.

**When to use:** All frontend-to-backend operations (state queries, mutations, long-running operations)

**Trade-offs:**
- Pro: Type-safe with TypeScript interfaces mirroring Rust structs
- Pro: Automatic JSON serialization/deserialization
- Con: Request-response is synchronous at the frontend (use async/await), not ideal for streaming responses
- Con: Large responses need pagination or streaming fallback

**Example:**

```rust
// Backend (Rust)
#[tauri::command]
async fn spawn_agent(
    state: tauri::State<'_, AppState>,
    config: AgentConfig,
) -> Result<AgentHandle, String> {
    state.orchestrator.spawn_agent(config)
        .await
        .map_err(|e| e.to_string())
}

// Frontend (TypeScript)
const { invoke } = await import("@tauri-apps/api/core");

const handle = await invoke<AgentHandle>("spawn_agent", {
    config: { name: "agent-1", model: "claude-opus" }
}).catch(err => console.error("Failed to spawn:", err));
```

### Pattern 2: WebSocket Streaming for Terminal Output

**What:** Real-time output (logs, agent activity) streamed via WebSocket instead of polling or bulk IPC.

**When to use:** Terminal output, progress updates, streaming data that shouldn't block the main IPC channel

**Trade-offs:**
- Pro: Low-latency, high-frequency updates
- Pro: Frontend can buffer and render efficiently
- Con: Requires separate WebSocket connection management
- Con: Error recovery (reconnection) needed for robustness

**Example:**

```rust
// Backend: WebSocket broadcaster
pub struct TerminalStream {
    tx: tokio::sync::broadcast::Sender<String>,
}

impl TerminalStream {
    fn emit_line(&self, line: String) {
        let _ = self.tx.send(line);
    }
}

// Frontend: Hook for WebSocket subscription
function useTerminalOutput(processId: string) {
    const [output, setOutput] = useState<string[]>([]);

    useEffect(() => {
        const ws = new WebSocket(`ws://localhost:7777/terminal/${processId}`);
        ws.onmessage = (event) => {
            setOutput(prev => [...prev, event.data]);
        };
        return () => ws.close();
    }, [processId]);

    return output;
}
```

### Pattern 3: Git Worktree Pooling with Lifecycle Management

**What:** Pre-allocate N git worktrees, lease them to agents, recycle on task completion.

**When to use:** Avoid `git worktree create` overhead on every task; enable agent isolation and parallel execution

**Trade-offs:**
- Pro: Fast agent startup (existing worktree)
- Pro: Easy cleanup (reset to base state)
- Con: Requires disk space for N copies of repo
- Con: Must handle worktree state conflicts if recycling is too aggressive

**Example:**

```rust
pub struct WorktreePool {
    available: Vec<PathBuf>,      // Unoccupied worktrees
    leased: HashMap<AgentId, PathBuf>, // Occupied worktrees
    capacity: usize,
}

impl WorktreePool {
    async fn lease(&mut self) -> Result<PathBuf> {
        // If pool depleted, create new or wait
        if self.available.is_empty() && self.leased.len() < self.capacity {
            self.create_worktree().await?;
        }
        Ok(self.available.pop()?)
    }

    async fn return_to_pool(&mut self, agent_id: AgentId) -> Result<()> {
        // Reset worktree state, return to available pool
        let path = self.leased.remove(&agent_id)?;
        self.reset_worktree(&path).await?;
        self.available.push(path);
        Ok(())
    }
}
```

### Pattern 4: App State as Single Source of Truth with Event Sourcing

**What:** Centralized app state (in-memory + SQLite) with all mutations logged as events. UI subscribes to state changes via events.

**When to use:** Complex workflows with multiple agents; need to replay/audit execution; recover from crashes

**Trade-offs:**
- Pro: Complete audit trail of all mutations
- Pro: Crash recovery by replaying events
- Con: Added complexity (event store, event handlers)
- Con: Storage overhead (every mutation is persisted)

**Example:**

```rust
pub enum WorkflowEvent {
    TaskCreated { workflow_id: u64, task: Task },
    TaskStarted { task_id: u64 },
    TaskCompleted { task_id: u64, result: String },
    TaskFailed { task_id: u64, error: String },
}

pub struct EventLog {
    db: rusqlite::Connection,
}

impl EventLog {
    async fn append(&self, event: WorkflowEvent) -> Result<u64> {
        // Serialize, store in DB with timestamp
        let json = serde_json::to_string(&event)?;
        self.db.execute(
            "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
            [&event_type, &json, &now],
        )?;
        Ok(last_insert_rowid)
    }

    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<WorkflowEvent> {
        // UI subscribes to event stream
        self.tx.subscribe()
    }
}
```

### Pattern 5: Sidecar Process Lifecycle with Health Monitoring

**What:** Launch Node.js sidecar once at app startup. Monitor health, restart if crashed. Graceful shutdown on app exit.

**When to use:** Integration with external CLI tools (Claude Code CLI); need isolated environment

**Trade-offs:**
- Pro: Isolates Node.js from Rust runtime
- Pro: Can restart Node.js without restarting Tauri app
- Con: Adds IPC overhead (Tauri ↔ Node.js)
- Con: Requires health monitoring and reconnection logic

**Example:**

```rust
pub struct SidecarManager {
    process: Option<std::process::Child>,
    health_check_tx: tokio::sync::mpsc::Sender<()>,
}

impl SidecarManager {
    async fn start(&mut self) -> Result<()> {
        let child = tauri::process::Command::new("node")
            .args(&["sidecar/index.js"])
            .spawn()?;
        self.process = Some(child);
        self.spawn_health_check();
        Ok(())
    }

    fn spawn_health_check(&self) {
        // Periodically check if process is alive
        // Restart if dead
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        // Graceful shutdown: send signal to Node.js process
        if let Some(mut proc) = self.process.take() {
            let _ = proc.kill();
        }
    }
}
```

## Data Flow

### Request Flow: User Action → Backend Command → Service Layer

```
User clicks "Start Agent"
    ↓
React onClick handler
    ↓
invoke<AgentHandle>("spawn_agent", config)
    ↓ (IPC serialization: config → JSON)
Tauri command router
    ↓
Rust command handler: spawn_agent()
    ↓
Process Manager: spawn_child_process()
    ↓
Git Manager: lease_worktree()
    ↓
State Coordinator: record agent state
    ↓ (JSON serialization: AgentHandle → JSON)
Frontend receives response
    ↓
React state update (setAgents)
    ↓
UI re-renders with new agent
```

### Streaming Flow: Terminal Output → WebSocket → Frontend Render

```
Child process writes to stdout
    ↓
Process Manager captures line
    ↓
TerminalStream broadcasts: tx.send(line)
    ↓
WebSocket clients receive message
    ↓ (streaming, not buffering)
Frontend useTerminalOutput hook updates state
    ↓
Virtual terminal component renders new line
    ↓
User sees live output
```

### State Persistence Flow: Mutation → Event Log → SQLite → Broadcast

```
Command completes successfully
    ↓
Rust service appends event to EventLog
    ↓
EventLog.append() serializes and inserts into DB
    ↓
EventLog broadcasts event on tokio::sync::broadcast channel
    ↓
Tauri event system (tauri::emit()) sends to frontend
    ↓
React hook (useWorkflowState) receives event, updates Context
    ↓
Components re-render with new state
    ↓
Next app restart: replay EventLog to recover state
```

### Key Data Flows

1. **User-initiated agent spawning:** Frontend invokes command → Rust spawns process + leases worktree + creates DB record → WebSocket stream established for output
2. **Real-time terminal output:** Process stdout captured → WebSocket broadcast → Frontend receives and renders → User sees live terminal
3. **Workflow state changes:** Event created → Logged to DB → Broadcast to all listeners → Frontend updates UI and local state
4. **Error handling:** Process fails → Service logs error event → Frontend receives event → UI displays error and optionally retries

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-1 agent | Single process, in-memory state fine, SQLite sufficient. Pattern: monolithic. |
| 1-5 agents | Add worktree pooling to avoid repeated `git worktree create`. Event log helpful for debugging. Add WebSocket for streaming to prevent IPC saturation. |
| 5-50 agents | Implement event sourcing for crash recovery. Consider moving state to separate service (not just in-memory). Add connection pooling to SQLite. Monitor process memory (Tokio tasks). |
| 50+ agents | Sidecar bottleneck likely. Consider process spawning strategy (queue, rate limiting). Worktree pooling becomes critical (allocate N worktrees up front). Event log archival (old events to separate cold storage). |

### Scaling Priorities

1. **First bottleneck:** Process spawning (Tauri can spawn but OS has process limit). Solution: queue agents, batch spawning, worktree pooling prevents redundant operations.
2. **Second bottleneck:** IPC throughput for terminal output. Solution: WebSocket streaming instead of bulk IPC, compress if needed.
3. **Third bottleneck:** SQLite with many concurrent writes. Solution: connection pooling (rusqlite with tokio), write batching, consider PostgreSQL for multi-instance setups.

## Anti-Patterns

### Anti-Pattern 1: Synchronous Blocking in Tauri Command Handlers

**What people do:** Write blocking operations directly in `#[tauri::command]` without `async`.

**Why it's wrong:** Blocks the Tauri event loop, freezing UI. Other commands queue up.

**Do this instead:** Always use `async fn` for I/O-bound operations. Use `tokio::spawn_blocking()` for CPU-heavy work.

```rust
// WRONG
#[tauri::command]
fn spawn_agent(config: AgentConfig) -> Result<AgentHandle> {
    std::thread::sleep(std::time::Duration::from_secs(5)); // Freezes UI!
    // ...
}

// RIGHT
#[tauri::command]
async fn spawn_agent(
    state: tauri::State<'_, AppState>,
    config: AgentConfig,
) -> Result<AgentHandle> {
    state.orchestrator.spawn_agent(config).await
}
```

### Anti-Pattern 2: Polling for Process Status Instead of Events

**What people do:** Frontend repeatedly calls `get_process_status()` every 100ms to check if agent is done.

**Why it's wrong:** Wastes IPC bandwidth, adds latency, poor UX (not real-time).

**Do this instead:** Have backend emit events when status changes. Frontend listens to events.

```typescript
// WRONG
useEffect(() => {
    const timer = setInterval(() => {
        invoke("get_process_status", { id }).then(setStatus);
    }, 100);
    return () => clearInterval(timer);
}, []);

// RIGHT
useEffect(() => {
    const unlisten = listen(`process:${id}:status`, (event) => {
        setStatus(event.payload);
    });
    return unlisten;
}, []);
```

### Anti-Pattern 3: Storing Agent State Only in Memory

**What people do:** Keep all agent/workflow state in a Rust `Arc<Mutex<AppState>>`, no SQLite.

**Why it's wrong:** Crash = lost state. Can't replay execution or debug.

**Do this instead:** Dual-write to in-memory state AND SQLite. Treat SQLite as source of truth for recovery.

```rust
// WRONG
let mut state = app_state.lock().unwrap();
state.agents.insert(agent_id, agent_info); // Only in memory!

// RIGHT
state.db.insert_agent(&agent_info).await?; // Persist first
state.cache.insert(agent_id, agent_info); // Cache for performance
```

### Anti-Pattern 4: Unmanaged Git Worktree Accumulation

**What people do:** Create worktree per task without cleanup. After 100 tasks, 100 worktrees on disk.

**Why it's wrong:** Disk space bloat, slow filesystem ops.

**Do this instead:** Implement worktree pooling and cleanup. Limit pool size, reset worktrees between uses.

```rust
// WRONG
async fn execute_task(task: Task) {
    let worktree = create_new_worktree().await?; // New worktree every time
    // ... run agent ...
    // Never cleaned up!
}

// RIGHT
let mut pool = WorktreePool::new(max_size: 5);
let worktree = pool.lease().await?;
// ... run agent ...
pool.return_to_pool(worktree).await?; // Recycle
```

### Anti-Pattern 5: WebSocket Without Reconnection or Backpressure

**What people do:** Open WebSocket for output stream. If it drops, no recovery. Or send unlimited messages, crash client.

**Why it's wrong:** Network flakiness will crash the app. User loses output visibility.

**Do this instead:** Implement reconnection logic, message queueing, and backpressure handling.

```rust
// WRONG
tx.send(output_line)?; // Fails if receiver disconnected

// RIGHT
match tx.send(output_line) {
    Ok(_) => {},
    Err(e) => {
        // Log and recover: might want to queue message
        // or signal to frontend that stream is broken
        eprintln!("WebSocket send failed: {}", e);
    }
}
```

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| **Node.js Sidecar** | `tauri::process::Command::new("node")`. IPC via stdin/stdout or HTTP. | Health monitoring required; graceful shutdown on app exit. |
| **Git CLI** | Shell commands via `std::process::Command`. Capture stdout/stderr. | Already installed on dev machines; simpler than gitoxide library. |
| **SQLite** | `rusqlite` crate with connection pooling for Tokio. | File-based, no network overhead. Local transactions sufficient for single-app writes. |
| **Claude Code CLI** | Executed within Node.js sidecar. Invoked by agent orchestrator with project state as args. | Orchestrator polls sidecar for completion or listens to events from Node.js. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| **Frontend ↔ Rust Backend** | Tauri IPC (JSON serialized commands/responses) + Tauri events for state broadcasts | Type-safe with TypeScript interfaces. Commands are fire-and-forget or await-response; events are one-way broadcasts. |
| **Rust Backend ↔ Terminal Streaming** | WebSocket over localhost (tokio-tungstenite or async-tungstenite). Broadcast pattern: one sender, many subscribers. | Decouples terminal output from IPC channel. Allows independent reconnection. |
| **Rust Backend ↔ Git Manager** | Direct function calls (same Rust binary). Git commands are blocking, wrapped in `tokio::task::block_in_place()`. | Simpler than subprocess calls; synchronous git operations are acceptable (usually <1s per call). |
| **Rust Backend ↔ Process Manager** | Direct function calls. Spawning is async (returns JoinHandle). Output captured to a channel and broadcast to WebSocket. | Process lifecycle tracked in app state; cleanup on agent completion or app exit. |
| **Rust Backend ↔ Node.js Sidecar** | stdin/stdout piping or HTTP over localhost. Likely: invoke sidecar via command line arguments, wait for process exit, parse stdout as JSON result. | Sidecar lifetime tied to Tauri app lifetime (spawn at startup, kill on shutdown). |

## Implementation Approach for Build Order

### Phase 1: Foundation (Must build first)
- SQLite schema and DB manager
- Tauri IPC command registry (empty stubs)
- React app shell with Context-based state management
- Type definitions for all major models (Agent, Workflow, Task, etc.)

**Rationale:** Everything depends on these; build them solid.

### Phase 2: Core Orchestration (Depends on Phase 1)
- Rust app state and event log
- Process manager (spawn and track processes)
- Basic command handlers (spawn_agent, get_agents, etc.)
- React UI components for agent list and controls

**Rationale:** Now you can spawn processes and track them.

### Phase 3: Git Integration (Depends on Phase 1)
- Git manager (create/destroy/reset worktrees)
- Worktree pooling logic
- Git command handlers (create_worktree, delete_worktree, etc.)
- DB schema updates for git metadata

**Rationale:** Agents need isolated worktrees to operate safely.

### Phase 4: Real-time Output Streaming (Depends on Phase 2)
- WebSocket server (localhost, ephemeral port)
- Terminal output buffering and broadcast
- Frontend WebSocket client and terminal view component
- Backpressure and reconnection logic

**Rationale:** Terminal streaming is critical for UX; must be after process management.

### Phase 5: Advanced Orchestration (Depends on Phase 2 + 3)
- Workflow engine (sequence tasks, branching, error recovery)
- Agent state transitions and state machine
- Event sourcing and audit logging
- Kanban board UI reflecting workflow state

**Rationale:** Complex orchestration logic builds on stable process and git managers.

### Phase 6: Sidecar Integration (Depends on Phase 2)
- Node.js sidecar launcher and health monitoring
- Claude Code CLI invocation via sidecar
- Sidecar → Tauri backend communication protocol
- Graceful sidecar shutdown on app exit

**Rationale:** Can be parallel with other phases; orthogonal to core orchestration.

### Phase 7: Production Hardening (Depends on Phases 1-6)
- Error recovery and restart logic
- Monitoring and diagnostics (logs, telemetry)
- Crash recovery (replay event log on startup)
- Performance tuning (connection pooling, caching)

**Rationale:** Late stage; integrates all components.

## Sources

- **Tauri 2 Documentation:** https://docs.rs/tauri/2.9.5/ (IPC, commands, async runtime)
- **React Hooks:** https://react.dev/learn/lifecycle-of-reactive-effects (useEffect, state management)
- **Node.js Child Processes:** https://nodejs.org/api/child_process (fork, IPC, process management)
- **GitHub Topics:** Agent orchestration systems employ event-driven architectures, persistent state, task-based workflows (HIGH confidence from cross-project analysis)
- **AI Agent Orchestration Patterns:** Synapse, Routilux, JAT examples demonstrate event buses, persistent workflows, distributed execution (MEDIUM confidence; WebSearch verified)

---

*Architecture research for: Desktop orchestration tool for autonomous AI coding agents*
*Researched: 2026-02-04*
