# Phase 12: Worktree Disk Cleanup - Context

**Gathered:** 2026-02-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Ensure worktrees are fully removed from disk after successful merge. This closes tech debt from Phase 6 where worktrees may be marked as cleaned in the database but filesystem directories still exist. Focus is on reclaiming disk space and preventing stale directory accumulation.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion

All implementation details are at Claude's discretion:

- **Cleanup timing:** When deletion occurs (likely during finalize_successful_merge handler)
- **Safety verification:** What checks run before deletion (merge status, active processes, uncommitted changes)
- **Cleanup scope:** What gets deleted (worktree directory, git metadata, pruning strategy)
- **Failure handling:** Retry logic, error logging, recovery mechanisms
- **Integration point:** Where cleanup code is added (existing Phase 6 handlers)

</decisions>

<specifics>
## Specific Ideas

No specific requirements - this is a technical debt closure. Standard cleanup approach is acceptable.

**Technical context:**
- Phase 6 created finalize_successful_merge handler
- Node.js sidecar has git worktree management functions
- WorktreeStatus enum tracks lifecycle states
- Database tracks worktree metadata separately from disk state

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 12-worktree-disk-cleanup*
*Context gathered: 2026-02-08*
