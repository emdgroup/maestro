# Maestro — Architecture & Core Features

> Tauri desktop app orchestrating autonomous AI coding agents across local, SSH, and WSL connections. React + TypeScript frontend, Rust backend, with a headless server binary for remote execution.

---

## System Overview

```mermaid
graph TB
    subgraph Desktop["Maestro Desktop App (Tauri)"]
        subgraph Frontend["React + TypeScript"]
            Views[Views<br/>Kanban · Agents · Worktrees · Settings]
            Stores[Zustand Stores<br/>board · navigation · session · config]
            IPC[IPC Service Layer<br/>TanStack Query + tauri-specta bindings]
        end
        subgraph Backend["Rust Backend"]
            Handlers[IPC Handlers<br/>11 domain modules · 139 commands]
            ACP[ACP Manager<br/>Session lifecycle · pooling · reconnection]
            DB[(SQLite<br/>WAL mode · schema v16)]
            SSH[SSH Manager<br/>russh · heartbeat · reconnection]
            PTY[PTY Manager<br/>portable-pty · xterm-256color]
        end
    end

    subgraph Remote["Remote Host (via SSH)"]
        Server[maestro-server<br/>Headless binary]
        Agents[AI Agents<br/>Claude · Codex · Goose · 25+ supported]
    end

    Views --> Stores
    Views --> IPC
    IPC -->|tauri invoke| Handlers
    Handlers --> ACP
    Handlers --> DB
    Handlers --> SSH
    Handlers --> PTY
    ACP -->|stdin/stdout<br/>length-prefixed JSON| Server
    SSH -->|exec channel| Server
    Server -->|ACP protocol<br/>stdio| Agents
```

---

## Core Features

### 1. Kanban Task Management

Users manage coding tasks on a Kanban board with columns: **Backlog → Ready → InProgress → Review → Done**. Tasks carry metadata like acceptance criteria, priority, base branch, skills, model overrides, and external ticket links (Jira, Linear, GitHub, Azure DevOps).

```mermaid
stateDiagram-v2
    [*] --> Backlog
    Backlog --> Ready: Triage
    Ready --> InProgress: Execute
    InProgress --> Review: Agent completes
    Review --> Done: Approve
    Review --> InProgress: Request changes
    Done --> [*]
    InProgress --> Ready: Cancel
    
    state InProgress {
        [*] --> WorktreeCreated
        WorktreeCreated --> AgentSpawned
        AgentSpawned --> AgentRunning
        AgentRunning --> TurnEnded
    }
```

### 2. Autonomous Agent Execution

When a user executes a task, Maestro:
1. Creates/finds a git worktree for isolation
2. Spawns an AI agent session (via ACP)
3. Streams real-time activity (tool use, file edits, terminal output)
4. Handles permission prompts and elicitation questions
5. Presents diffs for code review when complete

### 3. Multi-Connection Support

| Connection Type | Transport | Use Case |
|----------------|-----------|----------|
| **Local** | Direct subprocess | Development on local machine |
| **SSH** | russh exec channel | Remote server development |
| **WSL** | WSL distro bridge | Windows ↔ Linux development |

### 4. Git Worktree Isolation

Each task runs in its own git worktree — a separate checkout of the repository. This enables:
- Multiple agents working on different tasks simultaneously
- Clean diffs per task
- Safe rollback (delete worktree)
- Staging, committing, shelving, and discarding changes per worktree

### 5. Real-Time Agent Monitoring

The Agent Monitor displays live activity for each session:
- Streaming markdown messages from the agent
- Tool call results and file modifications
- Permission prompts (approve/deny/modify)
- Elicitation prompts (agent asks user questions)
- Terminal output from agent-spawned subprocesses
- Token usage tracking

### 6. Code Review Flow

When an agent completes its work:
- Diff panel shows file-by-file changes
- Users can add inline review comments
- Three review decisions: **Approve**, **Request Changes**, **Reject**
- Approved work can be committed from within Maestro

---

## Frontend Architecture

```mermaid
graph LR
    subgraph Providers["Provider Tree"]
        QP[QueryProvider<br/>TanStack Query]
        TP[ThemeProvider<br/>light/dark/system + accent]
    end

    subgraph Views["Views (lazy-loaded)"]
        PP[ProjectPickerView]
        KV[KanbanView<br/>Backlog · Board · Archive]
        AV[AgentsView<br/>always mounted]
        WV[WorktreesView]
        SV[SettingsView]
    end

    subgraph State["Zustand Stores"]
        NS[navigationStore<br/>tab · sub-view · deep links]
        PS[projectStore<br/>active project]
        BS[boardStore<br/>terminal attach state]
        SAS[sessionActivityStore<br/>per-session status · badges]
        CS[configStore<br/>agent/model defaults]
    end

    subgraph Services["IPC Services (TanStack Query)"]
        TS[task.service]
        ES[execution.service]
        WS[worktree.service]
        PrS[project.service]
        ConS[connection.service]
    end

    QP --> Views
    TP --> Views
    Views --> State
    Views --> Services
    Services -->|invoke via api proxy| Tauri
```

### Navigation Model

No client-side router. Zustand `navigationStore` drives conditional rendering in `App.tsx` with `framer-motion` slide transitions. Deep linking via discriminated union targets:

```typescript
type NavigationTarget =
  | { taskId: string }      // → kanban + open task detail
  | { agentId: string }     // → agents + select session  
  | { worktreeId: string }  // → worktrees + select worktree
  | { view: ViewType }      // → specific tab
```

### IPC Pattern

```mermaid
sequenceDiagram
    participant C as React Component
    participant H as TanStack Query Hook
    participant S as Service Function
    participant A as api Proxy
    participant R as Rust Handler

    C->>H: useQuery / useMutation
    H->>S: taskService.getTasks(projectId)
    S->>A: api.getTasks(projectId)
    A->>R: invoke("get_tasks", { projectId })
    R-->>A: Result<Vec<Task>, String>
    A-->>S: Vec<Task> (unwrapped, throws on error)
    S-->>H: data
    H-->>C: { data, isLoading, error }

    Note over R,C: Backend events trigger cache invalidation
    R--)C: emit("tasks-changed")
    C->>H: invalidateQueries(["tasks"])
```

Key patterns:
- **Proxy-based Result unwrapping** — `api.*` calls throw on error instead of returning Result unions
- **Event-driven invalidation** — Tauri events (`tasks-changed`, `sessions-changed`, etc.) trigger query invalidation, not polling
- **Hierarchical query keys** — enable surgical cache invalidation (`["tasks", "list", { projectId }]`)

---

## Rust Backend Architecture

### AppState — Central God-Struct

```mermaid
classDiagram
    class AppState {
        +Mutex~Connection~ db
        +AppHandle app_handle
        +SshState ssh
        +AcpState acp
        +PtyState pty
        +PathBuf app_data_dir
        +Mutex~Option~ active_project_lock
        +TokenManager token_manager
    }

    class SshState {
        +HashMap sessions
        +HashMap passwords (zeroize)
        +HashMap pty_sessions
    }

    class AcpState {
        +HashMap sessions
        +HashMap discovery_cache
        +HashMap connection_servers
        +HashMap agent_cache
        +HashMap session_pool
        +HashMap deploy_locks
        +HashMap restorable_sessions
    }

    class PtyState {
        +HashMap sessions
        +HashMap attach_cancel
        +HashMap session_meta
        +AtomicI32 session_counter
    }

    AppState --> SshState
    AppState --> AcpState
    AppState --> PtyState
```

### IPC Handler Domains

| Module | Commands | Domain |
|--------|----------|--------|
| `project_handlers` | CRUD, git init, clone, locks | Project management |
| `task_handlers` | CRUD, relationships, instructions, branches | Task management |
| `worktree_handlers` | Create/delete/list, staging, commit, stash | Git worktrees |
| `execution_handlers` | PTY spawn, attach/detach, resize | Terminal sessions |
| `acp_handlers` | Spawn, prompt, cancel, permission, model/mode | Agent sessions |
| `review_handlers` | Diff, save review, approve/reject | Code review |
| `settings_handlers` | App/project/task settings | Configuration |
| `filesystem_handlers` | Directory listing, file picker | File browser |
| `ssh_handlers` | SSH connect, status, WSL | Connections |
| `sftp_handlers` | Upload/download | File transfer |
| `ticketing_handlers` | Provider creds, issue fetching | External tickets |

---

## Communication Protocol

### Two-Tier Protocol Bridge

```mermaid
graph LR
    subgraph Tauri["Tauri App"]
        TW[AcpTransportWriter]
    end

    subgraph MaestroProtocol["Maestro Protocol"]
        MP[Length-prefixed JSON<br/>4-byte LE + JSON body<br/>Max 16 MB]
    end

    subgraph Server["maestro-server"]
        Dispatch[Request Dispatcher]
        Router[Session Router]
    end

    subgraph ACProtocol["Agent Client Protocol"]
        ACP[ACP Client<br/>agent-client-protocol crate]
    end

    subgraph Agent["AI Agent Process"]
        AgentProc[claude / codex / goose / ...]
    end

    TW -->|ServerRequest| MP
    MP -->|stdin/stdout or SSH| Dispatch
    Dispatch --> Router
    Router -->|ACP messages| ACP
    ACP -->|stdio| AgentProc
    AgentProc -->|ACP responses| ACP
    ACP -->|SessionUpdate etc.| Router
    Router -->|ServerResponse| MP
    MP -->|back to Tauri| TW
```

### Message Flow — Full Session Lifecycle

```mermaid
sequenceDiagram
    participant T as Tauri
    participant S as maestro-server
    participant A as Agent (e.g. Claude)

    Note over T,S: Connection Setup
    T->>S: Handshake(version: 1)
    S-->>T: HandshakeOk

    Note over T,S: Agent Discovery
    T->>S: ListAgents
    S-->>T: ListAgentsOk([claude-acp, codex-acp, ...])

    Note over T,S: Pre-Warm (Optional Fast Path)
    T->>S: PreInitialize(agent_id, cwd)
    S->>A: spawn subprocess + ACP Initialize
    A-->>S: InitializeResponse(capabilities)
    S-->>T: PreInitializeOk(models, modes, capabilities)

    Note over T,A: Session Creation
    T->>S: Spawn(agent_id, session_id, cwd)
    S->>A: NewSessionRequest
    A-->>S: NewSessionResponse(acp_session_id)
    S-->>T: SpawnOk(session_id, models, modes)

    Note over T,A: Prompt/Response Loop
    T->>S: Prompt(session_id, "Fix the login bug")
    S->>A: PromptRequest(content)
    
    loop Streaming Updates
        A-->>S: SessionNotification(tool_use, text, etc.)
        S-->>T: SessionUpdate(session_id, payload)
    end

    opt Permission Required
        A-->>S: RequestPermissionRequest
        S-->>T: PermissionRequest(request_id, payload)
        T-->>S: PermitResponse(request_id, allow)
        S-->>A: RequestPermissionResponse(allow)
    end

    opt Agent Asks Question
        A-->>S: elicitation/create
        S-->>T: ElicitationRequest(request_id, message)
        T-->>S: ElicitationResponse(request_id, answer)
        S-->>A: elicitation response
    end

    A-->>S: PromptResponse(stop_reason)
    S-->>T: TurnEnded(session_id, stop_reason)

    Note over T,A: Cleanup
    T->>S: Cancel(session_id)
    S->>A: CloseSessionRequest
    S-->>T: (session removed)
```

### Connection Server Multiplexing

```mermaid
graph TB
    subgraph Tauri["Tauri (one per connection)"]
        CS[ConnectionServer<br/>long-lived maestro-server process]
    end

    subgraph Sessions["Multiplexed Sessions"]
        S1[Session 1<br/>Task: Fix auth bug]
        S2[Session 2<br/>Task: Add tests]
        S3[Session 3<br/>Task: Refactor API]
    end

    subgraph Pool["Session Pool (pre-warmed)"]
        P1[Pre-initialized Session<br/>ready to claim]
    end

    CS --> S1
    CS --> S2
    CS --> S3
    CS -.->|claim on next Spawn| P1
```

One `ConnectionServer` (a long-lived `maestro-server` process) per connection type (Local / SSH / WSL) multiplexes all agent sessions over a single process. Pre-warmed sessions in the pool enable instant session startup.

---

## Database Schema (v16)

```mermaid
erDiagram
    projects ||--o{ tasks : contains
    projects ||--o{ worktrees : has
    projects }o--|| ssh_connections : "connects via"
    projects }o--|| wsl_connections : "connects via"
    tasks ||--o{ task_relationships : "from/to"
    tasks ||--o{ task_instructions : has
    tasks ||--o| worktrees : "assigned to"
    tasks ||--o| task_reviews : reviewed_by
    task_reviews ||--o{ review_comments : contains
    projects ||--o{ known_hosts : trusts
    projects ||--o{ session_aliases : names

    projects {
        int id PK
        string name
        string path
        int connection_id FK
        int wsl_connection_id FK
        datetime created_at
        datetime updated_at
    }

    tasks {
        int id PK
        int project_id FK
        string name
        string description
        string acceptance_criteria
        string status "Backlog|Ready|InProgress|Review|Done"
        int priority
        string base_branch
        string external_id
        string external_url
        string labels
        string model_override
        string skills
    }

    worktrees {
        int id PK
        int project_id FK
        int task_id FK
        string branch_name
        string base_branch
        string path
        string git_status
    }

    task_reviews {
        int id PK
        int task_id FK "UNIQUE"
        string decision "approve|request_changes|reject"
        string general_feedback
    }

    ssh_connections {
        int id PK
        string connection_string "UNIQUE"
        string username
        string host
        int port
        string auth_method
        string display_name
    }
```

---

## SSH & Reconnection

```mermaid
stateDiagram-v2
    [*] --> Connecting
    Connecting --> Connected: Auth success
    Connecting --> Disconnected: Auth failure

    Connected --> Reconnecting: Heartbeat failure
    Connected --> Disconnected: Manual disconnect

    Reconnecting --> Connected: Reconnect success
    Reconnecting --> Disconnected: 5 attempts exhausted

    state Connected {
        [*] --> Heartbeat
        Heartbeat --> Heartbeat: 5s probe ("true" cmd, 8s timeout)
    }

    state Reconnecting {
        [*] --> Attempt1
        Attempt1 --> Attempt2: 3s delay
        Attempt2 --> Attempt3: 6s delay
        Attempt3 --> Attempt4: 12s delay
        Attempt4 --> Attempt5: 24s delay
        Attempt5 --> Failed: 45s delay
    }

    note right of Reconnecting
        On success: restore_acp_sessions()
        reloads all agent sessions
    end note
```

Authentication methods: **Password** (OS keyring or in-memory with zeroize), **SSH Key** (ed25519, RSA, ECDSA + optional passphrase), **SSH Agent** (Unix socket or Windows named pipe).

---

## Agent Ecosystem

Maestro supports **25+ AI agents** via the embedded registry (`registry.json`):

| Agent | Distribution | Notes |
|-------|-------------|-------|
| Claude (claude-acp) | npx | Primary agent |
| Codex (codex-acp) | npx | OpenAI agent |
| Goose | binary / uvx | Block agent |
| OpenCode | binary | Terminal-native |
| Cursor | binary | IDE agent |
| Gemini | binary | Google agent |
| GitHub Copilot CLI | binary | GitHub agent |
| Amp | binary | Sourcegraph |
| Auggie | npx | Augment Code |
| Kilo | binary | Anthropic mini |
| + 15 more | various | See registry.json |

Detection methods:
- **`DetectInstalledAgents`** — batch `which` + config directory checks
- **`DetectProjectAgents`** — scans working directory for agent marker files

---

## Key Architectural Patterns

| Pattern | Where | Why |
|---------|-------|-----|
| **Event-driven cache sync** | Frontend | Tauri events invalidate TanStack Query caches — no polling for most data |
| **Connection-server pooling** | ACP Manager | One maestro-server per connection multiplexes all sessions — avoids per-session process overhead |
| **Session pre-warming** | ACP Manager | Background pre-spawn sessions for instant user experience |
| **Two-tier protocol bridge** | maestro-server | Maestro protocol (simple JSON) wraps ACP protocol (full-featured) cleanly |
| **Proxy Result unwrapping** | Frontend IPC | TypeScript Proxy auto-unwraps `Result<T, E>` → clean `Promise<T>` ergonomics |
| **Zustand + Immer** | State management | Direct mutations proxied to immutable updates — safe and ergonomic |
| **Graceful degradation** | SSH reconnection | Heartbeat → exponential backoff → session restore on reconnect |
| **Framed RPC** | Protocol | 4-byte LE length + JSON body — simple, debuggable, 16MB cap |
| **Compile-time registry** | Agent discovery | `include_str!` embeds registry — no runtime config file needed |
| **Destructive migration** | Database | Drop-and-recreate on schema bump — acceptable for dev-phase app |

---

## Directory Structure Summary

```
maestro/
├── src/                          # React frontend
│   ├── views/                    #   Route views (5)
│   ├── components/               #   UI components by domain
│   │   ├── ui/                   #     shadcn/ui primitives (50+)
│   │   ├── kanban/               #     Board, columns, cards
│   │   ├── task/                 #     Task form, detail, context menu
│   │   ├── execution/            #     Agent monitor, terminals, worktrees
│   │   │   └── activity/         #       Live agent activity feed
│   │   ├── project-picker/       #     Connection + project selection
│   │   └── common/               #     Shared (header, settings, theme)
│   ├── services/                 #   IPC service layer (6 domains)
│   ├── store/                    #   Zustand stores (6)
│   ├── contexts/                 #   React contexts (2)
│   ├── providers/                #   Provider components (2)
│   ├── types/                    #   Generated bindings (tauri-specta)
│   └── utils/                    #   Hooks, helpers, constants
├── src-tauri/src/                # Rust backend (Tauri)
│   ├── ipc/                      #   Command handlers (11 modules)
│   ├── models/                   #   Data models (ts-rs derive)
│   ├── db/                       #   SQLite schema, storage, migrations
│   ├── acp/                      #   ACP session management
│   ├── ssh/                      #   SSH connections + reconnection
│   ├── process/                  #   PTY + remote process spawning
│   └── streaming/                #   WebSocket streaming adapter
├── maestro-server/src/           # Headless server binary
│   ├── main.rs                   #   Dispatch loop (stdin/stdout)
│   ├── session_handler.rs        #   ACP protocol bridge
│   ├── registry.rs               #   Agent discovery (embedded JSON)
│   ├── agent.rs                  #   Subprocess spawning
│   ├── sessions.rs               #   Session state + routing
│   ├── detection.rs              #   Installed agent detection
│   ├── terminal.rs               #   Agent terminal management
│   └── file_ops.rs               #   Secure file search/read
├── maestro-protocol/src/         # Shared wire-format types
│   └── lib.rs                    #   MaestroRpcMessage, framing
└── .maestro/                     # Per-project storage
    ├── settings.json             #   Project config
    ├── state.json                #   Runtime state
    └── bin/                      #   Bundled maestro-server
```
