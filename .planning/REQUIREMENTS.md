# Requirements: Maestro

**Defined:** 2026-04-17
**Core Value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control

## v1.5 Requirements

### ACP Server (maestro-server)

- [x] **SERVER-01**: maestro-server receives SpawnRequest on stdin, spawns ACP agent subprocess via ClientSideConnection, returns SpawnOk on stdout
- [x] **SERVER-02**: maestro-server forwards structured session updates (agent messages, tool calls, diffs, plans) to stdout as ServerResponse::SessionUpdate
- [x] **SERVER-03**: maestro-server forwards raw terminal output from ACP agent terminal callbacks to stdout as ServerResponse::TerminalOutput
- [x] **SERVER-04**: maestro-server forwards permission requests to desktop as ServerResponse::PermissionRequest and awaits PermissionResponse on stdin to unblock the agent

### Local Session Management

- [x] **SESSION-01
**: Tauri backend launches maestro-server as local subprocess per ACP session with piped stdin/stdout
- [x] **SESSION-02
**: ACP sessions tracked in AppState (acp_sessions: tokio::sync::Mutex<HashMap<i32, AcpSession>>, keyed by log_id)
- [x] **SESSION-03
**: Tauri emits typed events per session (acp://session-update/{log_id}, acp://permission-request/{log_id}, acp://terminal-output/{log_id}) from background reader task

### Database & IPC

- [x] **PERSIST-01
**: Schema v11 adds execution_mode TEXT DEFAULT 'pty', agent_id TEXT, structured_output TEXT columns to execution_logs
- [x] **PERSIST-02
**: User can spawn ACP session via IPC (creates execution_log with execution_mode='acp', launches maestro-server subprocess, returns log_id)
- [x] **PERSIST-03
**: User can send prompt to running ACP session via IPC (forwards PromptRequest to maestro-server stdin)
- [x] **PERSIST-04
**: User can respond to permission request via IPC (forwards PermissionResponse to maestro-server stdin, unblocking agent)
- [x] **PERSIST-05
**: User can cancel ACP session via IPC (forwards CancelRequest, cleans up session)
- [ ] **PERSIST-06**: Structured output periodically flushed from in-memory AcpSession.structured_updates to DB execution_logs.structured_output for dead session replay

### Agent Registry

- [ ] **REGISTRY-01**: User can fetch list of available ACP agents from CDN registry (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- [ ] **REGISTRY-02**: Registry cached in AppState with 5-min TTL; user can force refresh via IPC
- [ ] **REGISTRY-03**: Agent launch command resolved from AgentInfo.distribution (npx package / binary target / uvx package) for use in SpawnRequest

### Frontend: Agent Selector

- [ ] **SPAWN-01**: User can browse and search available ACP agents by name and description in a modal
- [ ] **SPAWN-02**: User can spawn an ACP session by selecting an agent, choosing a worktree/branch, and clicking Spawn
- [ ] **SPAWN-03**: ACP sessions displayed with "ACP" badge in execution sidebar alongside PTY ("Interactive") sessions

### Frontend: Activity Panel

- [ ] **ACTIVITY-01**: User sees structured ACP agent output (messages, tool calls with args/results, file diffs, plans) in real-time via Tauri event subscription
- [ ] **ACTIVITY-02**: User sees raw terminal output alongside structured output in a split pane using existing TerminalComponent
- [ ] **ACTIVITY-03**: Completed ACP sessions replay structured output loaded from DB (dead session view)

### Frontend: Permission Dialog

- [ ] **PERM-01**: User sees permission dialog when agent requests file write, terminal command, or other tool permission
- [ ] **PERM-02**: User can allow or deny individual permission requests; decision forwarded via respond_acp_permission IPC
- [ ] **PERM-03**: User can allow all future requests for a given tool within the session (session-scoped allowlist in acpSessionStore)
- [ ] **PERM-04**: Pending permission requests shown as urgent indicator (inline banner in ActivityPanel + global badge when on different tab)

### Dual-Mode Dispatch

- [ ] **DISPATCH-01**: spawn_interactive_execution routes to ACP path when agent_id provided and found in registry, PTY path otherwise
- [ ] **DISPATCH-02**: attach_terminal handles both ACP sessions (serves terminal_output buffer) and PTY sessions (existing path)
- [ ] **DISPATCH-03**: All existing PTY execution flows continue working unchanged

## v2 Requirements

### Remote ACP

- **REMOTE-01**: maestro-server binary deployed to remote host via SFTP upload with version check
- **REMOTE-02**: User can run ACP agents on remote SSH projects (maestro-server launched over SSH exec channel)
- **REMOTE-03**: maestro-server cross-compiled for linux-aarch64, linux-x86_64-musl targets

### Multi-Agent

- **MULTI-01**: User can run multiple ACP agents concurrently on separate worktrees
- **MULTI-02**: User can view all active ACP sessions across the project

### Registry UI

- **REGUI-01**: User can browse full agent registry with filtering by capability/language
- **REGUI-02**: User can assign a default agent per task on Kanban board

## Out of Scope

| Feature | Reason |
|---------|--------|
| SSH stdio tunnel for remote ACP | 2 SSH round-trips per file op = unacceptable latency; use remote server model in v2 |
| Multi-project agent coordination | Deferred to v2 |
| Agent ratings / reviews | Out of scope for v1 |
| Streamable HTTP transport | Draft only, no SDK/agent support |
| Per-task agent assignment on Kanban | Deferred to v2 with multi-agent support |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SERVER-01 | Phase 42 | Complete |
| SERVER-02 | Phase 42 | Complete |
| SERVER-03 | Phase 42 | Complete |
| SERVER-04 | Phase 42 | Complete |
| SESSION-01 | Phase 43 | Pending |
| SESSION-02 | Phase 43 | Pending |
| SESSION-03 | Phase 43 | Pending |
| PERSIST-01 | Phase 44 | Pending |
| PERSIST-02 | Phase 44 | Pending |
| PERSIST-03 | Phase 44 | Pending |
| PERSIST-04 | Phase 44 | Pending |
| PERSIST-05 | Phase 44 | Pending |
| PERSIST-06 | Phase 44 | Pending |
| REGISTRY-01 | Phase 45 | Pending |
| REGISTRY-02 | Phase 45 | Pending |
| REGISTRY-03 | Phase 45 | Pending |
| SPAWN-01 | Phase 46 | Pending |
| SPAWN-02 | Phase 46 | Pending |
| SPAWN-03 | Phase 46 | Pending |
| ACTIVITY-01 | Phase 47 | Pending |
| ACTIVITY-02 | Phase 47 | Pending |
| ACTIVITY-03 | Phase 47 | Pending |
| PERM-01 | Phase 48 | Pending |
| PERM-02 | Phase 48 | Pending |
| PERM-03 | Phase 48 | Pending |
| PERM-04 | Phase 48 | Pending |
| DISPATCH-01 | Phase 49 | Pending |
| DISPATCH-02 | Phase 49 | Pending |
| DISPATCH-03 | Phase 49 | Pending |

**Coverage:**
- v1.5 requirements: 29 total
- Mapped to phases: 29
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-17*
*Last updated: 2026-04-17 after milestone v1.5 initialization*
