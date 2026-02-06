# Phase 6: Review & Merge Workflow - Context

**Gathered:** 2026-02-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Human-in-the-loop approval gate where users review agent changes via file diffs, make approval decisions (Approve/Request Changes/Comment), and trigger automatic merge and cleanup. This phase focuses on visual presentation of changes, approval workflows, and safe merge automation.

</domain>

<decisions>
## Implementation Decisions

### Diff Presentation
- Unified view (like GitHub) — single column showing removed (-) and added (+) lines in sequence
- Full syntax highlighting by language (JS/TS/Rust/etc.) for easier code reading
- File tree navigation on left side — collapsible folder structure showing all changed files
- 5-7 context lines around each change (balanced context without overwhelming the view)

### Approval Mechanics
- Three approval actions: Approve, Request Changes, Comment
- Feedback captured via both general text field AND per-file comments (structured + freeform)
- Request Changes moves task back to InProgress column (user can re-execute agent or fix manually)
- Comment-only NOT supported — all comments require Approve or Request Changes decision

### Merge Behavior
- Squash merge strategy (all agent commits squashed into single commit on main)
- Merge conflicts trigger auto-reject to InProgress with conflict feedback
- On successful merge: task moves to Done, worktree and branch immediately cleaned up and returned to pool
- No pre-merge testing — user reviews diffs and execution logs, trusts agent output

### Safety and Visibility
- Task status indicators (e.g., "Merging..." badge) + toast notifications on completion
- No undo/revert UI — user handles rollbacks via terminal/git commands if needed
- Merge errors (non-conflict) show error modal with details, task stays in Review
- No action blocking during merge — rely on worktree isolation to prevent conflicts

### Claude's Discretion
- Exact diff parsing and rendering implementation
- File tree collapsing/expanding behavior
- Toast notification timing and styling
- Error modal layout and styling
- Comment attachment UI (per-file vs inline)

</decisions>

<specifics>
## Specific Ideas

- Unified diff view should feel familiar to developers (GitHub-style)
- Syntax highlighting is important for code review confidence
- File tree navigation provides better spatial awareness than flat lists
- Three-way approval (Approve/Request Changes/Comment) mirrors GitHub PR workflow
- Squash merge keeps main branch history clean and focused on task-level changes
- Immediate cleanup after merge reinforces "worktrees are ephemeral" mental model

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 06-review-merge-workflow*
*Context gathered: 2026-02-06*
