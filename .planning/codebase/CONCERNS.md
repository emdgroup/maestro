# Codebase Concerns

**Analysis Date:** 2026-02-14

## Tech Debt

**Incomplete IPC Cancel/Abort Flow:**
- Issue: `abortExecution` in `src/store/boardStore.ts` line 144 uses `taskId` where `cancel_execution` handler expects `logId`. Task IDs and execution log IDs are different entity types.
- Files: `src/store/boardStore.ts` (line 144), `src-tauri/src/ipc/handlers.rs` (missing cancel_execution implementation)
- Impact: Task cancellation may silently fail or cancel wrong execution logs. Workaround uses manual task status update to "Done".
- Fix approach: Fetch current execution log ID for task before calling `cancel_execution`, or implement proper abort handler in Rust that accepts taskId and queries the log.

**Debug Logging in Production:**
- Issue: `[DEBUG]` console.log statements throughout `src/App.tsx` (27+ instances) and Tauri IPC wrapper remain in production code
- Files: `src/App.tsx` (lines 27, 39, 41, 44, 53, 55, 58, 63, 70, 73, 77, 80, 83, 86, 108, 111, 115, 134, 136, 143, 145, 207), `src/lib/tauri-safe.ts`
- Impact: Console spam in production, information leakage about app initialization flow
- Fix approach: Move all debug logging behind `console.debug()` or a feature flag. Strip from production builds via Vite plugin.

**Incomplete Settings UI Handlers:**
- Issue: Settings page action bar buttons ("Reset to Defaults", "Save Settings") are TODO stubs in `src/App.tsx` lines 185 and 195
- Files: `src/App.tsx` (lines 185, 195), `src/components/SettingsPage.tsx`
- Impact: Users cannot save settings changes or reset to defaults from the UI. Settings page appears functional but actions are no-ops.
- Fix approach: Implement reset logic (restore default values, clear database), implement save logic (validate inputs, persist to database).

**Phase 4 Sidecar Integration Stubs:**
- Issue: Multiple TODO placeholders for sidecar worktree operations that will eventually spawn external processes
- Files: `src-tauri/src/ipc/handlers.rs` (lines 953-955, 1024-1025), `src-tauri/src/git/mod.rs` (lines 109, 118, 128, 136, 144)
- Impact: Worktree cleanup operations (`delete_worktree`, `recover_dirty_worktrees`) currently simulate success without actually invoking cleanup. Orphaned worktrees may accumulate on disk.
- Fix approach: Phase 4 implementation will invoke actual sidecar with `tokio::process::Command`. Until then, worktree recovery is database-only.

**Incomplete Process Pause Implementation:**
- Issue: `pause_agent_execution` handler in `src-tauri/src/ipc/handlers.rs` line 2876 only updates database status, does NOT send SIGSTOP to running process
- Files: `src-tauri/src/ipc/handlers.rs` (lines 2876-2877)
- Impact: Tasks marked as "paused" in UI but continue executing in background. Pause is cosmetic only.
- Fix approach: Requires process handle tracking system to send signals. Depends on PTY session management in `src-tauri/src/process/pty.rs`.

**Remote Execution Not Integrated:**
- Issue: `spawn_agent_execution` dispatcher in `src-tauri/src/process/mod.rs` returns placeholder ProcessOutput for local execution path (line 37-45)
- Files: `src-tauri/src/process/mod.rs` (lines 26-72), `src-tauri/src/process/remote.rs`
- Impact: Local task execution doesn't actually stream output to UI. Remote execution implementation exists but local path is stub.
- Fix approach: Integrate local PTY spawning (already exists in `spawn_agent_cli_pty`) into dispatcher return value.

**No Remote Execution for Local Resume:**
- Issue: `resume_agent_execution` handler in `src-tauri/src/ipc/handlers.rs` line 2998 TODO mentions remote spawn not yet implemented
- Files: `src-tauri/src/ipc/handlers.rs` (line 2998)
- Impact: Resuming tasks on remote projects may fail silently. Resume path only tested locally.
- Fix approach: Mirror local spawn pattern to remote via SSH, using existing `spawn_remote_agent_execution` from `src-tauri/src/process/remote.rs`.

## Known Bugs

**macOS Accent Color Detection Missing:**
- Symptoms: System accent color not loaded on macOS. Falls back to default blue accent.
- Files: `src-tauri/src/ipc/handlers.rs` (line 3161), `src/providers/ThemeProvider.tsx`
- Trigger: Run app on macOS, check CSS variable `--accent-color`
- Workaround: Manually specify accent color in system settings (if UI existed)

**Cancel Execution Parameter Mismatch:**
- Symptoms: Task abort button may cancel wrong execution or fail silently
- Files: `src/store/boardStore.ts` (line 146)
- Trigger: Click abort/cancel on running task
- Workaround: Task status updates to "Done" even if abort fails

**Settings Validation Not Enforced:**
- Symptoms: Invalid settings (empty project paths, malformed JSON arrays) can be saved to database
- Files: `src-tauri/src/db/settings.rs`, `src/components/SettingsPage.tsx`
- Trigger: Manually save invalid settings data
- Workaround: No validation currently exists, relies on UI constraints

## Security Considerations

**SSH Host Key Validation:**
- Risk: SSH sessions store host fingerprints but don't validate key changes. MITM attacks possible if host key compromised.
- Files: `src-tauri/src/db/connection.rs` (lines 105-137), `src-tauri/src/ssh/session.rs`
- Current mitigation: Host keys stored in known_hosts table, fingerprint checked on connection
- Recommendations:
  - Add fingerprint change detection and alert user
  - Implement key pinning for critical hosts
  - Add option to revoke compromised keys from UI

**Execution Log Output Stored Unencrypted:**
- Risk: Execution logs may contain sensitive data (API keys, credentials) stored in plain SQLite database
- Files: `src-tauri/src/db/execution_logs.rs`, database schema
- Current mitigation: None (database at-rest is unencrypted)
- Recommendations:
  - Add field-level encryption for sensitive outputs
  - Implement log data retention policy (auto-delete after N days)
  - Add user-facing option to exclude sensitive patterns

**IPC Command Input Validation:**
- Risk: Some IPC handlers don't validate input parameters before database operations
- Files: `src-tauri/src/ipc/handlers.rs` (numerous execute/insert operations)
- Current mitigation: Database foreign key constraints provide some protection
- Recommendations:
  - Add input validation layer (path sanitization, string length limits)
  - Use parameterized queries consistently (already done, but add validation layer)
  - Document parameter constraints in handler comments

**Process Command Injection:**
- Risk: Agent CLI is spawned with task-provided arguments without escaping
- Files: `src-tauri/src/process/spawner.rs`, `src-tauri/src/process/pty.rs`, `src-tauri/src/ipc/handlers.rs`
- Current mitigation: Process spawning uses `Command::arg()` which automatically escapes
- Recommendations:
  - Audit task argument construction to ensure no shell interpretation
  - Add tests for argument injection patterns

## Performance Bottlenecks

**Unindexed Database Queries:**
- Problem: `get_tasks` and related queries lack indexes on frequently filtered columns (project_id, status, worktree_id)
- Files: `src-tauri/src/db/schema.rs`, `src-tauri/src/ipc/handlers.rs`
- Cause: Schema initialized without performance indexes. Linear scan on large task/execution log tables.
- Improvement path:
  - Add indexes: `CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);`
  - Add indexes: `CREATE INDEX idx_execution_logs_task ON execution_logs(task_id);`
  - Benchmark query times before/after

**Polling for Execution Status:**
- Problem: `ExecutionHistory.tsx` line 50 polls every 5 seconds, frontend loads all execution logs on each poll
- Files: `src/components/ExecutionHistory.tsx` (line 50), `src-tauri/src/ipc/handlers.rs` (get_execution_logs)
- Cause: No streaming/event system; frontend must repeatedly fetch full history
- Improvement path:
  - Implement Tauri event system to push updates on execution state changes
  - Replace polling with event listeners
  - Or add offset-based pagination to reduce payload

**No Pagination on Large Result Sets:**
- Problem: `get_projects`, `get_tasks`, `get_execution_logs` return entire result sets
- Files: `src-tauri/src/ipc/handlers.rs` (handlers.rs lines 46, 196, 336)
- Cause: Desktop app assumes small datasets, but execution history can accumulate to thousands
- Improvement path:
  - Add limit/offset parameters to query handlers
  - Implement cursor-based pagination in UI components
  - Add lazy-loading for long lists

**Heavy TaskCard Re-renders:**
- Problem: `src/components/TaskCard.tsx` (395 lines) re-renders entire card on any prop change
- Files: `src/components/TaskCard.tsx`, `src/components/KanbanBoard.tsx`
- Cause: No memoization, complex state updates in card
- Improvement path:
  - Wrap TaskCard with `React.memo()` for prop comparison
  - Split large component into smaller memoized sub-components
  - Use `useCallback` for event handlers

## Fragile Areas

**Complex State Management in BoardStore:**
- Files: `src/store/boardStore.ts`, `src/components/KanbanBoard.tsx`
- Why fragile:
  - Multiple async operations (executeTask, pauseExecution, resumeExecution, abortExecution) each manage their own loading state with Set<number>
  - State updates in finally blocks can race with new operations
  - No optimistic updates; UI waits for backend confirmation
  - Task status updates don't persist; only backend database is source of truth
- Safe modification:
  - Add integration tests for each operation sequence (execute→pause→resume, execute→abort)
  - Use transaction-like patterns where possible (update DB before updating store)
  - Consider debouncing rapid state changes
- Test coverage: Gaps exist for concurrent operation handling

**ProjectPicker Remote Connection Form:**
- Files: `src/components/ProjectPicker.tsx` (381 lines), `src/components/RemoteConnectionForm.tsx` (305 lines)
- Why fragile:
  - SSH config validation spread across multiple functions
  - Error handling doesn't distinguish between connection vs auth vs path errors
  - Depends on external SSH command-line tools that may not be available
  - No retry logic for transient network issues
- Safe modification:
  - Add explicit error type discrimination before modifying config
  - Test on systems without SSH installed
  - Add pre-flight checks for SSH binary availability
- Test coverage: SSH connection errors not well-tested; need mocking

**Database Migration Chain:**
- Files: `src-tauri/src/db/schema.rs` (lines 104-243)
- Why fragile:
  - 8 sequential migrations (SCHEMA_VERSION = 8) that must be applied in order
  - No rollback capability
  - Migration logic for old versions may have bugs that don't surface if skipped
  - Adding new migration requires updating all previous conditionals
- Safe modification:
  - Write tests for each migration path (0→1, 1→2, ..., 7→8)
  - Add migration naming convention and separate files
  - Document each migration's purpose and any manual cleanup steps
- Test coverage: Migrations only tested in unit tests with in-memory DB, not on real persisted data

**Execution Terminal Output Streaming:**
- Files: `src/components/ExecutionTerminal.tsx` (282 lines), `src-tauri/src/process/pty.rs` (151 lines)
- Why fragile:
  - PTY handling is platform-specific (Linux/macOS vs Windows)
  - Large output streams may buffer in memory before display
  - No backpressure handling if output exceeds UI capacity
- Safe modification:
  - Test with very large outputs (>100MB)
  - Monitor memory usage during long-running processes
  - Add circular buffer or incremental UI updates
- Test coverage: E2E tests exist but don't cover large output scenarios

## Scaling Limits

**SQLite Concurrency:**
- Current capacity: Single writer (Mutex<Connection> in AppState)
- Limit: ~100 concurrent requests (writes queue up). Read-heavy workloads acceptable but task spawn storms will bottleneck.
- Scaling path:
  - Phase future: Migrate to PostgreSQL or use WAL mode (write-ahead logging) for SQLite
  - Add connection pooling (r2d2) for better throughput
  - Current app design assumes single user; multi-user requires architectural change

**Execution Logs Table Growth:**
- Current capacity: SQLite can handle millions of rows efficiently, but unindexed queries will slow
- Limit: Without indexes, query time degrades O(n) with table size. ~10k execution logs becomes noticeable.
- Scaling path:
  - Add indexes (see "Unindexed Database Queries" above)
  - Implement archival (move old logs to separate table, compress)
  - Add execution log retention policy (auto-delete logs >30 days old)

**PTY Session Memory:**
- Current capacity: Each active PTY session holds output buffer in memory (`src-tauri/src/process/pty.rs`)
- Limit: ~100 concurrent PTY sessions before memory pressure. Large outputs accumulate.
- Scaling path:
  - Stream output directly to disk (circular log file) instead of buffering
  - Add configurable max output size per task
  - Implement lazy loading of historical output

**Worktree Pool Size:**
- Current capacity: Default pool size 10 (configurable `src-tauri/src/ipc/handlers.rs` line 1104)
- Limit: Pool exhaustion blocks new task execution. Poor UX.
- Scaling path:
  - Make pool size dynamic based on available disk space
  - Add queue UI showing waiting tasks
  - Implement priority-based queue (high priority tasks bypass queue)

## Dependencies at Risk

**Tauri 2.x Platform Support:**
- Risk: Tauri 2 is early stable. Breaking changes may occur in minor versions.
- Impact: Core desktop app infrastructure depends on Tauri stability.
- Migration plan: Pin to specific minor version; monitor Tauri releases. Migration to Tauri 3 when stable.

**ts-rs Type Generation:**
- Risk: ts-rs derives from Rust types. Changes to derive syntax or custom implementations may break code generation.
- Impact: TypeScript type bindings (`src/types/bindings.ts`) may be out of sync with Rust.
- Migration plan: Add pre-build validation that bindings.ts was recently generated. Test with real IPC calls.

**shadcn/ui Copy-Paste Maintenance:**
- Risk: Components copied from shadcn/ui. Upstream updates won't apply automatically.
- Impact: Potential security vulnerabilities or accessibility fixes in shadcn components won't auto-update.
- Migration plan: Set up quarterly review of shadcn/ui upstream changes. Manual cherry-pick critical fixes.

**SSH Library (ssh2-rs) Vulnerabilities:**
- Risk: SSH implementation has security history. Vulnerabilities in ssh2-rs could expose SSH sessions.
- Impact: Remote project execution could be compromised.
- Migration plan: Monitor ssh2-rs security advisories via `cargo audit`. Update promptly on vulnerabilities.

## Missing Critical Features

**No Persistent Task Execution State:**
- Problem: If app crashes during task execution, task state is lost. Execution logs exist but task status reverts.
- Blocks: Recovery from crashes, long-running operations spanning app restarts
- Recommendation: Implement "resumable tasks" by storing execution state (model, args, last log ID) in persistent store

**No Conflict Resolution for Git Worktrees:**
- Problem: If sidecar crashes during merge, worktree left in undefined state. Manual intervention required.
- Blocks: Automated multi-agent orchestration reliability
- Recommendation: Implement transaction-like pattern with rollback. Store pre-merge worktree snapshot.

**No Rate Limiting on IPC Commands:**
- Problem: Client can spam IPC calls (thousands per second) causing DoS of backend
- Blocks: Multi-user scenarios (though app is currently single-user)
- Recommendation: Add per-command rate limits in Tauri middleware

**No User-Facing Error Recovery UI:**
- Problem: Most errors are logged to console but not shown to user (except alerts)
- Blocks: User understanding of what went wrong and how to fix
- Recommendation: Implement error toast system with recovery actions (retry, file logs, contact support)

## Test Coverage Gaps

**SSH Connection Scenarios:**
- What's not tested: SSH key rotation, host key changes, connection timeouts, partial SSH config errors
- Files: `src-tauri/src/ssh/session.rs`, `src-tauri/src/ipc/ssh_handlers.rs`, tests
- Risk: SSH features may fail in production on edge case scenarios
- Priority: High (affects remote project users)

**Execution Log Streaming Large Output:**
- What's not tested: >10MB execution output, streaming timeout, PTY buffer overflow
- Files: `src/components/ExecutionTerminal.tsx`, `src-tauri/src/process/pty.rs`
- Risk: Terminal UI hangs or crashes with large outputs
- Priority: High (affects user experience)

**Database Migration from Old Versions:**
- What's not tested: Actual migration path from schema v1 → v8 on real databases (only tested in-memory)
- Files: `src-tauri/src/db/schema.rs`
- Risk: User app fails to start if database migration fails silently
- Priority: Medium (affects app upgrades)

**Concurrent Task Abort/Resume:**
- What's not tested: Race conditions when user rapidly clicks abort then resume
- Files: `src/store/boardStore.ts`, `src-tauri/src/ipc/handlers.rs`
- Risk: State corruption, conflicting operations, orphaned processes
- Priority: Medium (UI allows rapid clicks)

**Remote Worktree Operations:**
- What's not tested: E2E test of delete_worktree on remote via SSH
- Files: `src-tauri/src/ipc/handlers.rs` (lines 901-972)
- Risk: Worktree cleanup stubs don't actually work; orphaned remote worktrees accumulate
- Priority: High (Phase 4 blocker)

---

*Concerns audit: 2026-02-14*
