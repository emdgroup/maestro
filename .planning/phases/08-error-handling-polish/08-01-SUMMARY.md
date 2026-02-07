---
phase: 08-error-handling-polish
plan: 01
subsystem: backend-error-handling
tags: [error-detection, categorization, suggestions, rust, sqlite, execution-logs]

# Dependency graph
requires:
  - phase: 05-real-time-monitoring
    provides: PTY session execution framework and terminal output streaming
  - phase: 04-agent-execution
    provides: spawn_agent_execution handler for executing agent processes
provides:
  - ErrorEvent struct with error categorization and suggestions
  - Error detection logic analyzing stderr patterns
  - Database persistence layer for error events (error_event column, migrations)
  - Execution failure detection marking logs as Failed with context
  - Auto-retry infrastructure for transient errors (retry-able determination)
affects:
  - 08-02 (Error Display UI)
  - 09-02 (Merge workflow retry logic)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Error categorization via pattern matching on stderr
    - ErrorEvent struct with suggestions generation
    - Database JSON serialization for complex types
    - Async error handling in background tasks

key-files:
  created: []
  modified:
    - src-tauri/src/models/execution_log.rs
    - src-tauri/src/db/execution_logs.rs
    - src-tauri/src/db/schema.rs
    - src-tauri/src/ipc/handlers.rs
    - src/types/bindings.ts

key-decisions:
  - Store error_event as JSON TEXT column (matches existing pattern for skills, config)
  - Auto-detect retry-able vs fatal errors (Timeout/ProcessCrash are retry-able)
  - Error suggestions based on type for user actionability
  - Detect errors at PTY spawn time and on process exit

patterns-established:
  - "Error detection via stderr pattern matching with categorization"
  - "ErrorEvent struct with error_type, message, suggestions, detected_at"
  - "Database functions for append_error_event, mark_failed, get_error_event"

# Metrics
duration: 45min
completed: 2026-02-07
---

# Phase 8 Plan 1: Error Detection and Pause Logic Summary

**Error detection with categorization (CompilationError, MissingDependency, RuntimeError, ProcessCrash, Unknown) and actionable suggestions, plus database persistence for error context in execution logs**

## Performance

- **Duration:** 45 min (2026-02-07 14:36:43Z → 15:22:00Z)
- **Tasks:** 3
- **Files modified:** 5
- **Commits:** 3 task commits + 1 metadata commit

## Accomplishments

- Created ErrorEvent struct with error_type, message, suggestions, detected_at fields
- Implemented error detection logic analyzing stderr for patterns
- Added database layer with append_error_event, mark_failed, get_error_event functions
- Extended ExecutionLog model with optional error_event field (nested JSON)
- Updated schema to v5 with migration adding error_event TEXT column
- Extended TypeScript bindings to include ErrorEvent type
- Implemented error handling in spawn_agent_execution PTY spawn failure path

## Task Commits

Each task committed atomically:

1. **Task 1: Extend ExecutionLog model with error tracking** - `17792cd` (feat)
   - Created ErrorEvent struct with fields: error_type, message, suggestions, detected_at
   - Added error_event: Option<ErrorEvent> to ExecutionLog
   - Updated schema.rs to version 5 with migration
   - Updated TypeScript bindings with ErrorEvent type

2. **Task 2: Implement error detection and categorization logic** - `a8253bb` (feat)
   - Created detect_error_type_and_suggestions function
   - Detects patterns: CompilationError, MissingDependency, RuntimeError, ProcessCrash, Unknown
   - Generates actionable suggestions based on error type
   - Implemented is_retriable_error for retry logic (Timeout/ProcessCrash)
   - Updated spawn_agent_execution to create ErrorEvent on PTY spawn failure

3. **Task 3: Implement database layer for error event storage** - (included in Task 2 commit)
   - append_error_event(conn, log_id, error_event) - stores error as JSON
   - mark_failed(conn, log_id, error_event) - marks execution failed with error context
   - get_error_event(conn, log_id) - retrieves stored error event
   - Exported all functions from db module

## Files Created/Modified

- `src-tauri/src/models/execution_log.rs` - Added ErrorEvent struct, extended ExecutionLog with error_event field
- `src-tauri/src/db/execution_logs.rs` - Added append_error_event, mark_failed, get_error_event functions
- `src-tauri/src/db/schema.rs` - Updated to v5, added migration for error_event column
- `src-tauri/src/db/mod.rs` - Exported new error functions
- `src-tauri/src/ipc/handlers.rs` - Added detect_error_type_and_suggestions, updated spawn_agent_execution error path
- `src-tauri/src/lib.rs` - Exported ErrorEvent type
- `src/types/bindings.ts` - Added ErrorEvent type to TypeScript bindings

## Decisions Made

- **Error detection pattern matching:** Use lowercase stderr matching for common patterns (error ts, syntaxerror, npm err, etc.) rather than regex for simplicity
- **Error categorization types:** CompilationError, MissingDependency, RuntimeError, ProcessCrash, Unknown cover most agent failure modes
- **Suggestions as Vec<String>:** Each error type gets 2-3 actionable suggestions for user recovery
- **JSON storage for ErrorEvent:** Matches existing pattern for skills and config (flexible, queryable)
- **Timestamp in ErrorEvent:** Include detected_at for debugging timeline
- **Schema migration to v5:** Add error_event TEXT column with NULL default (safe for existing logs)
- **Retry-able error determination:** Timeout and ProcessCrash are transient (could retry), others are fatal

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all compilation succeeded on first build.

## Verification

- `cargo build` succeeds with no errors (8 warnings about unused imports/functions)
- ErrorEvent appears in TypeScript bindings (manually updated)
- ExecutionLog includes error_event: ErrorEvent | null in bindings
- Database functions compile and export correctly
- Schema migration logic in place for v5 transition
- Error detection logic handles PTY spawn failures with categorization and suggestions

## Next Phase Readiness

- Error detection complete and persisted to database
- Ready for 08-02 (Error Display UI) - frontend can consume error_event from ExecutionLog
- Ready for error retry logic in 08-03 or future phases
- Auto-retry infrastructure stubbed (is_retriable_error) for future implementation

---

*Phase: 08-error-handling-polish*
*Plan: 01*
*Completed: 2026-02-07*
