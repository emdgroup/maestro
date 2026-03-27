# Phase 8: Error Handling & Polish - Context

**Gathered:** 2026-02-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Detect agent failures during task execution, pause when errors occur, and enable user recovery through interactive debugging. This phase adds resilience to the existing agent execution system (Phase 4) and terminal streaming (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Error detection triggers
- Claude's discretion on what signals constitute failure (exit codes, stderr patterns, timeouts)
- Retry-able errors (network timeouts, temporary failures) auto-retry without pausing
- Fatal errors (compilation failures, crashes) pause execution immediately
- No failure pattern learning - each error handled independently
- Error context captured with suggestions: parse error, identify likely cause, suggest fixes (e.g., "missing dependency" → "run npm install")

### User notification approach
- Toast notification + task status change (non-blocking)
- Show task name + error type immediately ("Task 'User Auth' failed: Compilation error")
- One notification per failure (no consolidation)
- Full error details accessible by clicking task card → execution history

### Recovery action options
- **Resume**: Retry the exact same command that failed (useful after user fixes environment)
- **Abort task**: Stop execution entirely, mark task as failed
- **Attach terminal**: Open interactive terminal for manual fixes
- After manual fixes, user explicitly clicks Resume button (not automatic on detach)
- If resume fails again, pause again - user can retry indefinitely (no auto-abort limit)

### Terminal interaction flow
- Attach shows full terminal history with input enabled at bottom
- User can attach to ANY task anytime (running or paused) for live monitoring
- Detach = stop watching, agent continues running in background (doesn't change execution state)
- One terminal at a time - opening new terminal closes previous (focused experience)

### Claude's Discretion
- Exact retry count for auto-retry-able errors
- Specific stderr patterns to detect error types
- Error message parsing heuristics for suggestions
- Terminal buffer size and scroll behavior

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-error-handling-polish*
*Context gathered: 2026-02-07*
