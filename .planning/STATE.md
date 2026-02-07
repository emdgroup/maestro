# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-04)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control—eliminating blocking waits while maintaining safety through worktree isolation and human-in-the-loop review.

**Current focus:** Phase 6 - Review & Merge Workflow

## Current Position

Phase: 6 of 9 (Review & Merge Workflow)
Plan: 1 of 3 complete
Status: Plan 06-01 complete (Diff Viewer Infrastructure)
Last activity: 2026-02-07 — Completed Plan 06-01 (Review Infrastructure)

Progress: [██████░░░░] 21/31 plans (68%), 5/9 phases, 1/3 phase 6 plans complete

## Performance Metrics

**Velocity:**
- Total plans completed: 20
- Average duration: 22.8 min (improving)
- Total execution time: 7h 36m

**By Phase:**

| Phase | Plans | Total | Avg/Plan | Status |
|-------|-------|-------|----------|--------|
| 01-foundation | 4 | 63m | 15.75m | Complete |
| 02-core-orchestration | 5 | 244m | 48.8m | Complete |
| 03-git-worktree-infrastructure | 4 | 134m | 33.5m | Complete |
| 04-agent-execution | 4 | 120m | 30m | Complete (gaps noted) |
| 05-real-time-monitoring | 3 | 78m | 26m | Complete ✓ |
| 06-review-merge-workflow | 3 | 13m+ | 13m+ | In Progress (1/3) |

**Recent Trend:**
- Last 7 plans: 04-03 (37m), 04-04 (5m), 05-01 (35m), 05-02 (25m), 05-03 (18m), 06-01 (13m)
- Phase 6 starting: Plan 06-01 executed in 13 minutes (fastest phase plan yet)
- Velocity improving: Diff viewer infrastructure delivered with full Shiki syntax highlighting
- Current: Phase 6 plan 06-01 complete, ready for 06-02 (Approval Workflow)

*Updated: 2026-02-07 (after Plan 06-01 completion)*

## Accumulated Context

### Decisions

Key decisions affecting current work (full log in PROJECT.md):

- **Architecture:** Tauri 2 + React + Rust backend + Node.js sidecar for Claude Code CLI integration
- **Database:** SQLite (better-sqlite3 for Node, rusqlite for Rust) — single file, zero server overhead
- **Worktree Strategy:** Hybrid pool (pre-create 3-5, expand dynamically) — enables parallel agents
- **Process Management:** spawn via Node.js sidecar (cleaner for Claude Code CLI)
- **Terminal Streaming:** WebSocket + xterm.js (real-time, not polling)
- **Depth:** Comprehensive (9 phases, ~30 plans)

**Phase 01-01 Decisions:**
- rusqlite 0.31 with bundled SQLite for no external dependencies
- PRAGMA user_version for schema versioning (no external migration tool)
- ISO 8601 text timestamps for JSON/Serde compatibility
- AppState struct with Mutex<Connection> for thread-safe access

**Phase 01-02 Decisions:**
- Vite build output to src-tauri/gen/web (Tauri's expected frontend dist)
- CSS variables for theming and design consistency
- IPC stub returning empty Vec rather than mock data
- Platform-specific app data directories for multi-platform support

**Phase 01-03 Decisions:**
- ts-rs 7.1 for compile-time TypeScript generation (single source of truth)
- String literal enums in TypeScript (better for JSON serialization, pattern matching)
- Commit bindings.ts to repo (easier code review, simpler CI vs always regenerating)
- Separate models module for clean organization
- Settings handlers stubbed for Phase 01-04 database persistence

**Phase 01-04 Decisions:**
- Settings stored as key-value pairs in SQLite (flexible for future extensions)
- JSON serialization for complex values (recent_projects array)
- Transaction-based writes for atomic consistency
- Max 5 recent projects to prevent unbounded growth
- AppState wrapped in Arc for thread-safe sharing across Tauri handlers

**Phase 02-01 Decisions:**
- Migrated drag-drop library from react-beautiful-dnd to @dnd-kit/core v6.3.1 (React 19 peer-dep conflict resolved)
- Zustand + Immer middleware for board state management (lightweight, mutable-style updates)
- CSS Grid with repeat(5, 1fr) layout ensures all 5 columns fit viewport without horizontal scroll
- TaskStatus enum expanded to 5 states (Backlog, Ready, InProgress, Review, Done) for agent-managed workflow
- Task cards display name only per Phase 2 spec (no description preview), import badge for external tasks
- IPC invoke pattern for async database operations (get_tasks on mount, update_task on drop)

**Phase 02-02 Decisions:**
- Skills stored as JSON array in TEXT column for flexibility and future extensibility
- Input validation enforces minimum lengths (name 3-255, description 10+, acceptance_criteria 10+) to prevent empty submissions at source
- CreateTaskRequest interface made with required fields (not optional) to enforce type safety and frontend validation alignment
- ts-rs export_dir configured for automatic TypeScript bindings generation
- Handler returns complete Task object with auto-generated ID and 'backlog' default status

**Phase 02-03 Decisions:**
- React Hook Form chosen with onBlur validation mode for efficient re-renders
- Radix UI Select used for skills multi-select (WAI-ARIA compliant, keyboard accessible)
- Skills field made optional in form (can submit tasks without skills)
- Modal state managed in App.tsx (global scope for easy access to New Task button)
- New Task button placed in header right side for visibility
- TaskModal handles IPC invocation and error display (error banner)
- Zustand store updated immediately on task creation (no wait for modal close)

**Phase 02-04 Decisions:**
- Async IPC handlers for GitHub/Jira API calls using reqwest (better performance than blocking HTTP)
- Transaction-based upserts for atomic consistency across task creation/updates
- Non-fatal error handling: errors in SyncResult.error_message, not thrown (allows partial success)
- External ID conflict detection: GitHub issue.number and Jira issue.key stored in external_id column
- Status preserved on update: existing tasks keep their status when synced with new data
- Credentials stored plaintext in SQLite (MVP, Phase 7+ for encryption)

**Phase 02-05 Decisions:**
- Sonner toast library chosen for lightweight notifications (smaller bundle than react-toastify)
- Modal-based import configuration (familiar pattern, keeps main UI clean)
- Provider radio selection for GitHub vs Jira (simple, unambiguous choice)
- Test Connection validates credentials before saving (immediate auth error feedback)
- Disabled drag for imported tasks to prevent sync conflicts (read-only in UI layer)
- Toast notifications for sync feedback (non-blocking, shows imported count)

**Phase 03-01 Decisions:**
- Node.js sidecar with simple-git 3.20+ for promise-based git operations
- ES2020 modules (type: "module" in package.json)
- Deletion safety: worktree remove → branch delete → prune (strict order prevents corruption)
- TypeScript compilation to dist/index.js (committed to repo for Phase 4 integration)
- All functions async/await based with descriptive error messages

**Phase 03-02 Decisions:**
- WorktreeStatus enum: Available, Leased, InUse, Dirty (4 states for full lifecycle)
- Pool max size: 5 worktrees (balances parallelism with resource usage)
- Database transactions in lease_worktree prevent race conditions
- Sidecar invocation stubbed in lease_worktree (Phase 4 will add tokio::process::Command)
- TypeScript bindings manually created (ts-rs regeneration issues encountered)

**Phase 03-03 Decisions:**
- Dirty-state recovery pattern: mark Dirty before cleanup (survives crashes)
- Both cleanup handlers are async (prep for tokio::process::Command in Phase 4)
- Sidecar invocation stubbed (same as Phase 3-02)
- Integration point: App.tsx calls recover_dirty_worktrees on project open
- Failed cleanups stay Dirty, don't block new executions

**Phase 03-04 Decisions:**
- Default pool size: 3 worktrees (instant allocation for first 3 tasks)
- Lazy git creation: database entries only on init, actual git on lease
- Idempotent: safe to call multiple times (checks existing count)
- Configurable pool size via optional parameter (testing flexibility)

**Phase 04-01 Decisions:**
- Use tokio::process::Command (async) instead of std::process::Command (blocking) to prevent IPC handler freezes
- Set kill_on_drop(true) to ensure proper process cleanup even if Rust handle is dropped unexpectedly
- Capture both stdout and stderr separately for diagnostic output and error tracking
- Return structured ProcessOutput containing success boolean for clear error distinction
- Keep spawner simple in Phase 4-01 - streaming and database persistence deferred to Phase 4-02+
- Fixed import to use AsyncReadExt instead of AsyncBufReadExt for stream reading

**Phase 05-01 Decisions:**
- Use portable-pty for cross-platform PTY management (handles Windows ConPTY and Unix PTY)
- Wrap PTY master in Arc<Mutex> (tokio::sync variant) for async-safe thread sharing
- Use Tauri channels for streaming instead of standalone WebSocket server (better integration)
- Bounded mpsc channel (100 messages) provides backpressure for fast PTY output
- Use UTF-8 lossy decoding to handle mid-sequence UTF-8 bytes safely
- Integrate spawn_agent_cli_pty into spawn_agent_execution (critical Phase 5 foundation)
- Store PtySession in AppState HashMap for frontend attachment and lifecycle management

**Phase 05-02 Decisions:**
- useRef instead of useState for Terminal instance (xterm.js is DOM-manipulating library requiring direct reference control)
- Channel created fresh on component mount (prevents stale channel reuse across remounts)
- Terminal only renders when tab is active (prevents multiple instances and resource leaks)
- Error handling on all IPC invocations (console.error and terminal.write feedback)
- @xterm/xterm 5.3.0 with FitAddon 0.11.0 and addon-attach 0.10.0 for streaming integration

**Phase 05-03 Decisions:**
- Schema versioning via PRAGMA user_version with migration logic (no external migration tool)
- CircularBuffer 10,000 line capacity (typical log size, tunable)
- Terminal output stored in execution_logs.terminal_output as nullable TEXT
- Search UI uses simple case-insensitive substring matching (sufficient for Phase 3, regex later if needed)
- append_terminal_output designed for periodic batching (avoid excessive DB writes)
- ExecutionHistory displays terminal_output from DB with timestamps and elapsed time calculation

**Phase 06-01 Decisions:**
- @git-diff-view/react library for production diff rendering (verified 134 code snippets, 87.4 benchmark score)
- Unified diff view (GitHub-style) with 6 context lines (--unified=6) locked per user decision
- Recursive file tree building from flat file list with directories first, alphabetic sorting
- Language detection by file extension for Shiki syntax highlighting
- Zustand store with Immer middleware for review state (consistent with boardStore pattern)
- Frontend IPC → Rust async handler → Node.js sidecar CLI pattern for diff generation
- ReviewModal uses @radix-ui/react-dialog for accessible modal container
- Error recovery via retry button for failed diff fetches

### Pending Todos

None yet.

### Blockers/Concerns

**02-01 Resolution:**
- React 19 compatibility issue with planned library (react-beautiful-dnd) resolved via @dnd-kit migration
- No outstanding blockers identified

**Watch for Phase 02-02+:**
- Form validation and error handling patterns should match error toast styling in board
- Modal styling should respect CSS theme variables established in Phase 1

## Session Continuity

Last session: 2026-02-07 (current)
Stopped at: Plan 06-01 complete (Diff Viewer Infrastructure)
Resume file: None
Next: Plan 06-02 (Approval Workflow)
