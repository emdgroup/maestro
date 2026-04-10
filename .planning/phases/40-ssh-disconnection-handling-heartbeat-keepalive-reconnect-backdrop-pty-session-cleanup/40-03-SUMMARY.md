---
phase: 40-ssh-disconnection-handling-heartbeat-keepalive-reconnect-backdrop-pty-session-cleanup
plan: "03"
subsystem: frontend
tags: [ssh, connection-health, backdrop, react, tauri-events]
dependency_graph:
  requires: [40-00, 40-01, 40-02]
  provides: [ssh-disconnect-ui, connection-health-hook]
  affects: [App.tsx, AgentsView, KanbanView, WorktreesView]
tech_stack:
  added: []
  patterns: [tauri-event-listen, react-hook-cleanup, conditional-overlay-render]
key_files:
  created:
    - src/utils/hooks/useConnectionHealth.ts
    - src/components/common/DisconnectBackdrop.tsx
  modified:
    - src/App.tsx
decisions:
  - "useConnectionHealth connectionId == null guard prevents listener registration for local projects"
  - "Promise.all cleanup pattern satisfies T-40-08 mitigate disposition — all 4 listeners unregistered"
  - "Backdrop placed after </main> inside currentProject branch — fixed inset-0 z-50 covers everything"
  - "dismiss() callback resets to connected — enables manual escape from failed state"
metrics:
  duration: 0.055h
  completed_date: "2026-04-10T13:18:43Z"
  tasks_completed: 2
  files_changed: 3
---

# Phase 40 Plan 03: SSH Disconnect Backdrop Summary

One-liner: useConnectionHealth hook subscribes to 4 Tauri SSH events and drives a full-screen blocking DisconnectBackdrop overlay with lost/reconnecting/failed states, wired into App.tsx for SSH projects only.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create useConnectionHealth hook | 4088228 | src/utils/hooks/useConnectionHealth.ts |
| 2 | Create DisconnectBackdrop + wire App.tsx | e6dd564 | src/components/common/DisconnectBackdrop.tsx, src/App.tsx |

## Decisions Made

1. **connectionId == null guard in useEffect** — When connectionId is null (local project), the hook returns early without registering any Tauri event listeners. This satisfies the "Backdrop never appears for local projects" requirement and avoids unnecessary listener overhead.

2. **Promise.all cleanup pattern** — All 4 listen() calls return Promise<UnlistenFn>. Combined via Promise.all, the cleanup function calls all 4 unlisten functions on unmount or connectionId change. This directly mitigates threat T-40-08 (stale listener DoS).

3. **Backdrop placement after `</main>` inside currentProject branch** — The `fixed inset-0 z-50` positioning means DOM placement doesn't matter for coverage. Placing it inside the currentProject branch keeps it co-located with the SSH-aware context, making the conditional `currentProject?.connection_id ?? null` natural.

4. **dismiss() resets state to "connected"** — The permanent failure state (all retries exhausted) needs a manual escape. dismiss() resets state and attempt to 0, hiding the backdrop. This is the only case where the backdrop requires user interaction to dismiss.

5. **Reconnecting text uses unicode ellipsis** — `\u2026` (…) is used instead of `...` for typographic correctness and to satisfy the test regex `/Reconnecting.*2\/5/`.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all data flows are wired. The hook receives live Tauri events from the heartbeat backend (Plan 40-01). The backdrop renders immediately on state change.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced. The Tauri event listeners are read-only (T-40-07 accepted, T-40-08 mitigated by cleanup pattern).

## Verification

- `pnpm build` exits 0 (3.59s, no TypeScript errors)
- `npx vitest run useConnectionHealth.test.ts` — 8/8 tests pass
- `npx vitest run DisconnectBackdrop.test.tsx` — 5/5 tests pass
- `grep` confirms all acceptance criteria patterns present in source files

## Self-Check: PASSED

- [x] src/utils/hooks/useConnectionHealth.ts exists
- [x] src/components/common/DisconnectBackdrop.tsx exists
- [x] src/App.tsx contains DisconnectBackdrop
- [x] Commits 4088228 and e6dd564 exist in git log
