# Roadmap: AI Agent Orchestrator

## Overview

Build a complete AI agent orchestration platform that enables users to queue tasks on a Kanban board, execute autonomous agents in isolated git worktrees with real-time monitoring, and approve merges through a human-in-the-loop review gate. Start with a strong foundation of database and UI infrastructure, layer in worktree isolation and agent execution, add real-time monitoring and review workflows, then enable full configuration control and remote project support.

## Phases

**Phase Numbering:**
- Integer phases (1-9): Planned milestone work
- Decimal phases (X.1, X.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Foundation** - Project setup, database schema, app shell, type definitions
- [x] **Phase 2: Core Orchestration** - Task management, Kanban board, column workflows
- [x] **Phase 3: Git Worktree Infrastructure** - Worktree creation, pooling, cleanup
- [~] **Phase 4: Agent Execution** - Process management, Claude Code CLI integration (gaps found)
- [x] **Phase 5: Real-time Monitoring** - Terminal streaming, status indicators, output history
- [x] **Phase 6: Review & Merge Workflow** - File diffs, approval gate, automatic merge and cleanup
- [x] **Phase 7: Configuration Management** - Task/project-level model, MCP, Skills config
- [x] **Phase 8: Error Handling & Polish** - Failure detection, pause, recovery, attach/detach terminal
- [ ] **Phase 9: Remote Project Support** - SSH tunneling, remote git operations, remote execution

## Phase Details

### Phase 1: Foundation
**Goal**: Establish database persistence, app shell, and type definitions so all subsequent phases have a solid foundation.

**Depends on**: Nothing (first phase)

**Requirements**: ORCH-08 (SQLite persistence), CFG-01 (project settings)

**Success Criteria** (what must be TRUE):
  1. User can open app and it persists project path and settings across restarts
  2. Database schema exists with tables for projects, tasks, worktrees, execution logs
  3. Type definitions exist for Task, Workflow, Agent, ProcessHandle across all layers
  4. React app renders with Tauri IPC connection established and working

**Plans**: 4 plans

Plans:
- [x] 01-01-PLAN.md — Create SQLite database schema with PRAGMA versioning and connection pooling
- [x] 01-02-PLAN.md — Set up Tauri 2 + React 18 + Vite frontend shell with IPC connection
- [x] 01-03-PLAN.md — Define Rust types with ts-rs code generation for auto-generated TypeScript bindings
- [x] 01-04-PLAN.md — Implement project picker UI and settings persistence

### Phase 2: Core Orchestration
**Goal**: Enable users to manage tasks via Kanban board with full column workflow support.

**Depends on**: Phase 1

**Requirements**: ORCH-01 (manual task creation), ORCH-02 (GitHub/Jira import), ORCH-03 (Kanban board), ORCH-04 (drag-drop), ORCH-07 (Skills selection)

**Success Criteria** (what must be TRUE):
  1. User can manually create task with description, context, acceptance criteria, and skills assignment
  2. User can import issues from GitHub or Jira project (mutually exclusive, syncs on button click)
  3. User can view Kanban board with 5 columns (Backlog → Ready → In Progress → Review → Done)
  4. User can drag-drop tasks between columns and see changes persist

**Plans**: 5 plans

Plans:
- [x] 02-01-PLAN.md — Kanban board UI with 5 columns, Zustand state management, React Beautiful DnD drag-drop integration
- [x] 02-02-PLAN.md — Backend task creation: create_task IPC handler and TypeScript bindings with skills field
- [x] 02-03-PLAN.md — Frontend task creation modal with React Hook Form, Radix Dialog, skills multi-select field
- [x] 02-04-PLAN.md — Backend GitHub/Jira sync: sync_github_issues, sync_jira_issues handlers with conflict detection
- [x] 02-05-PLAN.md — Frontend import settings: ImportSettings UI, SyncButton component, ErrorToast notifications, read-only protection

### Phase 3: Git Worktree Infrastructure
**Goal**: Establish isolated git worktrees for parallel agent execution with automatic cleanup.

**Depends on**: Phase 1

**Requirements**: EXEC-09 (parallel agents), EXEC-10 (hybrid worktree pool with pre-create and dynamic expand), REV-05 (cleanup after merge)

**Success Criteria** (what must be TRUE):
  1. System pre-creates 3-5 worktrees for instant allocation to tasks
  2. System automatically creates additional worktrees if pool is exhausted
  3. User can run multiple agents in parallel on different tasks without conflicts
  4. System automatically deletes worktree and branch after task merge to main

**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — Node.js sidecar git manager (create, delete, reset worktrees via simple-git)
- [x] 03-02-PLAN.md — Worktree pooling logic (lease, return, dynamic expansion with state machine)
- [x] 03-03-PLAN.md — Automatic cleanup workflow (safe deletion, dirty-state recovery, prune stale metadata)
- [x] 03-04-PLAN.md — Pool pre-creation on project open (instant allocation, lazy git creation)

### Phase 4: Agent Execution
**Goal**: Enable executing agents on tasks in isolated worktrees and capturing execution lifecycle.

**Depends on**: Phase 2, Phase 3

**Requirements**: EXEC-01 (execute agent in worktree), EXEC-03 (status indicators), EXEC-06 (pause on failure), EXEC-07 (output history), EXEC-08 (cleanup after merge)

**Success Criteria** (what must be TRUE):
  1. User can click "Execute" on a task and agent runs in its leased worktree
  2. User can see agent status indicator (running/paused/failed/complete) on task
  3. System automatically pauses on agent failure and notifies user
  4. User can view output history (terminal logs, git diffs, errors) for completed tasks

**Plans**: 4 plans

Plans:
- [x] 04-01-PLAN.md — Create async process spawner module with tokio (non-blocking CLI execution)
- [x] 04-02-PLAN.md — Implement execution log persistence and spawn_agent_execution handler (background tasks)
- [x] 04-03-PLAN.md — Integrate agent execution into task UI with Execute button (status tracking)
- [x] 04-04-PLAN.md — Create execution history and task detail UI (output viewer, timestamps)

**Verification**: 2/4 criteria met - Critical gaps: pause mechanism, notifications (see 04-VERIFICATION.md)

### Phase 5: Real-time Monitoring
**Goal**: Stream real-time terminal output and enable interactive terminal access during execution.

**Depends on**: Phase 4

**Requirements**: EXEC-02 (real-time terminal output), EXEC-04 (attach to terminal), EXEC-05 (detach while agent continues)

**Success Criteria** (what must be TRUE):
  1. User can see live terminal output while agent executes (streamed via Tauri channels)
  2. User can attach to embedded terminal and send input (Ctrl+C, manual commands)
  3. User can detach from terminal while agent continues running in background
  4. Terminal output is captured and searchable in execution history

**Plans**: 3 plans

Plans:
- [x] 05-01-PLAN.md — PTY spawning and backend streaming infrastructure (portable-pty + Tauri channels)
- [x] 05-02-PLAN.md — xterm.js terminal UI component with attach/detach (React integration)
- [x] 05-03-PLAN.md — Terminal output persistence, resizing, and memory management (CircularBuffer)

### Phase 6: Review & Merge Workflow
**Goal**: Implement human-in-the-loop approval gate with file diffs and automatic merge.

**Depends on**: Phase 4, Phase 5

**Requirements**: REV-01 (file diffs), REV-02 (approve to trigger merge), REV-03 (reject with feedback), REV-04 (automatic merge), REV-05 (automatic cleanup)

**Success Criteria** (what must be TRUE):
  1. User can view file diffs for task in Review column showing exactly what agent changed
  2. User can approve task to trigger merge to main or reject with feedback
  3. System automatically merges approved branch to main
  4. System automatically cleans up worktree and branch after successful merge

**Plans**: 5 plans (3 main + 2 gap closure)

Plans:
- [x] 06-01-PLAN.md — Diff viewer infrastructure with @git-diff-view/react and file tree navigation
- [x] 06-02-PLAN.md — Approval workflow with feedback capture and request-changes state transition
- [x] 06-03-PLAN.md — Automatic squash merge, conflict detection, and worktree cleanup
- [x] 06-04-PLAN.md (gap closure) — Integrate ReviewModal into UI (Review button on TaskCard)
- [x] 06-05-PLAN.md (gap closure) — Implement sidecar --merge CLI handler and merge outcome parsing

### Phase 7: Configuration Management
**Goal**: Enable users to control agent capabilities through task and project-level configuration.

**Depends on**: Phase 2, Phase 6

**Requirements**: ORCH-05 (model selection per task), ORCH-06 (MCP allowlist per task), ORCH-07 (Skills per task), CFG-01 (project settings), CFG-02 (project MCP defaults), CFG-03 (project Skills defaults), CFG-04 (task-level override)

**Success Criteria** (what must be TRUE):
  1. User can select Claude model version per task (and see project default)
  2. User can configure MCP server allowlist at project level and override per task
  3. User can configure Skills at project level and override per task
  4. User can view and edit project settings (Claude model default, git repo path)

**Plans**: 3 plans

Plans:
- [x] 07-01-PLAN.md — Data model + database schema + IPC handlers for project and task configuration
- [x] 07-02-PLAN.md — Project settings UI (model dropdown, MCP checkboxes, Skills checkboxes via gear icon)
- [x] 07-03-PLAN.md — Task settings UI (model/MCP/Skills overrides via context menu, separate modal)

### Phase 8: Error Handling & Polish
**Goal**: Detect failures, pause execution, and enable user recovery actions and interactive debugging.

**Depends on**: Phase 5, Phase 6

**Requirements**: EXEC-06 (pause on failure), EXEC-04 (embed terminal for interactive control), EXEC-05 (detach while continuing)

**Success Criteria** (what must be TRUE):
  1. When agent fails, system immediately pauses and notifies user with error details
  2. User can open embedded terminal to send input interactively (Ctrl+C, manual fixes)
  3. User can detach terminal and resume execution or abort task
  4. Execution history shows error events, terminal output, and recovery attempts

**Plans**: 3 plans

Plans:
- [x] 08-01-PLAN.md — Error detection and pause logic (process exit code, stderr parsing, categorization, auto-retry)
- [x] 08-02-PLAN.md — Terminal attach/detach functionality (PTY management, signal handling, interactive input)
- [x] 08-03-PLAN.md — Recovery UI (resume, abort actions, error notifications, execution history display)

### Phase 9: Remote Project Support
**Goal**: Enable users to work with remote projects via SSH where all operations execute on remote machine.

**Depends on**: Phase 3, Phase 4, Phase 8

**Requirements**: REM-01 (SSH connection config), REM-02 (remote git repo and worktrees), REM-03 (remote agent execution), REM-04 (remote terminal streaming), REM-05 (remote file diffs)

**Success Criteria** (what must be TRUE):
  1. User can configure remote SSH connection (host, port, credentials, remote path)
  2. User can view remote project with git repository and worktrees on remote machine
  3. Agent execution, terminal streaming, and file diffs all work over SSH tunnel
  4. User is unaware of local vs remote — UI experience is identical

**Plans**: 5 plans (4 main + 1 gap closure)

Plans:
- [x] 09-01-PLAN.md — SSH connection infrastructure + RemoteSshSession + host key verification
- [x] 09-02-PLAN.md — Remote git operations dispatcher (routes git commands to local or remote)
- [x] 09-03-PLAN.md — Remote process execution (spawn Claude Code CLI on remote via SSH PTY)
- [x] 09-04-PLAN.md — Remote terminal streaming + UI integration (project creation flow, status indicators)
- [x] 09-05-PLAN.md (gap closure) — Complete terminal streaming integration (SSH PTY polling, WebSocket bridge, handler wiring)

### Phase 10: Documentation Completeness
**Goal**: Complete administrative documentation for all phases.

**Depends on**: Phase 2

**Tech Debt Closure**: Phase 2 - Core Orchestration

**Success Criteria** (what must be TRUE):
  1. Phase 2 has a VERIFICATION.md file documenting all implemented features
  2. All phase verification files are present and complete
  3. Audit can verify Phase 2 from documentation rather than code inspection

**Plans**: 1 plan

Plans:
- [ ] 10-01-PLAN.md — Generate Phase 2 VERIFICATION.md file documenting Kanban board, task creation, GitHub/Jira import, drag-drop persistence with full evidence chain

### Phase 11: Agent Execution UX Polish
**Goal**: Complete all UX features for agent execution workflow.

**Depends on**: Phase 4

**Tech Debt Closure**: Phase 4 - Agent Execution

**Success Criteria** (what must be TRUE):
  1. TaskCard displays visual status badge showing agent execution state
  2. Agent execution uses actual worktree leasing instead of placeholder path
  3. Users can pause and resume agent execution with proper state management
  4. Users receive notifications when agents fail with actionable information

**Plans**: 4 plans

Plans:
- [ ] 11-01-PLAN.md — Wire status badge rendering in TaskCard JSX component
- [ ] 11-02-PLAN.md — Replace placeholder worktree path with lease_worktree integration
- [ ] 11-03-PLAN.md — Implement pause/resume mechanism with state management
- [ ] 11-04-PLAN.md — Add user notification system on agent failure

### Phase 12: Worktree Disk Cleanup
**Goal**: Ensure worktrees are fully cleaned from disk after merge.

**Depends on**: Phase 6

**Tech Debt Closure**: Phase 6 - Review & Merge Workflow

**Success Criteria** (what must be TRUE):
  1. After successful merge, worktree is deleted from disk (not just returned to pool)
  2. Disk space is reclaimed after worktree cleanup
  3. No stale worktree directories accumulate over time

**Plans**: 1 plan

Plans:
- [ ] 12-01-PLAN.md — Add disk cleanup to finalize_successful_merge handler

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 1. Foundation | 4 | ✓ Complete | 2026-02-04 |
| 2. Core Orchestration | 5 | ✓ Complete | 2026-02-05 |
| 3. Git Worktree Infrastructure | 4 | ✓ Complete | 2026-02-05 |
| 4. Agent Execution | 4 | ✓ Complete | 2026-02-06 |
| 5. Real-time Monitoring | 3 | ✓ Complete | 2026-02-06 |
| 6. Review & Merge Workflow | 5 (3 main + 2 gap closure) | ✓ Complete | 2026-02-07 |
| 7. Configuration Management | 3 | ✓ Complete | 2026-02-07 |
| 8. Error Handling & Polish | 3 | ✓ Complete | 2026-02-07 |
| 9. Remote Project Support | 5 (4 main + 1 gap closure) | ✓ Complete | 2026-02-08 |
| 10. Documentation Completeness | 1 | Pending | — |
| 11. Agent Execution UX Polish | 4 | Pending | — |
| 12. Worktree Disk Cleanup | 1 | Pending | — |

**Total Plans:** 44 (37 main + 1 gap closure + 6 tech debt)
**Completed Plans:** 38/44 (Phase 1: 4/4, Phase 2: 5/5, Phase 3: 4/4, Phase 4: 4/4, Phase 5: 3/3, Phase 6: 5/5, Phase 7: 3/3, Phase 8: 3/3, Phase 9: 5/5, Phase 10: 0/1, Phase 11: 0/4, Phase 12: 0/1)
**Total Requirements Mapped:** 28/28 ✓

---

*Roadmap created: 2026-02-04*
*Phase 8 completed: 2026-02-07*
*Phase 9 completed: 2026-02-08*
*Tech debt phases added: 2026-02-08*
*Depth: comprehensive (12 phases including tech debt closure)*
*Coverage: 100% — All 28 v1.0 requirements mapped + tech debt closure*
