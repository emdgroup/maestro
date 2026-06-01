# Plan: Git Init Dialog for Non-Git Projects

## Context

When user opens a folder as a project in Maestro, `ProjectList.tsx:57-58` silently calls `gitInitProject()` before creating the project — but only for local connections. SSH/WSL skip it. If git isn't installed or folder has issues, user gets a generic "Failed to open project" error with no explanation.

**Goal:** Replace silent auto-init with explicit user choice via modal dialog.

---

## Implementation

### 1. New backend command: `check_is_git_repo`

**File:** `src-tauri/src/ipc/project_handlers.rs`

Add new IPC command that checks if a path is inside a git work tree. Works for local, SSH, and WSL connections.

```rust
#[tauri::command]
pub async fn check_is_git_repo(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<bool, String> {
    // For local: check Path::new(&path).join(".git").exists()
    //   OR run `git -C <path> rev-parse --is-inside-work-tree`
    // For SSH: run via session.execute_command
    // For WSL: run via wsl.exe -d <distro> -- git -C <path> rev-parse --is-inside-work-tree
    // Return true/false, never error (missing git = false)
}
```

Register in `src-tauri/src/lib.rs` `collect_commands![]`.

### 2. New frontend component: `GitInitDialog`

**File:** `src/components/project-picker/GitInitDialog.tsx` (new)

Simple confirmation dialog:
- Title: "Not a Git Repository"
- Body: "This folder is not a git repository. Git enables worktree isolation, branch management, and code review features. Initialize git in this project?"
- Buttons: **"Initialize Git"** (primary) | **"Continue Without Git"** (secondary/outline)

Props:
```tsx
interface GitInitDialogProps {
  open: boolean;
  path: string;
  onInitGit: () => void;      // user chose to init
  onSkip: () => void;         // user chose to continue without
  onCancel: () => void;       // user closed dialog
  loading?: boolean;
}
```

Use existing `Dialog`/`DialogContent`/`DialogHeader`/`DialogFooter` from `@/ui/dialog` — same pattern as `CreateProjectDialog.tsx`.

### 3. Modify `ProjectList.tsx` — replace silent init with dialog flow

**File:** `src/components/project-picker/ProjectList.tsx`

Current flow (lines 45-79):
```
handleProjectSelect → gitInitProject() → createProject → openProject
```

New flow:
```
handleProjectSelect
  → checkIsGitRepo(path, connectionId)
  → if true: proceed (createProject → openProject)
  → if false: show GitInitDialog
    → "Initialize Git": gitInitProject() → createProject → openProject
    → "Continue Without Git": createProject → openProject (skip git init)
    → Cancel: abort, close file picker
```

Changes:
1. Add state: `const [pendingPath, setPendingPath] = useState<{path, connectionId, wslConnectionId} | null>(null)`
2. Add state: `const [showGitInitDialog, setShowGitInitDialog] = useState(false)`
3. In `handleProjectSelect`: call `checkIsGitRepo` first. If false, stash path and show dialog. If true, proceed directly.
4. Dialog callbacks call the actual project creation logic (extract to helper fn).
5. Remove unconditional `gitInitProject()` call from line 58.

### 4. Add `useCheckIsGitRepo` hook

**File:** `src/services/project.service.ts`

```tsx
export function useCheckIsGitRepo() {
  return useMutation({
    mutationFn: ({ path, connectionId, wslConnectionId }) =>
      api.checkIsGitRepo(path, connectionId ?? null, wslConnectionId ?? null),
  });
}
```

### 5. Store `isGitRepo` flag on project open

**Where:** `projectStore.ts` or return it from `openProject` response.

**Option A (simpler):** Add `is_git_repo: bool` field to the `Project` struct returned by `open_project`. Backend checks at open time, stores in runtime state.

**Option B (no model change):** Frontend calls `checkIsGitRepo` after open and stores result in Zustand.

**Recommendation:** Option A — backend detects at open time, frontend gets it from project data. This also handles re-opening existing projects (from recent list) that may not be git repos.

If Option A: modify `open_project` in `project_handlers.rs` to run git check and include result in response. Add `is_git_repo: bool` to `Project` model (or to a separate `ProjectRuntime` struct returned alongside).

### 6. Handle re-opening existing projects (from recent list)

`handleProjectClick` (line 81) opens already-registered projects. These bypass `handleProjectSelect` entirely — no git init dialog shown. This is correct behavior: project already exists, user already made their choice. The `is_git_repo` flag from `openProject` response handles downstream UI gating.

---

## Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/ipc/project_handlers.rs` | Add `check_is_git_repo` command. Optionally add git check to `open_project`. |
| `src-tauri/src/lib.rs` | Register new command |
| `src/components/project-picker/GitInitDialog.tsx` | **New file** — confirmation dialog |
| `src/components/project-picker/ProjectList.tsx` | Replace silent `gitInitProject` with check + dialog flow |
| `src/services/project.service.ts` | Add `useCheckIsGitRepo` hook |
| `src/types/bindings.ts` | Auto-regenerated via `pnpm tauri:gen` |

Optional (for downstream flag gating — separate phase):
| `src-tauri/src/models/project.rs` | Add `is_git_repo` field |
| `src/store/projectStore.ts` | Store and expose flag |

---

## Verification

1. Open Maestro dev (`pnpm tauri:dev`)
2. Select a folder **without** `.git` → dialog appears with two choices
3. Click "Initialize Git" → `.git` created, project opens with full features
4. Repeat with new non-git folder, click "Continue Without Git" → project opens (git-dependent features will degrade, but that's a separate phase)
5. Select a folder **with** `.git` → no dialog, opens directly (same as current behavior)
6. Test SSH connection path — dialog should also appear for remote non-git folders
7. Re-open existing project from recent list — no dialog, goes straight to open

---

## Out of Scope (future phases)

- UI gating of git-dependent features when `is_git_repo = false` (the 15 locations from earlier analysis)
- "Initialize Git" button in WorktreesView empty state
- Making branch field optional in task creation
- Execution fallback (PTY spawn without worktree)
