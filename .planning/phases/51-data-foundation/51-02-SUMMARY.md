---
phase: 51-data-foundation
plan: 02
subsystem: api
tags: [rust, react, typescript, tauri, cleanup, legacy-removal]

# Dependency graph
requires:
  - phase: 51-01
    provides: ticketing module and schema v16 migration foundation
provides:
  - Clean Rust backend with no legacy sync/import IPC handlers
  - Clean React frontend with no ImportSettings component or sync hooks
  - Regenerated TypeScript bindings without SyncResult type or sync command stubs
affects: [52, 53, 54, 55, 56]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - src-tauri/src/ipc/settings_handlers.rs
    - src-tauri/src/models/mod.rs
    - src-tauri/src/lib.rs
    - src/App.tsx
    - src/services/project.service.ts
    - src/types/bindings.ts

key-decisions:
  - "D-13: Removed sync_github_issues, sync_jira_issues, save_import_config from settings_handlers.rs"
  - "D-14: Removed upsert_imported_tasks helper from settings_handlers.rs"
  - "D-15: Deleted src/components/task/ImportSettings.tsx entirely"
  - "D-16: Deleted src-tauri/src/models/sync.rs entirely"
  - "SyncButton.tsx deleted (dead code, no consumers) — cascade from removing sync hooks"
  - "useSaveImportConfig, useSyncGithubIssues, useSyncJiraIssues removed from project.service.ts to satisfy zero-grep success criteria"

patterns-established: []

requirements-completed: [FNDTN-04]

# Metrics
duration: 12min
completed: 2026-05-20
---

# Phase 51 Plan 02: Remove Legacy Import/Sync Code Summary

**Deleted 4 legacy sync/import artifacts (sync.rs, ImportSettings.tsx, SyncButton.tsx, 3 IPC handlers) leaving zero grep matches across the entire codebase for removed symbols**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-20T23:18:03Z
- **Completed:** 2026-05-20T23:30:00Z
- **Tasks:** 2
- **Files modified:** 6 modified, 4 deleted

## Accomplishments
- Removed all legacy GitHub/Jira sync IPC handlers from Rust backend (sync_github_issues, sync_jira_issues, save_import_config, upsert_imported_tasks)
- Deleted src-tauri/src/models/sync.rs with all 5 legacy types (SyncResult, GitHubIssue, JiraIssue, JiraSearchResponse, JiraFields)
- Deleted ImportSettings.tsx and SyncButton.tsx from React frontend, cleaned all references from App.tsx and project.service.ts
- Regenerated TypeScript bindings — SyncResult type and sync command stubs removed from bindings.ts
- cargo check and pnpm build both pass with zero errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove legacy Rust sync code and deregister commands** - `74eef21` (feat)
2. **Task 2: Remove ImportSettings component and clean App.tsx** - `1b8c91a` (feat)

**Plan metadata:** (docs commit — see final_commit step)

## Files Created/Modified
- `src-tauri/src/ipc/settings_handlers.rs` - Removed sync functions; now only get_settings and save_settings remain
- `src-tauri/src/models/mod.rs` - Removed `pub mod sync` and sync type re-exports
- `src-tauri/src/lib.rs` - Removed SyncResult from pub use; removed 3 sync commands from collect_commands!
- `src-tauri/src/models/sync.rs` - DELETED (SyncResult, GitHubIssue, JiraIssue, JiraSearchResponse, JiraFields)
- `src/App.tsx` - Removed ImportSettings lazy import, showImportSettings state, handleImportConfigSaved, JSX element
- `src/components/task/ImportSettings.tsx` - DELETED
- `src/components/common/SyncButton.tsx` - DELETED (dead code, no consumers)
- `src/services/project.service.ts` - Removed useSaveImportConfig, useSyncGithubIssues, useSyncJiraIssues; removed JsonValue import
- `src/types/bindings.ts` - Regenerated; SyncResult type and sync command stubs removed

## Decisions Made
- Cascade-removed SyncButton.tsx (not in plan) because it imported useSyncGithubIssues/useSyncJiraIssues with no consumers — required to satisfy success criteria (zero grep matches for sync symbols in any .ts/.tsx file)
- Cascade-removed sync mutation hooks from project.service.ts for same reason
- Regenerated bindings via `pnpm tauri:gen` to remove SyncResult from generated bindings.ts

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Removed SyncButton.tsx and sync hooks from project.service.ts**
- **Found during:** Task 2 (Remove ImportSettings component and clean App.tsx)
- **Issue:** Plan only specified removing ImportSettings.tsx and cleaning App.tsx. But SyncButton.tsx (no consumers) and useSyncGithubIssues/useSyncJiraIssues/useSaveImportConfig in project.service.ts would leave grep matches for removed symbols, violating the plan's success criteria (zero grep matches for SyncResult, sync_github_issues, etc. in any .ts/.tsx file)
- **Fix:** Deleted SyncButton.tsx; removed three sync mutation hooks from project.service.ts; removed JsonValue from its import; regenerated TypeScript bindings
- **Files modified:** src/components/common/SyncButton.tsx (deleted), src/services/project.service.ts, src/types/bindings.ts
- **Verification:** grep returns zero matches; pnpm build passes
- **Committed in:** 1b8c91a (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical — cascade cleanup required by success criteria)
**Impact on plan:** Auto-fix was necessary to satisfy the plan's own success criteria. No scope creep — all removed code was directly connected to the sync/import system being eliminated.

## Issues Encountered
None — both tasks completed cleanly with no blocking issues.

## Known Stubs
None — this plan only removed dead code, no new stubs introduced.

## Threat Flags
None — this plan removes code only. No new trust boundaries, endpoints, or data paths introduced.

## Next Phase Readiness
- Rust backend is clean: no sync/import IPC handlers exist
- React frontend is clean: no ImportSettings UI, no sync hooks
- TypeScript bindings are fresh: SyncResult and sync command stubs removed
- Phases 52-56 (ticketing integration) can build on this clean slate without conflicts

---
*Phase: 51-data-foundation*
*Completed: 2026-05-20*
