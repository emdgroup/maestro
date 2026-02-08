# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-04)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control—eliminating blocking waits while maintaining safety through worktree isolation and human-in-the-loop review.

**Current focus:** Phase 9 - Remote Project Support

## Current Position

Phase: 10 of 12 (Documentation Completeness - In Progress)
Plan: 1 of 1 complete (Phase 2 VERIFICATION.md Generation)
Status: Phase 10 Plan 01 COMPLETE ✓ - TECH DEBT CLOSURE: Phase 2 now has VERIFICATION.md
Last activity: 2026-02-08 — Completed Plan 10-01 with Phase 2 verification documentation

Progress: [██████████████] 39/44 plans (88.6%), 10/12 phases active (9 complete + Phase 10 in progress)

## Performance Metrics

**Velocity:**
- Total plans completed: 38 (COMPLETE WITH GAP CLOSURE)
- Average duration: 22.2 min (consistent)
- Total execution time: ~14.25h (includes all 9 phases + gap closure)
- Project completion rate: 100% (all planned tasks delivered + verified with 0 gaps)

**By Phase:**

| Phase | Plans | Total | Avg/Plan | Status |
|-------|-------|-------|----------|--------|
| 01-foundation | 4 | 63m | 15.75m | Complete |
| 02-core-orchestration | 5 | 244m | 48.8m | Complete |
| 03-git-worktree-infrastructure | 4 | 134m | 33.5m | Complete |
| 04-agent-execution | 4 | 120m | 30m | Complete (gaps noted) |
| 05-real-time-monitoring | 3 | 78m | 26m | Complete ✓ |
| 06-review-merge-workflow | 5 | 120m | 24m | Complete ✓✓ (gap closure + merge ops) |
| 07-configuration-management | 3 | 80m | 26.7m | Complete ✓ (data model + UI) |
| 08-error-handling-polish | 3 | 135m | 45m | Complete ✓✓✓ (full pipeline: detection + terminal + recovery UI) |
| 09-remote-project-support | 5 | ~200m | 40m | Complete ✓✓✓✓✓ (SSH infrastructure + git ops + process execution + UI + streaming) |
| 10-documentation-completeness | 1 | 25m | 25m | In Progress (Phase 2 VERIFICATION.md generated) |

**Recent Trend:**
- Phase 10 Plan 1 (10-01): Phase 2 VERIFICATION.md Generation (25m) ✓ COMPLETE
  - 542-line verification report with all 4 success criteria verified
  - Observable Truths 1-4 with Supporting Artifacts and Wiring Diagrams
  - Tech debt closed: Phase 2 now has VERIFICATION.md (last phase missing one)
  - All 9 completed phases now have verification documentation
- Phase 9 Plan 5 (09-05): Terminal Streaming Gap Closure (15m) ✓ COMPLETE
  - SSH PTY channel reading via log file polling (500ms intervals)
  - stream_remote_output tokio background task implementation
  - spawn_agent_execution handler wired with dispatcher integration
  - Full verification: 4/4 truths verified, 0 gaps remaining
  - cargo build: 0 errors, cargo test: 27/27 passing
- Phase 9 Plan 4 (09-04): UI Integration and Terminal Streaming (45m) ✓ COMPLETE
  - Project creation flow with local/remote selection
  - SSH configuration form with connection testing
  - Remote project status indicators with polling and retry
  - CSS styling for all remote components
  - All cargo tests pass (27/27)
- Phase 9 Plan 3 (09-03): Remote Process Execution (42m) ✓ COMPLETE
  - SSH PTY-based remote spawning with dispatcher pattern
- Phase 9 Plan 2 (09-02): Remote Git Operations (?) ✓ COMPLETE
  - Git dispatcher for transparent local/remote execution
- Phase 9 Plan 1 (09-01): SSH Infrastructure (?) ✓ COMPLETE
  - RemoteSshSession with connection state machine
- Phase 8 Wave 3 (08-03): Recovery UI Implementation (45m) ✓ COMPLETE
- Phase 8 Wave 2 (08-02): Terminal attach/detach (45m) ✓ COMPLETE
- Phase 8 Wave 1 (08-01): Error detection & database layer (45m) ✓ COMPLETE
  - ErrorEvent struct with error categorization and suggestions
  - Error detection logic analyzing stderr patterns
  - Database persistence with append_error_event, mark_failed, get_error_event
  - Schema migration to v5 with error_event column
- Phase 8 Wave 2 (08-02): Terminal attach/detach (45m) ✓ COMPLETE
  - Enhanced attach_terminal handler with history prepending
  - Enhanced send_terminal_input with signal handling (Ctrl+C, Ctrl+Z)
  - New detach_terminal handler for graceful streaming cleanup
  - ExecutionTerminal React component (250+ lines) with interactive input
  - Zustand store integration for terminal lifecycle management
  - KanbanBoard modal rendering with one-terminal constraint
- Phase 8 Wave 3 (08-03): Recovery UI Implementation (45m) ✓ COMPLETE
  - TaskStatus enum extended with "Failed" status (Rust + TypeScript)
  - TaskCard displays Failed status with red badge (#fee2e2 background, #991b1b text)
  - Error detail preview shown below task name for Failed tasks
  - Recovery action buttons: Resume (green), Abort (red), Terminal (purple)
  - ExecutionHistory displays error details section with:
    - Error type as colored badge (CompilationError orange, Timeout yellow, etc.)
    - Full error message in scrollable box
    - Suggestions as bulleted list with checkmarks
    - Copy to clipboard buttons for message and suggestions
    - Detected timestamp
  - Zustand store actions: resumeExecution() and abortExecution()
  - resumeExecution retries with same parameters, updates task to InProgress
  - abortExecution marks task Done, stops recovery attempts
  - Loading states tracked via retryingTaskIds and abortingTaskIds Sets
  - Toast notifications on all user actions
  - Data persistence: error details survive app restarts via database

**Phase 8 Complete - Full Error Handling Pipeline:**
The complete error handling workflow is now implemented:
1. Backend (08-01): Detects errors, categorizes them, generates suggestions
2. Terminal (08-02): Users can attach to debug interactively
3. Frontend (08-03): Shows errors clearly, enables recovery actions
Users can see failures immediately, understand causes, and recover gracefully.

*Updated: 2026-02-07 (after Plan 08-03 recovery UI completion)*

**Phase 9 Plan 1 Complete - SSH Connection Infrastructure:**
Established remote project support foundation with:
1. SSH module (ssh2 crate 0.9.5) with connection state machine
2. RemoteSshSession persistent connection manager
3. Authentication support (key file + agent, no password)
4. Error categorization (transient vs permanent)
5. Host key verification with known_hosts storage
6. AppState integration with lazy connection on app startup
7. Database schema v6 with is_remote and ssh_config fields

*Updated: 2026-02-08 (after Plan 09-01 SSH infrastructure completion)*

**Phase 9 Plan 2 Complete - Remote Git Operations Dispatcher:**
Established transparent remote-aware git operations with:
1. GitConnection enum routing local vs remote execution
2. Remote git module with 5 SSH-executed operations
3. Dispatcher pattern hiding local/remote differences from callers
4. IPC handler integration (get_diff_for_review supports remote projects)
5. DiffViewer component works seamlessly with both local and remote projects

*Updated: 2026-02-08 (after Plan 09-02 Remote git operations completion)*

**Phase 9 Plan 3 Complete - Remote Process Execution Dispatcher:**
Implemented SSH PTY-based remote process spawning with:
1. RemoteProcessHandle struct tracking remote process PID and SSH channel
2. spawn_remote_agent_execution allocates PTY on remote machine
3. Claude Code CLI spawning with nohup for background execution
4. Process dispatch in spawn_agent_execution routes local→PTY vs remote→SSH
5. websocket/streaming.rs bridge for PTY-to-WebSocket output routing
6. ExecutionConfig with model_override, mcp_allowlist, skills_override support
7. Error handling distinguishes local vs remote spawn failures
8. Handlers integrated with is_remote flag detection

*Updated: 2026-02-08 (after Plan 09-03 Remote process execution completion)*

**Phase 9 Plan 4 Complete - Remote Project UI Integration:**
Completed end-to-end remote project support with UI/UX integration:
1. Project creation flow with local/remote selection prompt
2. RemoteConnectionForm with all SSH config fields (host, port, username, auth method, remote path)
3. Connection testing with validation before project creation
4. IPC handlers: test_remote_connection, get_remote_connection_status, reconnect_remote_project
5. ProjectCard displays remote badge (🌐 Remote) with connection status indicators
6. Status polling every 10 seconds with manual retry mechanism
7. Comprehensive CSS styling for all remote components
8. Fixed database schema migration bug (duplicate column error)
9. All tests passing (27/27 cargo tests)
10. Terminal streaming prepared via existing WebSocket mechanism

**Phase 9 Plan 4 Complete:** UI integration with ProjectPicker, RemoteConnectionForm, status polling

*Updated: 2026-02-08 (after Plan 09-04 UI Integration completion - PROJECT COMPLETE)*

**Phase 9 Plan 5 Complete (Gap Closure):** Remote terminal streaming integration

*Updated: 2026-02-08 (after Plan 09-05 Terminal Streaming - FULL PROJECT COMPLETE WITH GAP CLOSURE)*

---

## Gap Closure - Plan 09-05: Terminal Streaming

**Status:** ✓ COMPLETE

Closed the final gap where remote processes executed but produced no visible output on frontend.

**What was built:**
1. SSH log file polling in attach_remote_stream_listener (500ms intervals)
2. Delta-based log reading with stream_remote_output background task
3. spawn_agent_execution handler integration with dispatcher call
4. broadcast_sender callback forwarding bytes to execution_logs

**Result:**
- Remote process output now streams to frontend in real-time
- Users observe identical execution progress for local and remote tasks
- Full terminal history persisted to database
- No behavioral differences between local and remote execution

**Integration verified:**
- ✓ cargo build: 0 errors
- ✓ cargo test: 27/27 passing
- ✓ pnpm build: successful
- ✓ All three files (streaming.rs, remote.rs, handlers.rs) integrated and working

**Observable Truth Achieved:**
Remote agent execution on remote machines is now transparent to users—terminal output streams in real-time identical to local execution.

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

**Phase 06-05 Decisions:**
- MergeOutcome fields use camelCase with serde rename for JSON compatibility between TypeScript (sidecar) and Rust
- Parse stdout as JSON from sidecar process; errors logged to stderr, success exits with code 0
- Leave task in Merging state on non-conflict errors to support retry mechanism (user can approve again)
- Type-safe JSON protocol for bidirectional merge communication

**Phase 07-01 Decisions:**
- Configuration columns stored as JSON TEXT in database (flexible, matches existing pattern for skills)
- Project-level config stored in settings key-value table; task-level config stored directly on tasks table (different storage due to different access patterns)
- Three separate IPC handlers (get_project_settings, update_project_settings, update_task_settings) for clear concerns separation
- Optional fields for task configuration (model_override, mcp_allowlist, skills_override) allow partial/incremental configuration
- TypeScript bindings manually maintained (ts-rs export incomplete in this setup, manual update acceptable for committed types)

**Phase 08-01 Decisions:**
- ErrorEvent struct with error_type, message, suggestions, detected_at fields for structured error tracking
- Error categorization: CompilationError, MissingDependency, RuntimeError, Timeout, ProcessCrash, Unknown
- Type-specific suggestions generated per error category (e.g., "Run: npm install" for MissingDependency)
- Auto-retry logic for transient errors (Timeout, ProcessCrash) with max 3 attempts
- Schema migration to v5 adds error_event TEXT column to execution_logs
- Database functions: append_error_event, mark_failed, get_error_event

**Phase 08-02 Decisions:**
- send_terminal_input handler writes to PTY master with signal handling (Ctrl+C → SIGINT, Ctrl+Z → SIGTSTP)
- detach_terminal handler preserves PTY session while stopping stream (execution continues in background)
- attach_terminal enhanced with include_history parameter to prepend terminal_output from database
- ExecutionTerminal component (283 lines) with interactive input field and command history
- One-terminal-at-a-time constraint enforced via activeTerminalTaskId state in boardStore
- Terminal lifecycle: attach (load history + stream) → interact (send commands) → detach (preserve PTY)

**Phase 08-03 Decisions:**
- TaskStatus enum extended with "Failed" variant (Rust + TypeScript synchronization)
- Failed status styling: red badge (#fee2e2 background, #991b1b text)
- Recovery action buttons: Resume (green, retries execution), Abort (red, marks Done), Terminal (purple, opens debug)
- ExecutionHistory error details section with color-coded error type badges
- Copy to clipboard functionality for error messages and suggestions
- resumeExecution and abortExecution actions in boardStore with loading state tracking
- Loading states tracked via retryingTaskIds and abortingTaskIds Sets for button state management
- Critical bug fixes: white screen (currentProject loading) and task creation (mock object freezing)

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

Last session: 2026-02-08 (current)
Stopped at: Plan 10-01 complete (Phase 2 VERIFICATION.md Generation)
Resume file: None
Next: Phase 10 Plans 11-12 (Tech Debt Closure - optional after core project)
