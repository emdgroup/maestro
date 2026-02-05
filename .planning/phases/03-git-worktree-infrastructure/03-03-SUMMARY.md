# Plan 03-03 Summary: Automatic Cleanup Workflow

## What Was Built

Post-merge worktree cleanup system with dirty-state recovery:

1. **cleanup_worktree Handler** (async)
   - Fetch worktree record from database
   - Mark worktree as 'Dirty' (durable recovery flag)
   - Sidecar invocation stubbed (TODO: Phase 4 tokio::process::Command)
   - Delete worktree from database on success
   - Returns Err if cleanup fails (worktree stays Dirty for retry)

2. **recover_dirty_worktrees Handler** (async)
   - Query all worktrees with status='Dirty'
   - Attempt cleanup via sidecar for each (stubbed)
   - Delete from database on success
   - Log failures, keep in Dirty state for next retry
   - Returns Vec of recovered worktree IDs

3. **Lifecycle Documentation**
   - Documented full cleanup workflow in handlers.rs
   - Integration point: App.tsx should call recover_dirty_worktrees on project open
   - State machine: Leased/InUse → Dirty → deleted

## Technical Approach

- **Recovery Pattern:** Mark Dirty before cleanup (survives crashes)
- **Async Safety:** Both handlers use async pattern for future tokio::process::Command
- **Database Transactions:** Atomic state transitions
- **Error Handling:** Failed cleanups stay Dirty, don't block new executions

## Commits

- 287d73d: feat(03-03): implement cleanup handlers for worktree lifecycle

## Integration Points

**Phase 2 (App.tsx):**
- Call recover_dirty_worktrees() in useEffect on project open
- Ensures stuck worktrees from previous crashes are recovered

**Phase 4 (Agent Execution):**
- Replace sidecar stubs with actual tokio::process::Command
- Spawn sidecar with deleteWorktree function
- Handle stderr and exit codes

**Phase 6 (Review & Merge):**
- Call cleanup_worktree after merge to main
- Triggers worktree deletion and branch cleanup

## Verification

✓ cleanup_worktree async handler exists
✓ recover_dirty_worktrees async handler exists
✓ Both registered in Tauri handler
✓ Documentation includes lifecycle and integration points
✓ Code compiles successfully

## Deviations

**Sidecar Integration Deferred:**
Both handlers have sidecar invocation stubbed with TODO comments for Phase 4. This matches the pattern from Plan 03-02 where actual git operations are deferred to Phase 4.

## Issues Encountered

**Rust Borrowing:**
Initial implementation had borrowing issues with query_map iterator. Fixed by collecting results before connection drops.

## Next Steps

Phase 3-04 will implement pool pre-creation (initialize_worktree_pool) to create 3 database entries on project open for instant allocation.
