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

duration: 3min
completed: 2026-03-28
---

# Phase 24 Plan 02: Frontend UI for Project Picker Improvements Summary

**3-button project picker footer (Select Existing / Clone / Create) with full dialog forms, auto-git-init on folder select, and Wave 0 test coverage**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-28T18:17:46Z
- **Completed:** 2026-03-28T18:20:48Z
- **Tasks:** 4 (Tasks 0-3 complete; Task 4 is human-verify checkpoint)
- **Files modified:** 8

## Accomplishments

- Refactored ProjectsListLayout footer from 1 button to 3 equal-width buttons (Select Existing outline, Clone outline, Create default) with FolderOpen, GitFork, FolderPlus icons
- Created CloneProjectDialog with git URL + target path fields, Browse button (local FilePicker), Cloning spinner, and auto-derived repo name from URL on Browse
- Created CreateProjectDialog with parent dir + folder name fields, Browse button, Creating spinner, and inline text-destructive error display for directory-exists failures
- Wired auto-git-init into ProjectList.handleProjectSelect — gitInitProject is called silently before createProject for all local folder selections
- All 110 tests pass including 4 new Wave 0 stubs

## Task Commits

1. **Task 0: Wave 0 test stubs** - `f7d4040` (test)
2. **Task 1: 3-button footer + CloneProjectDialog** - `c6bf947` (feat)
3. **Task 2: CreateProjectDialog** - `7b67bcc` (feat)
4. **Task 3: Wire dialogs + auto-git-init into ProjectList** - `80dfea8` (feat)

## Files Created/Modified

- `src/components/project-picker/ProjectsListLayout.tsx` - Added onCloneClick/onCreateClick props; replaced single button footer with 3-button row
- `src/components/project-picker/CloneProjectDialog.tsx` - New: Clone dialog with URL + target path form and Browse + spinner
- `src/components/project-picker/CreateProjectDialog.tsx` - New: Create dialog with parent dir + folder name form and inline error display
- `src/components/project-picker/ProjectList.tsx` - Added gitInitProject hook, showCloneDialog/showCreateDialog state, updated handleProjectSelect, passed new callbacks to layout
- `src/components/project-picker/__tests__/ProjectsListLayout.test.tsx` - New: 3-button footer rendering tests
- `src/components/project-picker/__tests__/CloneProjectDialog.test.tsx` - New: Clone dialog form rendering tests
- `src/components/project-picker/__tests__/CreateProjectDialog.test.tsx` - New: Create dialog form rendering tests
- `src/components/project-picker/__tests__/ProjectList.test.tsx` - New: auto-git-init wiring smoke test

## Decisions Made

- Browse button uses local-only FilePicker (`connection={null}`) — SSH path browsing out of scope for this phase
- Clone errors use toast (onError in hook) since git clone failures are server-side and not user-correctable inline
- Create errors use inline `<p className="text-sm text-destructive">` — directory-exists is a user-fixable conflict
- Main dialog hides (via `open={open && !showDirPicker}`) rather than unmounting when FilePicker sub-dialog opens — preserves form state

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

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor test mock type correction. No scope creep.

## Issues Encountered

None - implementation proceeded cleanly. Tasks 1-3 were written together but committed atomically per task.

## Known Stubs

None - all three dialog flows are fully wired to real mutation hooks from Plan 01.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Task 4 (human-verify checkpoint) pending: user must run `pnpm tauri:dev` and verify the 3-button footer, Clone dialog, Create dialog, and auto-git-init flow work end-to-end
- After verification, Phase 24 is fully complete

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
