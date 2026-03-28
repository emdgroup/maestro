---
phase: quick
plan: 260328-ty5
subsystem: ui
tags: [react, tauri, rust, task-form, git-branches, task-service]

requires: []
provides:
  - "list_project_branches IPC command returning (branches, currentBranch) tuple"
  - "TaskForm with branch Select dropdown instead of text Input for originBranch"
  - "TaskForm without skills selector"
  - "TaskDetail without skills display section"
  - "useProjectBranchesQuery hook in task.service.ts"
affects: [task-creation, task-editing, backlog-view]

tech-stack:
  added: []
  patterns:
    - "git::list_branches + git::get_current_branch dispatcher pattern for local vs remote"
    - "api proxy unwraps Result<T,E> so useQuery data is T not Result<T,E>"

key-files:
  created: []
  modified:
    - src-tauri/src/git/mod.rs
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
    - src/components/task/TaskForm.tsx
    - src/components/task/TaskDetail.tsx
    - src/components/kanban/BacklogTaskSheet.tsx
    - src/services/task.service.ts

key-decisions:
  - "list_branches_local uses std::process::Command git branch -a and deduplicates local+remote-tracking names"
  - "get_current_branch falls back to 'main' string when git rev-parse fails or returns HEAD (detached)"
  - "Remote GitConnection get_current_branch returns 'main' as placeholder (SSH current branch not implemented)"
  - "Branch Select falls back to text Input when branches list is empty (non-git projects)"
  - "useEffect sets originBranch default to currentBranch only when no initialValues.originBranch provided"
  - "skills field removed from TaskFormData interface; submitHandler passes skills: [] for backend compat"

requirements-completed: []

duration: 15min
completed: 2026-03-28
---

# Quick Task 260328-ty5: Remove Skills from Task Forms + Branch Dropdown Summary

**Skills selector removed from task creation/editing UI; origin branch replaced with git branch dropdown defaulting to currently checked-out branch via new list_project_branches IPC command**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-28T00:00:00Z
- **Completed:** 2026-03-28T00:15:00Z
- **Tasks:** 1
- **Files modified:** 8

## Accomplishments

- Removed AVAILABLE_SKILLS constant and skills Controller/Select/Badge UI from TaskForm entirely
- Removed skills display section from TaskDetail info tab
- Removed skills from BacklogTaskSheet taskToFormValues and edit update payload
- Implemented list_branches_local in git/mod.rs using `git branch -a` with deduplication of local/remote-tracking names
- Implemented get_current_branch_local using `git rev-parse --abbrev-ref HEAD` with fallback to "main"
- Added list_project_branches async IPC command with DB lookup and GitConnection dispatch
- Registered command in lib.rs collect_commands! and regenerated TypeScript bindings
- Added useProjectBranchesQuery hook in task.service.ts (60s staleTime)
- Replaced origin branch Input with Select dropdown in TaskForm, fallback to Input when no branches available
- useEffect wires currentBranch from query data as default form value on first load

## Task Commits

1. **Task 1: Remove skills UI and add branch dropdown** - `f1f4202` (feat)

## Files Created/Modified

- `src-tauri/src/git/mod.rs` - Implemented list_branches_local, get_current_branch_local, get_current_branch dispatcher
- `src-tauri/src/ipc/task_handlers.rs` - Added list_project_branches async IPC command
- `src-tauri/src/lib.rs` - Registered list_project_branches in collect_commands!
- `src/types/bindings.ts` - Regenerated with listProjectBranches binding
- `src/components/task/TaskForm.tsx` - Removed skills, replaced originBranch Input with Select dropdown
- `src/components/task/TaskDetail.tsx` - Removed Skills display section
- `src/components/kanban/BacklogTaskSheet.tsx` - Removed skills from taskToFormValues and edit updates
- `src/services/task.service.ts` - Added useProjectBranchesQuery hook

## Decisions Made

- `api` proxy in tauri-utils.ts automatically unwraps `Result<T,E>` so `useQuery` data is typed as `T` (the tuple `[string[], string]`), not the full `Result` wrapper — initial code checked `.status/.data` which failed TypeScript; corrected to direct tuple access
- Remote GitConnection `get_current_branch` returns `"main"` as placeholder; SSH current branch detection deferred
- Branch deduplication via sort+dedup handles overlap between local branches and remote-tracking refs

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Result wrapper access pattern for branchData**
- **Found during:** Task 1 (frontend build)
- **Issue:** Code accessed `branchData?.status` and `branchData?.data[0]` but the `api` proxy unwraps `Result<T,E>` to `T`, so data is `[string[], string]` tuple directly
- **Fix:** Changed to `branchData ? branchData[0] : []` and `branchData ? branchData[1] : ""`
- **Files modified:** src/components/task/TaskForm.tsx
- **Verification:** `pnpm build` passed with 0 TypeScript errors
- **Committed in:** f1f4202 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in Result access pattern)
**Impact on plan:** Minor correction during implementation. No scope creep.

## Issues Encountered

- TypeScript error on `branchData.status` — resolved by recognizing api proxy unwraps Result before TanStack Query sees it

## Known Stubs

None — branch list is populated from real `git branch -a` output. Falls back to text input if git unavailable.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Task form is simplified without skills clutter
- Origin branch dropdown provides real branches from git, preventing typos
- Remote project current branch detection always returns "main" — could be improved in a future task if needed

---
*Phase: quick*
*Completed: 2026-03-28*
