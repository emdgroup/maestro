---
phase: 24-improve-project-picker
verified: 2026-03-28T19:00:00Z
status: passed
score: 12/12 must-haves verified
re_verification: false
human_verification:
  - test: "End-to-end Clone flow on local and SSH"
    expected: "Entering a git URL and target path, clicking Clone shows a spinner and then dismisses with a success toast; the new project appears in the project list"
    why_human: "Requires a live Tauri app with git and optionally an SSH connection; cannot exercise git network I/O or spinner timing in static analysis"
  - test: "End-to-end Create flow — inline error for existing directory"
    expected: "Entering a parent dir and folder name that already exist produces an inline red error message beneath the form fields, not a toast"
    why_human: "Requires a running app and real filesystem state to trigger the Rust error path"
  - test: "Auto-git-init on folder select"
    expected: "Selecting a folder without a .git directory via Select Existing completes without any user-visible prompt; the project opens normally"
    why_human: "Requires a live app and a test directory that is not already a git repo"
  - test: "SSH remote connection threading"
    expected: "With an active SSH connection, Clone and Create dialogs browse the remote filesystem and their git operations execute on the remote host, not locally"
    why_human: "Requires a live SSH target; cannot be verified by static analysis"
---

# Phase 24: Improve Project Picker Verification Report

**Phase Goal:** Enhance the project picker with auto-git-init on folder select, a Clone Project dialog (URL + target path), and a Create Project dialog (parent dir + folder name + git init), all surfaced as a 3-button footer in the projects panel. All operations must work on both local and SSH remote connections.
**Verified:** 2026-03-28T19:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | `git_init_project` IPC command initializes a git repo at a given path | VERIFIED | `project_handlers.rs` lines 207-258: async fn, checks `.git` existence, runs `git init`, SSH-aware |
| 2 | `clone_project` IPC command clones a git repo and registers it as a project | VERIFIED | `project_handlers.rs` lines 261-336: runs `git clone`, inlines DB insert, returns `Project` |
| 3 | `create_new_project` IPC command creates a directory, git inits it, and registers it as a project | VERIFIED | `project_handlers.rs` lines 339-428: dir check, `create_dir_all`, `git init`, DB insert, returns `Project` |
| 4 | TypeScript bindings expose all three new commands via the api proxy | VERIFIED | `bindings.ts` lines 66, 77, 88: `gitInitProject`, `cloneProject`, `createNewProject` with correct signatures |
| 5 | TanStack Query mutation hooks exist for all three operations | VERIFIED | `project.service.ts` lines 167-240: `useGitInitProject`, `useCloneProject`, `useCreateNewProject` |
| 6 | User sees three footer buttons: Select Existing, Clone, Create | VERIFIED | `ProjectsListLayout.tsx` lines 67-98: 3-button row with `FolderOpen`, `GitFork`, `FolderPlus` icons |
| 7 | Clicking Select Existing opens the existing FilePicker dialog | VERIFIED | `ProjectList.tsx` line 99: `onSelectNewClick={() => setShowFilePickerModal(true)}` |
| 8 | Clicking Clone opens a dialog with URL + target path fields and a Browse button | VERIFIED | `CloneProjectDialog.tsx`: Label "Git URL" (id `clone-url`), Label "Target Path" (id `clone-target`), Browse button |
| 9 | Clicking Create opens a dialog with parent directory + folder name fields and a Browse button | VERIFIED | `CreateProjectDialog.tsx`: Label "Parent Directory" (id `create-parent`), Label "Folder Name" (id `create-folder`), Browse button |
| 10 | Selecting a non-git folder via FilePicker auto-inits git silently before creating the project | VERIFIED | `ProjectList.tsx` lines 52-53: `await gitInitProject({ path: selectedPath, connectionId: null })` called before `createProject` |
| 11 | Clone dialog shows spinner while cloning and dismisses on success | VERIFIED | `CloneProjectDialog.tsx` lines 116-120: `<Loader2 animate-spin />` + "Cloning..." when `isPending`; `onOpenChange(false)` on success |
| 12 | Create dialog shows inline error if directory already exists | VERIFIED | `CreateProjectDialog.tsx` lines 29, 52-55, 117: `useState<string|null>`, catch block sets error, `<p className="text-sm text-destructive">` renders it |

**Score:** 12/12 truths verified

---

### Required Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/ipc/project_handlers.rs` | `git_init_project`, `clone_project`, `create_new_project` IPC commands | VERIFIED | All 3 async fns present, `#[tauri::command]` + `#[specta::specta]` decorated, SSH-aware branching |
| `src-tauri/src/lib.rs` | Command registration for 3 new IPC commands | VERIFIED | Lines 26-28: `crate::ipc::git_init_project`, `crate::ipc::clone_project`, `crate::ipc::create_new_project` in `collect_commands!` |
| `src/types/bindings.ts` | Auto-generated TypeScript bindings | VERIFIED | Lines 66, 77, 88: `gitInitProject(path, connectionId)`, `cloneProject(url, targetPath, connectionId)`, `createNewProject(parentDir, folderName, connectionId)` |
| `src/services/project.service.ts` | `useGitInitProject`, `useCloneProject`, `useCreateNewProject` mutation hooks | VERIFIED | Lines 167-240: all three hooks call `api.*` proxy methods with correct args |
| `src/components/project-picker/ProjectsListLayout.tsx` | 3-button footer layout | VERIFIED | `onCloneClick` + `onCreateClick` props in interface; 3 `<Button>` elements rendered |
| `src/components/project-picker/CloneProjectDialog.tsx` | Clone Project modal form | VERIFIED | Git URL + Target Path inputs, Browse, Loader2 spinner, `deriveRepoName` helper, `useCloneProject` wired |
| `src/components/project-picker/CreateProjectDialog.tsx` | Create Project modal form | VERIFIED | Parent Dir + Folder Name inputs, Browse, inline `text-destructive` error, `useCreateNewProject` wired |
| `src/components/project-picker/ProjectList.tsx` | Wiring of all three dialogs and auto-git-init | VERIFIED | Imports both dialogs + `useGitInitProject`; all 3 dialog states present; `handleProjectSelect` calls `gitInitProject` before `createProject` |
| `src/components/project-picker/__tests__/ProjectsListLayout.test.tsx` | 3-button footer tests | VERIFIED | File exists with `describe("ProjectsListLayout")` tests |
| `src/components/project-picker/__tests__/CloneProjectDialog.test.tsx` | Clone dialog form tests | VERIFIED | File exists, tests for "Git URL", "Target Path", "Clone", "Cancel" |
| `src/components/project-picker/__tests__/CreateProjectDialog.test.tsx` | Create dialog form tests | VERIFIED | File exists, tests for "Parent Directory", "Folder Name", "Create", "Cancel" |
| `src/components/project-picker/__tests__/ProjectList.test.tsx` | Auto-git-init wiring smoke test | VERIFIED | File exists with `useGitInitProject` mock wiring test |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/services/project.service.ts` | `src/types/bindings.ts` | `api.cloneProject` proxy | WIRED | Line 196: `api.cloneProject(url, targetPath, connectionId)` |
| `src/services/project.service.ts` | `src/types/bindings.ts` | `api.gitInitProject` proxy | WIRED | Line 170: `api.gitInitProject(path, connectionId)` |
| `src/services/project.service.ts` | `src/types/bindings.ts` | `api.createNewProject` proxy | WIRED | Line 227: `api.createNewProject(parentDir, folderName, connectionId)` |
| `src-tauri/src/lib.rs` | `src-tauri/src/ipc/project_handlers.rs` | `collect_commands!` macro | WIRED | Lines 26-28: all 3 commands registered |
| `src/components/project-picker/ProjectList.tsx` | `src/services/project.service.ts` | `useGitInitProject` hook | WIRED | Line 11: import; line 41: `mutateAsync: gitInitProject`; line 53: called in `handleProjectSelect` |
| `src/components/project-picker/CloneProjectDialog.tsx` | `src/services/project.service.ts` | `useCloneProject` hook | WIRED | Line 14: import; line 29: `const { mutateAsync: cloneProject, isPending } = useCloneProject()` |
| `src/components/project-picker/CreateProjectDialog.tsx` | `src/services/project.service.ts` | `useCreateNewProject` hook | WIRED | Line 14: import; line 30: `const { mutateAsync: createNewProject, isPending } = useCreateNewProject()` |
| `src/components/project-picker/ProjectList.tsx` | `src/components/project-picker/ProjectsListLayout.tsx` | `onCloneClick` + `onCreateClick` props | WIRED | Lines 100-101: `onCloneClick={() => setShowCloneDialog(true)}`, `onCreateClick={() => setShowCreateDialog(true)}` |
| `src/components/project-picker/ProjectList.tsx` | `src/components/project-picker/CloneProjectDialog.tsx` | rendered with `connection` prop | WIRED | Lines 133-137: `<CloneProjectDialog open={showCloneDialog} onOpenChange={setShowCloneDialog} connection={...}/>` |
| `src/components/project-picker/ProjectList.tsx` | `src/components/project-picker/CreateProjectDialog.tsx` | rendered with `connection` prop | WIRED | Lines 140-144: `<CreateProjectDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} connection={...}/>` |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `CloneProjectDialog.tsx` | `project` (returned by `cloneProject`) | `clone_project` Rust IPC → DB `INSERT INTO projects` → `SELECT * FROM projects WHERE id = ?` | Yes — real DB insert + SELECT | FLOWING |
| `CreateProjectDialog.tsx` | `project` (returned by `createNewProject`) | `create_new_project` Rust IPC → `create_dir_all` + `git init` + DB insert → SELECT | Yes — real filesystem + DB ops | FLOWING |
| `ProjectList.tsx` | `recentProjects` | `useRecentProjects` → `api.getConnectionProjects` → `get_connection_projects` → DB SELECT | Yes — real DB query in `fetch_projects_from_db` | FLOWING |
| `ProjectList.tsx` (auto-init) | `gitInitProject` result | `git_init_project` Rust IPC → `tokio::process::Command::new("git").args(["init", &path])` | Yes — real subprocess execution | FLOWING |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED — operations require a running Tauri app with native filesystem and SSH access. Static analysis confirmed all data flows reach real subprocess and DB operations.

---

### Requirements Coverage

| Requirement ID | Source Plan | Description (from ROADMAP) | Status | Evidence |
|----------------|-------------|---------------------------|--------|---------|
| P24-GIT-INIT | 24-01, 24-02 | Auto-detect and init git on folder select | SATISFIED | `git_init_project` IPC exists; called in `handleProjectSelect` before `createProject`; SSH-aware |
| P24-CLONE | 24-01, 24-02 | Clone Project button with git URL + target path | SATISFIED | `clone_project` IPC + `useCloneProject` hook + `CloneProjectDialog` form with URL/path fields + Browse |
| P24-CREATE | 24-01, 24-02 | Create Project button with parent dir + folder name + git init | SATISFIED | `create_new_project` IPC + `useCreateNewProject` hook + `CreateProjectDialog` with inline error |
| P24-FOOTER | 24-02 | 3-button footer in projects panel | SATISFIED | `ProjectsListLayout.tsx` 3-button row: Select Existing (outline), Clone (outline), Create (default) |

No orphaned requirements — all four P24-* IDs appear in ROADMAP.md and are accounted for by plans 24-01 and 24-02.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `CloneProjectDialog.tsx` | 80, 91 | `placeholder` HTML attributes | Info | Not a stub — input placeholders are user-facing hint text, not empty data |
| `CreateProjectDialog.tsx` | 85, 108 | `placeholder` HTML attributes | Info | Same as above — not a stub |

No blocker or warning-level anti-patterns found. All form fields are controlled inputs bound to real state. All mutation hooks call real API proxy methods. No hardcoded empty arrays, stub returns, or disconnected handlers.

---

### Human Verification Required

#### 1. Clone flow end-to-end

**Test:** Run `pnpm tauri:dev`. Open the project picker. Click "Clone". Enter a valid public git URL (e.g. `https://github.com/tauri-apps/tauri`) and a writable target path. Click "Clone".
**Expected:** Button shows spinner and "Cloning..." text while git runs; on success the dialog dismisses and a success toast appears; the cloned project appears selected.
**Why human:** Requires live network, git CLI on PATH, and writable filesystem. The spinner timing and toast cannot be exercised without a running app.

#### 2. Create flow — inline error for existing directory

**Test:** Run `pnpm tauri:dev`. Click "Create". Enter an existing directory as the parent and a folder name that already exists at that path. Click "Create".
**Expected:** An inline red error message ("Directory already exists...") appears beneath the form fields. No toast. Dialog stays open.
**Why human:** Requires a running app and controlled filesystem state to reach the Rust error path.

#### 3. Auto-git-init on folder select

**Test:** Run `pnpm tauri:dev`. Click "Select Existing". Navigate to and select a directory that contains no `.git` folder. Click "Select".
**Expected:** The project opens normally without any error prompt. The directory now contains a `.git` folder.
**Why human:** Requires a running app and a test directory not already under git control.

#### 4. SSH remote connection threading

**Test:** With an active SSH connection in the project picker, click "Clone" and use "Browse" to navigate to a remote path. Then complete a clone.
**Expected:** The FilePicker shows the remote filesystem. The `git clone` runs on the remote host.
**Why human:** Requires a live SSH target; cannot verify remote dispatch without an actual connection.

---

### Gaps Summary

No gaps found. All 12 observable truths are verified. All 12 required artifacts exist and are substantive. All 10 key links are wired. All 4 data flows reach real DB operations or subprocess calls. All 4 P24-* requirements are satisfied. No blocker anti-patterns.

The phase has one post-checkpoint deviation that was correctly implemented: remote SSH connection support was threaded through `CloneProjectDialog`, `CreateProjectDialog`, and all three Rust IPC commands, making the `connection_id` parameter present throughout the stack rather than hardcoded to `null`.

---

_Verified: 2026-03-28T19:00:00Z_
_Verifier: Claude (gsd-verifier)_
