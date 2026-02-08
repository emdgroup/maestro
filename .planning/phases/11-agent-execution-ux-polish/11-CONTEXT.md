# Phase 11: Agent Execution UX Polish - Context

**Gathered:** 2026-02-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete the agent execution workflow user experience by adding visual status indicators, real worktree leasing integration, pause/resume controls, and failure notifications. This phase addresses technical debt from Phase 4 where execution works functionally but lacks polish.

Scope: Make existing execution workflow **visible, controllable, and informative** for users. Does not add new execution capabilities—polishes what exists.

</domain>

<decisions>
## Implementation Decisions

### Status Visualization
- **Badge position:** Top-right corner of TaskCard (floating badge, highly visible)
- **States with visual treatment:** Running (InProgress) and Failed only
- **Animation:** Pulsing badge animation for Running state (subtle, not distracting)
- **Colors:** Semantic colors (blue for running, red for failed)
- **Elapsed time:** Display live elapsed time in badge (e.g., "2m 34s")
- **Success state:** Badge persists with green checkmark until task moved to next column
- **Post-execution:** No badge after InProgress column (cleaner Review/Done views)
- **Interaction:** Badge is display-only (not clickable, existing card click opens history)

### Failure Notifications
- **Notification method:** Badge + toast combo (toast for immediate alert, badge persists)
- **Toast content:** Task name + error type (e.g., "Failed: Add user auth — CompilationError")
- **Duration:** Auto-dismiss after 10 seconds (failed badge persists on card)
- **Multiple failures:** Stack toasts (Sonner default behavior, each failure visible)

### Worktree Integration
- **Worktree visibility:** Hide from users (internal implementation detail)
- **Lease failure handling:** Retry automatically with silent worktree creation (user sees brief delay)
- **Pool status:** No global pool visibility (fully automatic capacity management)
- **Fatal failures:** Show error toast, user must manually retry Execute (clear feedback + control)
- **Execute button states:** Show loading spinner during lease/creation (visual feedback)
- **Lease timing:** Lease worktree on Execute click, before agent spawn (guarantees availability)

### Claude's Discretion
- Exact badge sizing and corner offset
- Pulse animation implementation (CSS keyframes vs JS)
- Error toast styling details (icon choice, spacing)
- Retry backoff strategy for automatic worktree creation
- Loading spinner animation style

</decisions>

<specifics>
## Specific Ideas

- Phase 8 already has Failed status with red styling (#fee2e2 background, #991b1b text) — keep consistent
- Sonner toast library already in use from Phase 2 — reuse for failure notifications
- Status badge should not interfere with existing TaskCard click behavior (opens execution history)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 11-agent-execution-ux-polish*
*Context gathered: 2026-02-08*
