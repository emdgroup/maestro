---
phase: 56-import-modal-change-detection
plan: 01
subsystem: api
tags: [rust, ipc, tauri, ticketing, import, sqlite, htmd, bindings]

# Dependency graph
requires:
  - phase: 55-ticketing-integration
    provides: fetch_remote_issues IPC, RemoteIssue struct, provider files (linear, jira_cloud, azure_devops, github, gitlab, forgejo)
provides:
  - RemoteIssue with priority field (normalized Maestro values)
  - import_tasks IPC command — batch insert with duplicate skip
  - update_task_from_remote IPC command — content overwrite from remote
  - dismiss_task_change IPC command — advance external_updated_at only
  - AzDo HTML-to-markdown conversion via htmd
  - Updated TypeScript bindings with all above
affects: [56-02-import-modal-frontend, plan-02]

# Tech tracking
tech-stack:
  added: [htmd = "0.5.4"]
  patterns:
    - "Duplicate check scoped by external_id + project_id (not external_id alone)"
    - "Transaction pattern: conn.transaction() -> operations -> commit() -> emit tasks-changed"
    - "Wave 0 test stubs with #[ignore] attribute (not todo!())"

key-files:
  created: []
  modified:
    - src-tauri/Cargo.toml
    - src-tauri/src/models/ticketing.rs
    - src-tauri/src/ticketing/linear.rs
    - src-tauri/src/ticketing/jira_cloud.rs
    - src-tauri/src/ticketing/azure_devops.rs
    - src-tauri/src/ticketing/github.rs
    - src-tauri/src/ticketing/gitlab.rs
    - src-tauri/src/ticketing/forgejo.rs
    - src-tauri/src/ipc/ticketing_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts

key-decisions:
  - "Duplicate check uses WHERE external_id = ? AND project_id = ? — prevents cross-project collision (github:42 can exist in multiple projects)"
  - "update_task_from_remote and dismiss_task_change are sync (no .await) — DB-only operations"
  - "import_tasks is async — needed for State<'_, Arc<AppState>> compatibility with tokio runtime"
  - "AzDo priority field: Microsoft.VSTO.Priority (integer 1-4 per CONTEXT.md spec)"
  - "Wave 0 test stubs use #[ignore] attribute with empty body — not todo!() which would panic"

patterns-established:
  - "RemoteIssue.priority normalized before leaving provider layer — all consumers receive consistent strings"
  - "html_to_markdown helper: htmd::convert with fallback to original HTML on error"
  - "import_tasks: validate title.len() <= 1000 and external_id.len() <= 200 before INSERT"

requirements-completed: [IMPT-03, CHNG-02]

# Metrics
duration: 25min
completed: 2026-05-24
---

# Phase 56 Plan 01: RemoteIssue priority + three import/change-detection IPC commands

**RemoteIssue gains priority field (normalized across 3 providers), AzDo HTML-to-markdown conversion added via htmd, and three new IPC commands (import_tasks, update_task_from_remote, dismiss_task_change) fully implemented and registered with TypeScript bindings regenerated**

## Performance

- **Duration:** 25 min
- **Started:** 2026-05-24T05:29:00Z
- **Completed:** 2026-05-24T05:54:22Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments
- Added `priority: Option<String>` to `RemoteIssue` and populated it in Linear (1-4 integer mapping), Jira Cloud (name string mapping), AzDo (1-4 integer mapping); GitHub/GitLab/Forgejo set `priority: None`
- Added `htmd = "0.5.4"` dependency, `html_to_markdown()` helper in `azure_devops.rs`, converting `System.Description` HTML to markdown before storing in `RemoteIssue.body`
- Implemented `import_tasks` (async, batch INSERT, skip duplicates by `external_id + project_id`, validate field lengths, emit `tasks-changed`)
- Implemented `update_task_from_remote` (sync, UPDATE title/description/labels/external_updated_at in transaction, emit `tasks-changed`)
- Implemented `dismiss_task_change` (sync, UPDATE external_updated_at only in transaction, emit `tasks-changed`)
- Registered all three commands in `lib.rs` `collect_commands![]`
- Regenerated `bindings.ts` — `RemoteIssue` type includes `priority: string | null`, three new command functions exported

## Task Commits

Each task was committed atomically:

1. **Task 1: Add priority to RemoteIssue + update provider files + add htmd** - `f5d313a` (feat)
2. **Task 2: Implement import_tasks, update_task_from_remote, dismiss_task_change** - `2f9be15` (feat)
3. **Task 3: Regenerate TypeScript bindings** - `5b36b8a` (feat)

## Files Created/Modified
- `src-tauri/Cargo.toml` - Added `htmd = "0.5.4"` dependency
- `src-tauri/src/models/ticketing.rs` - Added `priority: Option<String>` to `RemoteIssue`
- `src-tauri/src/ticketing/linear.rs` - Added `priority` to `LinearIssue`, both query strings, and `RemoteIssue` construction
- `src-tauri/src/ticketing/jira_cloud.rs` - Added `JiraPriority` struct, `priority` to `JiraIssueFields`, URL fields param, and `RemoteIssue` construction
- `src-tauri/src/ticketing/azure_devops.rs` - Added `html_to_markdown` helper, `Microsoft.VSTO.Priority` to `WorkItemFields` and `WIQL_FIELDS`, updated body and priority in `RemoteIssue` construction
- `src-tauri/src/ticketing/github.rs` - Added `priority: None` to `RemoteIssue` construction
- `src-tauri/src/ticketing/gitlab.rs` - Added `priority: None` to `RemoteIssue` construction
- `src-tauri/src/ticketing/forgejo.rs` - Added `priority: None` to `RemoteIssue` construction
- `src-tauri/src/ipc/ticketing_handlers.rs` - Implemented three new IPC commands + Wave 0 test stubs
- `src-tauri/src/lib.rs` - Registered three new commands in `collect_commands![]`
- `src/types/bindings.ts` - Regenerated with updated `RemoteIssue` type and three new command functions

## Decisions Made
- `import_tasks` uses a pre-check query (`SELECT COUNT(*)`) rather than `INSERT OR IGNORE` — this is cleaner for returning the list of actually-created tasks and matches the project's error-handling style
- `update_task_from_remote` and `dismiss_task_change` are sync functions (no `async`) as they only perform DB operations with no network I/O
- Duplicate check scoped to `external_id + project_id` per security requirement — `github:42` is not globally unique

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 (Wave 2) can proceed: all three IPC commands are available in `bindings.ts` with correct TypeScript types
- `RemoteIssue` with `priority` field is ready for use in `ImportTicketsModal` classification logic
- `import_tasks` accepts `base_branch` parameter — frontend must pass project's current branch from `useProjectBranchesQuery`

---
*Phase: 56-import-modal-change-detection*
*Completed: 2026-05-24*
