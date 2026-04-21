---
status: investigating
trigger: "Recent changes broke creating an agent session when executing a task from the tasks board"
created: 2026-04-10T00:00:00Z
updated: 2026-04-10T01:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — three distinct bugs found in the TaskCard.handleExecute flow. The core issue is that the task board's "Execute" button was never designed to *create* a new worktree; it only looks for an *existing* one. Now that the spawn dialog flow uses worktree_id, the task board path has three specific problems.
test: Full code trace complete
expecting: Fix plan below
next_action: Document fix plan

## Symptoms

expected: Clicking "Execute" on a task (status=Ready) in the Kanban board should:
  1. Create a new git worktree with a new branch named {taskId}-{taskName} based on the task's selected base branch (origin_branch)
  2. Spawn an agent session using the task name as the session_name
actual: Unknown failure mode at runtime — need to trace which of the three bugs fires first
errors: Unknown error message
reproduction: Click Execute on a Ready task in the Kanban board
started: After commits 05310aa/32c910b/38935df replaced branch selector with worktree selector and added worktree_id

## Eliminated

- hypothesis: The Rust spawn_interactive_execution signature changed in a way that breaks the call
  evidence: The Rust handler still accepts (project_id, branch_name, repo_path, session_name, worktree_id) — the call signature is compatible. The call in TaskCard (line 99) passes the right argument count.
  timestamp: 2026-04-10T01:00:00Z

## Evidence

- timestamp: 2026-04-10T01:00:00Z
  checked: TaskCard.tsx handleExecute (lines 88–106)
  found: |
    The execute button at line 99 calls:
      api.spawnInteractiveExecution(projectId, branchName, projectPath, task.name, null)
    where branchName is resolved as:
      worktree?.branch_name ?? task.origin_branch
    It first fetches all worktrees, finds one where task_id === task.id, and uses its branch_name.
    If none found, falls back to task.origin_branch.
    If neither exists, shows toast error and returns early.
  implication: The code does NOT create a new worktree or a new branch. It only uses an existing worktree or the raw origin_branch string.

- timestamp: 2026-04-10T01:00:00Z
  checked: spawn_interactive_execution Rust handler (lines 830–880)
  found: |
    When worktree_id=null AND no existing git worktree is found for the branch_name:
      - It creates a worktree at path .maestro/worktrees/{branch_name}
      - It calls git::create_worktree(conn, branch_name, relative_path, None)
      - None means "checkout existing branch", NOT "create new branch"
      - The DB insert uses task_id = NULL (not linked to the task)
  implication: |
    Even if the task flow reaches spawn_interactive_execution with branch_name = task.origin_branch,
    the handler would try to checkout that existing branch (e.g. "main") as-is,
    not create a new branch named "{taskId}-{taskName}".

- timestamp: 2026-04-10T01:00:00Z
  checked: create_worktree Rust IPC handler signature
  found: |
    create_worktree(project_id, task_id, origin_branch, new_branch_name, repo_path)
    When task_id is provided, worktree path is: .maestro/worktrees/task-{id}
    When new_branch_name is provided, git creates new branch from origin_branch.
    This IS the correct handler for the task board flow.
  implication: The task board should call create_worktree first (to create branch + worktree linked to task), then call spawn_interactive_execution with the resulting worktree_id.

- timestamp: 2026-04-10T01:00:00Z
  checked: worktree_path_for_task in models/worktree.rs
  found: |
    pub fn worktree_path_for_task(task_id: i32) -> String {
        format!(".maestro/worktrees/task-{}", task_id)
    }
    The actual branch naming convention for task worktrees is a relative FS path, not
    the branch name. The branch name is set by new_branch_name parameter.
  implication: The description says the branch should be named "{taskId}-{taskName}" — this needs to be constructed on the frontend and passed as new_branch_name to create_worktree.

- timestamp: 2026-04-10T01:00:00Z
  checked: Task model origin_branch field
  found: |
    Task.origin_branch: Option<String> — the base branch the task should branch from.
    This is the field the user sets in the task form (BacklogTaskSheet/TaskForm originBranch field).
    It's the "base" branch from which the new task branch will be created.
  implication: origin_branch is available on the task object in TaskCard.

- timestamp: 2026-04-10T01:00:00Z
  checked: bindings.ts spawnInteractiveExecution signature
  found: |
    async spawnInteractiveExecution(projectId, branchName, repoPath, sessionName, worktreeId)
    Still accepts branchName even with worktreeId. When worktree_id is provided, the
    handler skips git worktree list and goes straight to DB lookup for the path.
  implication: If we call create_worktree first, we get back a Worktree with {id, branch_name}.
    We can then call spawnInteractiveExecution with worktree.id and worktree.branch_name.

## Resolution

root_cause: |
  THREE bugs in the task board execute flow:

  BUG 1 — No worktree/branch creation:
  TaskCard.handleExecute only looks for an EXISTING worktree (worktrees.find(w => w.task_id === task.id)).
  If none exists (which is the common case for a Ready task that hasn't been executed yet),
  it falls back to task.origin_branch. This means it tries to spawn a session on the base branch
  itself (e.g. "main"), not on a new task branch. The intended flow is to CREATE a new worktree
  + branch named "{taskId}-{taskName}" from origin_branch first.

  BUG 2 — spawn_interactive_execution creates wrong-path worktree with wrong task linkage:
  When spawn_interactive_execution's branch-name fallback path creates a worktree (lines 854–878),
  it places it at .maestro/worktrees/{branch_name} (not .maestro/worktrees/task-{id}) and inserts
  it with task_id = NULL. So even if the backend "recovers", the worktree is not linked to the task.

  BUG 3 — No new branch is created:
  spawn_interactive_execution calls git::create_worktree(conn, branch_name, path, None).
  None means "checkout existing branch". So origin_branch (e.g. "main") would be checked out
  directly, not used as a base for a new branch.

fix: |
  TWO parts: (A) rename origin_branch → base_branch everywhere, then (B) fix TaskCard.handleExecute.

  PART A — Rename origin_branch → base_branch (Task model and all related code)
  The Worktree model already uses base_branch; "origin" is ambiguous with the git remote "origin".
  Files to change:

  1. src-tauri/src/db/schema.rs
     - Rename column `origin_branch TEXT` → `base_branch TEXT` in the tasks CREATE TABLE

  2. src-tauri/src/models/task.rs
     - Field: `pub origin_branch: Option<String>` → `pub base_branch: Option<String>`
     - Update SQL column reference in from_row (row.get index for this field)
     - Update SQL SELECT list string to use base_branch
     - Comment on line 8 referencing origin_branch(7)

  3. src-tauri/src/ipc/task_handlers.rs
     - Param: `origin_branch: Option<String>` → `base_branch: Option<String>`
     - SQL fragment: `"origin_branch = ?"` → `"base_branch = ?"`

  4. src-tauri/src/ipc/worktree_handlers.rs
     - Param: `origin_branch: String` → `base_branch: String`
     - All references to `origin_branch` local var → `base_branch`

  5. Run `pnpm tauri:gen` to regenerate src/types/bindings.ts

  6. src/services/task.service.ts
     - `updates.origin_branch` → `updates.base_branch`
     - IPC param name: `originBranch` → `baseBranch`

  7. src/services/worktree.service.ts
     - JSDoc comment + param: `originBranch` → `baseBranch`

  8. src/components/kanban/TaskCard.tsx
     - `task.origin_branch` → `task.base_branch`

  9. src/components/kanban/BacklogTaskSheet.tsx
     - `originBranch: task.origin_branch` → `baseBranch: task.base_branch`
     - `origin_branch: data.origin_branch` → `base_branch: data.base_branch`

  10. src/components/task/TaskDetail.tsx
      - `task.origin_branch` → `task.base_branch` (display and condition)

  11. src/components/task/TaskForm.tsx
      - Field name: `originBranch` → `baseBranch` throughout
      - Label text: "Origin Branch (Optional)" → "Base Branch (Optional)"

  12. src/views/WorktreesView.tsx
      - State var: `originBranch` → `baseBranch`
      - Label: "Origin branch" → "Base branch"
      - id attr: "origin-branch" → "base-branch"

  PART B — Fix TaskCard.handleExecute (src/components/kanban/TaskCard.tsx)
  The frontend needs to:

  1. Check if a worktree for this task already exists.
     - If yes: reuse it (existing behavior is fine for resume).
  2. If no worktree exists:
     a. Verify task.base_branch is set; if not, show error.
     b. Construct new branch name: `${task.id}-${slugify(task.name)}`
        (slug: lowercase, spaces→hyphens, strip non-alphanumeric/hyphen chars, max ~50 chars)
     c. Call api.createWorktree(projectId, task.id, task.base_branch, newBranchName, projectPath)
        This creates the git branch + worktree at .maestro/worktrees/task-{id}, linked to the task.
     d. Use the returned worktree.id and worktree.branch_name for the spawn call.
  3. Call api.spawnInteractiveExecution with worktree.id (not null) so the Rust handler
     uses the fast DB-lookup path instead of re-scanning git worktrees.

  Note: The session name (task.name) is already correct in the existing code.
  Note: The navigate({agentId}) call was removed in commit 89a6d82 ("remove auto-navigation after spawning agent session"). That removal is intentional per commit message.

verification:
files_changed:
  - src-tauri/src/db/schema.rs
  - src-tauri/src/models/task.rs
  - src-tauri/src/ipc/task_handlers.rs
  - src-tauri/src/ipc/worktree_handlers.rs
  - src/types/bindings.ts (auto-generated via pnpm tauri:gen)
  - src/services/task.service.ts
  - src/services/worktree.service.ts
  - src/components/kanban/TaskCard.tsx
  - src/components/kanban/BacklogTaskSheet.tsx
  - src/components/task/TaskDetail.tsx
  - src/components/task/TaskForm.tsx
  - src/views/WorktreesView.tsx
