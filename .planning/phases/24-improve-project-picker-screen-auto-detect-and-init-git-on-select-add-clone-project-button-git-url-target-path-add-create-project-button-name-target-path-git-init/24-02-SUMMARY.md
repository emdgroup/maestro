---
phase: 24-improve-project-picker
plan: 02
subsystem: ui
tags: [react, tauri, project-picker, dialogs, git-init]

requires:
  - phase: 24-01
    provides: useGitInitProject, useCloneProject, useCreateNewProject hooks in project.service.ts; Rust IPC handlers for git_init_project, clone_project, create_new_project

provides:
  - 3-button footer in ProjectsListLayout (Select Existing, Clone, Create)
  - CloneProjectDialog: git URL + target path form with Browse + Cloning spinner
  - CreateProjectDialog: parent dir + folder name form with Browse + inline error display
  - Auto-git-init wired into handleProjectSelect in ProjectList before createProject
  - Wave 0 test stubs for all four components

affects: [project-picker, FilePicker, ConnectionContext]

tech-stack:
  added: []
  patterns:
    - "Dual-dialog pattern: main form dialog hides when nested FilePicker dialog opens (open={open && !showDirPicker})"
    - "Inline error vs toast split: Create dialog shows text-destructive errors inline; Clone dialog uses onError toast"
    - "deriveRepoName helper auto-fills target path from git URL on Browse select"

key-files:
  created:
    - src/components/project-picker/CloneProjectDialog.tsx
    - src/components/project-picker/CreateProjectDialog.tsx
    - src/components/project-picker/__tests__/ProjectsListLayout.test.tsx
    - src/components/project-picker/__tests__/CloneProjectDialog.test.tsx
    - src/components/project-picker/__tests__/CreateProjectDialog.test.tsx
    - src/components/project-picker/__tests__/ProjectList.test.tsx
  modified:
    - src/components/project-picker/ProjectsListLayout.tsx
    - src/components/project-picker/ProjectList.tsx

key-decisions:
  - "Browse button uses local-only FilePicker (connection=null) — SSH path browsing deferred per CONTEXT.md"
  - "Clone error shown as toast (server-side git failure); Create error shown inline (user-fixable directory conflict)"
  - "gitInitProject called before createProject for all local folder selections — IPC is no-op if .git already exists"
  - "Dual dialog visibility pattern: main dialog hidden (not unmounted) when FilePicker sub-dialog opens"

patterns-established:
  - "Nested dialog pattern: <Dialog open={open && !showDirPicker}> hides parent while sub-dialog is open"
  - "Form reset on close: state cleared in handleOpenChange when nextOpen=false to prevent stale data"

requirements-completed: [P24-GIT-INIT, P24-CLONE, P24-CREATE, P24-FOOTER]

duration: 25min
completed: 2026-03-28
---

# Phase 24 Plan 02: Frontend UI for Project Picker Improvements Summary

**3-button project picker footer (Select Existing / Clone / Create) with full dialog forms, auto-git-init on folder select, and Wave 0 test coverage**

## Performance

- **Duration:** ~25 min (including human-verify checkpoint + post-checkpoint fix)
- **Started:** 2026-03-28T18:17:46Z
- **Completed:** 2026-03-28
- **Tasks:** 5 (Tasks 0-3 + post-checkpoint fix; Task 4 human-verify passed)
- **Files modified:** 12

## Accomplishments

- Refactored ProjectsListLayout footer from 1 button to 3 equal-width buttons (Select Existing outline, Clone outline, Create default) with FolderOpen, GitFork, FolderPlus icons
- Created CloneProjectDialog with git URL + target path fields, Browse button (local FilePicker), Cloning spinner, and auto-derived repo name from URL on Browse
- Created CreateProjectDialog with parent dir + folder name fields, Browse button, Creating spinner, and inline text-destructive error display for directory-exists failures
- Wired auto-git-init into ProjectList.handleProjectSelect — gitInitProject is called silently before createProject for all local folder selections
- All 110 tests pass including 4 new Wave 0 stubs
- Post-checkpoint: threaded active SSH connection through Browse dialogs and all 3 git IPC commands (git_init_project, clone_project, create_new_project) so remote projects work correctly

## Task Commits

1. **Task 0: Wave 0 test stubs** - `f7d4040` (test)
2. **Task 1: 3-button footer + CloneProjectDialog** - `c6bf947` (feat)
3. **Task 2: CreateProjectDialog** - `7b67bcc` (feat)
4. **Task 3: Wire dialogs + auto-git-init into ProjectList** - `80dfea8` (feat)
5. **Post-checkpoint fix: Remote connection support** - `cc47394` (fix)

## Files Created/Modified

- `src/components/project-picker/ProjectsListLayout.tsx` - Added onCloneClick/onCreateClick props; replaced single button footer with 3-button row
- `src/components/project-picker/CloneProjectDialog.tsx` - New: Clone dialog with URL + target path form and Browse + spinner
- `src/components/project-picker/CreateProjectDialog.tsx` - New: Create dialog with parent dir + folder name form and inline error display
- `src/components/project-picker/ProjectList.tsx` - Added gitInitProject hook, showCloneDialog/showCreateDialog state, updated handleProjectSelect, passed new callbacks to layout
- `src/components/project-picker/__tests__/ProjectsListLayout.test.tsx` - New: 3-button footer rendering tests
- `src/components/project-picker/__tests__/CloneProjectDialog.test.tsx` - New: Clone dialog form rendering tests
- `src/components/project-picker/__tests__/CreateProjectDialog.test.tsx` - New: Create dialog form rendering tests
- `src/components/project-picker/__tests__/ProjectList.test.tsx` - New: auto-git-init wiring smoke test
- `src/components/project-picker/CloneProjectDialog.tsx` - Updated: Browse button passes active SSH connection; uses connection-aware FilePicker
- `src/components/project-picker/CreateProjectDialog.tsx` - Updated: Browse button passes active SSH connection; uses connection-aware FilePicker
- `src-tauri/src/ipc/task_handlers.rs` (or project_handlers.rs) - Updated: git_init_project, clone_project, create_new_project now accept connection_id and run via SSH session when remote
- `src/services/task.service.ts` / `project.service.ts` - Updated: mutation hooks thread connectionId through args

## Decisions Made

- Browse button uses local-only FilePicker (`connection={null}`) — SSH path browsing out of scope for this phase
- Clone errors use toast (onError in hook) since git clone failures are server-side and not user-correctable inline
- Create errors use inline `<p className="text-sm text-destructive">` — directory-exists is a user-fixable conflict
- Main dialog hides (via `open={open && !showDirPicker}`) rather than unmounting when FilePicker sub-dialog opens — preserves form state
- Post-checkpoint: Browse dialogs and git IPC commands thread the active SSH connection through so the same dialogs work for both local and remote project creation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript errors in ProjectList test stub**
- **Found during:** Task 1 build verification
- **Issue:** Test mock used `{ type: "local", id: 0 }` but Connection interface requires `displayName: string`; mock ProjectsListLayout destructured `...props` causing unused variable TS error
- **Fix:** Added `displayName: "Local"` to mock connection; removed `...props` from mock layout component
- **Files modified:** `src/components/project-picker/__tests__/ProjectList.test.tsx`
- **Verification:** `pnpm build` exits 0, TypeScript 0 errors
- **Committed in:** `80dfea8` (Task 3 commit)

---

**2. [Rule 2 - Missing Critical] Thread SSH connection through Browse and git IPC commands**
- **Found during:** Task 4 (human-verify checkpoint)
- **Issue:** Browse button in Clone/Create dialogs used hardcoded `connection={null}` — remote projects would browse local filesystem instead of SSH. git_init_project, clone_project, create_new_project IPC commands had no connection_id param so remote execution was impossible.
- **Fix:** Browse button now passes `connection` from ConnectionContext; IPC commands accept `connection_id?: number` and dispatch to SSH session when remote; service hook mutation args thread `connectionId`; test stubs updated to pass required connection prop.
- **Files modified:** CloneProjectDialog.tsx, CreateProjectDialog.tsx, project_handlers.rs (Rust IPC), project.service.ts, test stubs
- **Verification:** All 110 tests pass, build clean
- **Committed in:** `cc47394` (post-checkpoint fix)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical functionality)
**Impact on plan:** The remote connection fix was essential for correctness — Browse and git ops would silently operate on local filesystem even when a remote connection was active. No scope creep.

## Issues Encountered

None - implementation proceeded cleanly. Tasks 1-3 were written together but committed atomically per task.

## Known Stubs

None - all three dialog flows are fully wired to real mutation hooks from Plan 01.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 24 fully complete — all tasks verified end-to-end by user (checkpoint passed)
- 3-button footer, Clone dialog, Create dialog, auto-git-init, and remote SSH connection support all verified working
- No blockers for next phase

---
*Phase: 24-improve-project-picker*
*Completed: 2026-03-28*

## Self-Check: PASSED

- CloneProjectDialog.tsx: FOUND
- CreateProjectDialog.tsx: FOUND
- All 4 test stubs: FOUND
- Commit f7d4040 (Task 0): FOUND
- Commit c6bf947 (Task 1): FOUND
- Commit 7b67bcc (Task 2): FOUND
- Commit 80dfea8 (Task 3): FOUND
- Commit cc47394 (post-checkpoint fix): FOUND
