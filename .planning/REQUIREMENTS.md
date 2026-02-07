# Requirements: AI Agent Orchestrator

**Defined:** 2026-02-04
**Core Value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control

## v1.0 Requirements

Requirements for initial MVP release. Each maps to roadmap phases.

### Orchestration

- [ ] **ORCH-01**: User can create tasks manually with description, context, and acceptance criteria
- [ ] **ORCH-02**: User can configure project to sync with either GitHub project issues OR Jira project issues (mutually exclusive, auto-sync on project open)
- [ ] **ORCH-03**: User can view Kanban board with 5 columns (Backlog → Ready → In Progress → Review → Done)
- [ ] **ORCH-04**: User can drag-drop tasks between Kanban columns
- [ ] **ORCH-05**: User can configure task with model selection (Claude model version)
- [ ] **ORCH-06**: User can configure task with MCP server allowlist
- [ ] **ORCH-07**: User can configure task with Skills selection
- [x] **ORCH-08**: User can close and reopen app without losing task queue state (SQLite persistence)

### Agent Execution

- [ ] **EXEC-01**: User can execute agent on task in isolated git worktree
- [ ] **EXEC-02**: User can view real-time terminal output while agent executes
- [ ] **EXEC-03**: User can see agent status indicators (running/paused/failed/complete)
- [x] **EXEC-04**: User can attach to embedded terminal to send input (Ctrl+C, manual commands)
- [x] **EXEC-05**: User can detach from terminal while agent continues execution
- [x] **EXEC-06**: System pauses agent execution on failure and notifies user
- [ ] **EXEC-07**: User can view agent output history (terminal logs, git diffs, errors) for completed tasks
- [x] **EXEC-08**: System automatically cleans up worktree and branch after successful merge
- [x] **EXEC-09**: User can run multiple agents in parallel on different tasks (hybrid worktree pool)
- [x] **EXEC-10**: System pre-creates 3-5 worktrees for instant allocation and expands dynamically if exhausted

### Review & Merge

- [ ] **REV-01**: User can view file diffs for task in Review column
- [ ] **REV-02**: User can approve task in Review column to trigger merge
- [ ] **REV-03**: User can reject task in Review column with feedback
- [ ] **REV-04**: System automatically merges approved task branch to main
- [x] **REV-05**: System automatically deletes worktree and branch after merge completes

### Configuration

- [x] **CFG-01**: User can configure project settings (default Claude model, git repo path)
- [ ] **CFG-02**: User can set project-level defaults for MCP servers
- [ ] **CFG-03**: User can set project-level defaults for Skills
- [ ] **CFG-04**: User can override project defaults at task level (restrict MCP/Skills per task)

### Remote Projects

- [ ] **REM-01**: User can configure remote SSH connection for entire project (host, port, credentials, remote project path)
- [ ] **REM-02**: User can work with remote project where git repository, worktrees, and all operations exist on remote machine
- [ ] **REM-03**: User can execute agent sessions on remote machine via SSH tunnel (desktop app is UI only)
- [ ] **REM-04**: User can view real-time terminal output from remote agent execution streamed over SSH
- [ ] **REM-05**: User can view file diffs from remote worktrees during review workflow

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Workflows

- **FLOW-01**: User can open task worktree in VS Code for review (IDE integration)
- **FLOW-02**: Agent automatically picks next Ready task after merge approval (autonomous loop)
- **FLOW-03**: User can abort running task and automatically rollback uncommitted changes
- **FLOW-04**: User can reorder tasks in Backlog and mark priority

### Advanced Monitoring

- **MON-01**: User can view real-time file diffs while agent executes (live diff viewer)
- **MON-02**: User can view file change timeline during execution

### Advanced Configuration

- **ADV-CFG-01**: User can add/remove/enable MCP servers via UI (MCP management)
- **ADV-CFG-02**: User can add/remove Skills via UI (Skills management)
- **ADV-CFG-03**: User can define task dependencies (Task A blocks Task B)
- **ADV-CFG-04**: User can configure pre-execution and post-execution hooks

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Multi-project switching | MVP focuses on single project workflow. Users open multiple app instances if needed. Defer to v2. |
| OpenCode and other CLI tools | Claude Code CLI only in v1. Architecture supports future tools. Defer to v2. |
| Plugin marketplace | Leverage existing Claude Code plugin architecture. Build after core features solid. Defer to v2. |
| Multi-user collaboration | Single user focus for v1. Multi-user collaboration deferred to v2+. |
| Cloud relay for remote sessions | SSH tunneling sufficient for v1. Defer to v3+. |
| Custom worktree retention policies | Clean up immediately after merge. Defer to v2. |
| Webhook integration for issue sync | Auto-sync on open sufficient. Defer to v2. |
| Automatic agent retries | Fail fast, notify immediately. User decides retry strategy. |
| Real-time everything (100ms updates) | Stream only significant events to prevent noise. |
| Fully autonomous (no human gates) | Human review gates mandatory for safety. Will not implement. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ORCH-01 | Phase 2 | Pending |
| ORCH-02 | Phase 2 | Pending |
| ORCH-03 | Phase 2 | Pending |
| ORCH-04 | Phase 2 | Pending |
| ORCH-05 | Phase 7 | Pending |
| ORCH-06 | Phase 7 | Pending |
| ORCH-07 | Phase 2 | Pending |
| ORCH-08 | Phase 1 | Complete |
| EXEC-01 | Phase 4 | Pending |
| EXEC-02 | Phase 5 | Pending |
| EXEC-03 | Phase 4 | Pending |
| EXEC-04 | Phase 8 | Complete |
| EXEC-05 | Phase 8 | Complete |
| EXEC-06 | Phase 8 | Complete |
| EXEC-07 | Phase 4 | Pending |
| EXEC-08 | Phase 3 | Complete |
| EXEC-09 | Phase 3 | Complete |
| EXEC-10 | Phase 3 | Complete |
| REV-01 | Phase 6 | Pending |
| REV-02 | Phase 6 | Pending |
| REV-03 | Phase 6 | Pending |
| REV-04 | Phase 6 | Pending |
| REV-05 | Phase 3 | Complete |
| CFG-01 | Phase 1 | Complete |
| CFG-02 | Phase 7 | Pending |
| CFG-03 | Phase 7 | Pending |
| CFG-04 | Phase 7 | Pending |
| REM-01 | Phase 9 | Pending |
| REM-02 | Phase 9 | Pending |
| REM-03 | Phase 9 | Pending |
| REM-04 | Phase 9 | Pending |
| REM-05 | Phase 9 | Pending |

**Coverage:**
- v1 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-04*
*Last updated: 2026-02-07 after Phase 8 completion*
