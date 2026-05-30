# Non-Git Project Support — Discussion Plan

## Context

Users opening a non-git folder hit a wall: preflight blocks them, worktrees useless, interactive execution requires worktree. But ACP session spawning (core agent workflow) has **no hard git requirement** — maestro-server, ACP protocol, and session spawn are all git-agnostic.

## Recommendation: Flag-based approach

Don't force git init. Detect `is_git_repo` at project open, gate git features behind it.

---

## COMPLETE INVENTORY: Every Location Needing the Flag

### Backend Changes (Rust)

#### 1. Preflight — `src-tauri/src/ipc/acp_handlers.rs:781-789`
**Current:** Hardcodes `mandatory_tools = ["git"]`
**Change:** Make git non-mandatory (warning only) when `is_git_repo = false`

#### 2. Project creation — `src-tauri/src/ipc/project_handlers.rs`
**Current:** `git_init_project` (line 318), `create_new_project` (line 480) both run `git init -b main`
**Change:** Make `git_init_project` a user-opt-in action, not auto-called. `create_new_project` should skip git init if user declines.

#### 3. Worktree handlers — `src-tauri/src/ipc/worktree_handlers.rs` (ALL commands)
**Current:** Every command calls `crate::git::*` — hard-errors without git
**Commands affected:**
- `list_worktrees_with_status` (line 14) — returns Err
- `get_worktree_diff` (line 203) — returns Err
- `create_worktree` (line 244) — returns Err
- `create_worktree_for_task` (line 303) — returns Err
- `delete_worktree` (line 363) — soft-fail (discards error)
- `cleanup_zombie_worktrees` (line 429) — returns Err
- `stage_worktree_files` (line 558) — returns Err
- `commit_worktree` (line 604) — returns Err
- `discard_worktree_changes` (line 623) — returns Err
- `shelve_worktree_changes` (line 675) — returns Err
- `delete_untracked_files` (line 700) — returns Err
- `get_untracked_file_content` (line 722) — returns Err
- `delete_worktree_for_task` (line 739) — soft-fail
**Change:** No code changes needed here. These just won't be called when UI gates them. Frontend handles the flag.

#### 4. Execution handlers — `src-tauri/src/ipc/execution_handlers.rs:585-771`
**Current:** `spawn_interactive_execution` calls `list_worktrees` (line 628) and `create_worktree` (line 647) when `worktree_id` is `None`
**Change:** Add a fallback path: if no git, spawn PTY directly in `project.path` (skip worktree creation entirely). OR: disable interactive execution for non-git projects in frontend.

#### 5. Review handlers — `src-tauri/src/ipc/review_handlers.rs`
**Commands affected:**
- `get_diff_for_review` (line 49) — JOINs `worktrees` table, calls `git_diff`. Hard-error.
- `approve_task_and_merge` (line 177) — calls `squash_merge_to_main`. Hard-error.
- `finalize_successful_merge` (line 239) — calls `delete_worktree`. Partial soft-fail.
**Change:** No backend changes needed — frontend gates Review button/flow behind git flag.

#### 6. Task handlers — `src-tauri/src/ipc/task_handlers.rs:433-462`
**Current:** `list_project_branches` calls `list_branches` + `get_current_branch`. Already graceful — returns `([], "main")` on failure.
**Change:** None needed. Already handles missing git.

#### 7. App.tsx zombie cleanup — fires `cleanupZombieWorktrees` on every project open
**Current:** Silent error if git missing (mutation has no error handler)
**Change:** Skip call when `is_git_repo = false` (frontend gate)

---

### Frontend Changes

#### 8. Project creation — `src/components/project-picker/ProjectList.tsx:58`
**Current:** Unconditionally calls `gitInitProject({ path, connectionId: null })` for local connections before `createProject`
**Change:** Remove unconditional call. Either skip entirely or show prompt: "Initialize git repository? (enables worktree isolation)"

#### 9. PreflightModal — `src/components/project-picker/PreflightModal.tsx:44`
**Current:** `hasMandatoryFail = failedTools.some((t) => t.mandatory)` — blocks user
**Change:** With backend change (#1), git won't be mandatory anymore. Shows as warning instead. User can proceed with "Ignore".

#### 10. CreateTaskModal — `src/components/kanban/CreateTaskModal.tsx:342-420`
**Current:** Branch picker is a **required field**. Uses `useProjectBranchesQuery`. Empty dropdown + validation fail without git.
**Change:** Make branch field optional (or hidden) when `is_git_repo = false`. Task can be created without base_branch.

#### 11. TaskForm — `src/components/task/TaskForm.tsx:155-164`
**Current:** "Base branch" select is required field. Uses `useProjectBranchesQuery`.
**Change:** Same as #10 — hide or make optional when no git.

#### 12. WorktreesView — `src/views/WorktreesView.tsx`
**Current:** Renders empty state "No worktrees yet" + "New Worktree" button
**Change:** When `is_git_repo = false`, show different empty state: "Git repository required for worktree isolation" + "Initialize Git" button. Hide "New Worktree" button.

#### 13. CreateWorktreeDialog — `src/components/execution/CreateWorktreeDialog.tsx`
**Current:** Fetches branches via `useProjectBranchesQuery`, shows branch picker
**Change:** Don't need to change — just won't be openable when button is hidden (#12)

#### 14. SpawnSessionDialog — `src/components/execution/SpawnSessionDialog.tsx:239-283`
**Current:** Shows worktree picker (GitBranch icon + Select by branch_name). Empty list = can't select = can't spawn.
**Change:** When `is_git_repo = false`, hide worktree picker entirely. Spawn ACP session directly in project root (already works — `branch_name` is Optional).

#### 15. AgentsView "Open Terminal" — `src/views/AgentsView.tsx:236-248`
**Current:** `onOpenTerminal` finds worktree by branch_name, spawns interactive execution. No-ops if no worktree found.
**Change:** When `is_git_repo = false`, either disable "Open Terminal" button or spawn PTY directly in project root (requires backend change #4).

#### 16. KanbanView worktree badges — `src/views/KanbanView.tsx:26-29`
**Current:** `useWorktreesQuery` builds `worktreeTaskIds` for green dot badges on TaskCards
**Change:** No change needed. Returns empty set → badges don't show. Already graceful.

#### 17. TaskDetailScreen — `src/components/task/TaskDetailScreen.tsx:684-688, 746-767`
**Current:** Shows `task.base_branch ?? "None"` and "Isolated/Shared worktree" toggle
**Change:** When `is_git_repo = false`, hide both fields (or show base_branch as "None" read-only, hide toggle).

#### 18. ReviewModal — `src/components/common/ReviewModal.tsx`
**Current:** Fetches diff via `useDiffForReviewQuery(taskId)`. Errors without git.
**Change:** When `is_git_repo = false`, hide the "Review" action on task cards entirely. Or show "Review requires git" message.

#### 19. ApprovalForm — `src/components/common/ApprovalForm.tsx`
**Current:** "Commit + Merge", "Commit + Push", "Commit Only" radio buttons
**Change:** Won't be reachable if ReviewModal is gated (#18). No change needed.

#### 20. WorktreeDiffPanel — `src/components/execution/WorktreeDiffPanel.tsx`
**Current:** Full diff viewer with stage/commit/discard/shelve
**Change:** Won't be reachable without worktrees. No change needed.

#### 21. ReviewChangesPanel — `src/components/execution/activity/ReviewChangesPanel.tsx`
**Current:** Inline diff in AgentMonitor. Uses `useWorktreeDiffQuery` with `session_start_sha`
**Change:** When `is_git_repo = false`, hide this panel or show "No diff available (no git)".

#### 22. useExecuteTask hook — `src/utils/hooks/useExecuteTask.ts:45-67`
**Current:** If `task.isolated_worktree = true`, creates worktree before spawning session
**Change:** When `is_git_repo = false`, skip worktree creation, spawn directly in project root. Ignore `isolated_worktree` flag.

#### 23. App.tsx — `src/App.tsx:131-133`
**Current:** Calls `cleanupZombieWorktrees` on project open
**Change:** Skip when `is_git_repo = false`

---

### Where the Flag Lives

**Detection:** On project open, run `git rev-parse --is-inside-work-tree` in project path. Store result as `is_git_repo: bool` in frontend state (e.g., `projectStore` or `configStore`).

**Backend:** Add a lightweight IPC command `check_is_git_repo(projectId) -> bool` or include it in project load response.

**Frontend consumption:** Expose via store hook like `useIsGitRepo()`. Components check this before rendering git-dependent UI.

**Re-detection:** Re-check when user clicks "Initialize Git" button or returns to project from settings.

---

## Summary: Scope of Work

| Category | Count | Effort |
|---|---|---|
| Backend Rust changes | 2-3 files (preflight, execution fallback, new check command) | Low |
| Frontend conditional UI | ~10 components need `is_git_repo` check | Medium |
| Frontend removal | 1 file (forced git init in ProjectList) | Trivial |
| No changes needed (already graceful) | ~6 locations | — |
| No changes needed (gated by parent) | ~5 locations | — |

**Total: ~15 locations need the flag check.** Most are simple conditional renders (hide element or show alternative empty state). The only non-trivial logic change is the execution fallback path (#4 + #22) for spawning sessions without worktree isolation.

---

## My Three Questions (Explicit)

1. **Interactive execution fallback:** When user has no git, and they click "Open Terminal" on an agent session — should we spawn a PTY shell directly in the project root folder (no isolation, agent works on live files)? Or should we just disable that button entirely for non-git projects?

2. **Project creation flow:** When user selects a non-git folder to open as a project — should we show a one-time prompt "Initialize git? (recommended)" with Yes/No? Or just silently open it without git, and let them discover the "Initialize Git" button later in the Worktrees tab?

3. **Task creation without branch:** Currently branch is required to create a task. For non-git projects, should tasks simply have no branch (nullable), or should we still require some label/name for organizational purposes?
