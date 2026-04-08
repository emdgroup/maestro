---
phase: 39-fix-ssh-terminal-session-switching
plan: "03"
subsystem: ui
tags: [xterm, terminal, pty, requestAnimationFrame, session-switching]

requires:
  - phase: 39-fix-ssh-terminal-session-switching-02
    provides: SSH PTY history buffer (String-based, clear-screen boundary trimming, 512 KB cap)

provides:
  - Terminal mount timing: fit -> clear-screen -> attach sequence inside single rAF callback
  - No stale content flash on session switch (terminal cleared before first attach)

affects:
  - AgentsView terminal UX on session switch

tech-stack:
  added: []
  patterns:
    - "rAF-gated attach: tryAttach() runs inside requestAnimationFrame after fitAddon.fit() and terminal.write(clear-screen)"

key-files:
  created: []
  modified:
    - src/components/execution/Terminal.tsx

key-decisions:
  - "tryAttach() moved inside rAF callback (after fitAddon.fit()) so SIGWINCH fires before attach — programs repaint into a blank buffer"
  - "terminal.write('\\x1b[2J\\x1b[H') clears xterm display buffer before tryAttach() to guarantee blank first visible frame"
  - "channel and onmessage handler are set up before rAF so data arriving from attachTerminal is correctly written"

patterns-established:
  - "Terminal mount order: open -> onResize -> channel setup -> tryAttach definition -> rAF(fit -> clear -> attach)"

requirements-completed:
  - FRONTEND-RAF-REORDER
  - FRONTEND-CLEAR-SCREEN-GUARD

duration: 1min
completed: 2026-04-08
---

# Phase 39 Plan 03: Fix Terminal Mount Timing Summary

**requestAnimationFrame-gated clear-screen-then-attach sequence eliminates stale content flash on SSH terminal session switching**

## Performance

- **Duration:** 1 min
- **Started:** 2026-04-08T16:05:16Z
- **Completed:** 2026-04-08T16:06:29Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Moved `tryAttach()` inside the `requestAnimationFrame` callback so it runs after `fitAddon.fit()` has already fired the SIGWINCH (via `onResize` -> `api.resizeTerminal()`)
- Added `terminal.write('\x1b[2J\x1b[H')` before `tryAttach()` inside the rAF so the xterm display is cleared before any session output arrives
- Removed the standalone `tryAttach()` call that previously existed outside the rAF — no more double-attach risk

## Task Commits

1. **Task 1: Move tryAttach inside rAF callback with clear-screen guard** - `ff70d02` (fix)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/components/execution/Terminal.tsx` - Mount timing: channel setup before rAF; rAF does fit -> clear-screen -> attach in one callback

## Decisions Made

- `tryAttach()` moved inside rAF after `fitAddon.fit()` — SIGWINCH sent before attach so program repaints into blank buffer
- `terminal.write('\x1b[2J\x1b[H')` is a cosmetic guard (clears the xterm viewport buffer) complementing the backend history buffer's clear-screen trimming from Plan 02
- Channel (`channel.onmessage`) set up before the rAF so data delivered by `attachTerminal` is never dropped

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - single clean edit, build passes in 6.25s with 0 TypeScript errors.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 39 is complete. All three plans delivered:
- Plan 01: SSH PTY history buffer architecture (String-based, 512 KB cap)
- Plan 02: Dead session DB snapshot + live session attach-from-history-offset
- Plan 03: Frontend mount timing — rAF-gated clear-screen-then-attach

No blockers. Terminal session switching should now show a blank frame then receive fresh repainted content via SIGWINCH.

---
*Phase: 39-fix-ssh-terminal-session-switching*
*Completed: 2026-04-08*

## Self-Check: PASSED

- FOUND: src/components/execution/Terminal.tsx
- FOUND: commit ff70d02
