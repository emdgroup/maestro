# Fix: Agent session uses main branch instead of worktree

## Context

When executing a task with `isolated_worktree = true`, the agent session sometimes runs in the project root instead of the worktree directory. Two distinct bugs cause this.

## Bug 1: Session pool claims ignore `cwd`

**Location:** `src-tauri/src/ipc/acp_handlers.rs` lines 186–211

Pre-warmed pooled sessions are spawned with the **project root** as `cwd` (during project open in `project_handlers.rs`). The pool is keyed by `(project_id, agent_id)` — no `cwd` component.

When a worktree task claims a pooled session:
1. The agent subprocess is **already running** in the project root — can't change its working directory after spawn
2. `proc.cwd` is never updated to the worktree path
3. Pool replenishment incorrectly uses the worktree `cwd` instead of project root

**Fix:** Skip pool claim when `cwd != project_root`. The pool should only serve tasks without a worktree (where `cwd == projectPath`).

Steps:
1. Store the `cwd` used at warmup time in the pool entry (or compare against known project path)
2. Only claim from pool if the requested `cwd` matches the pooled session's `cwd`
3. Keep pool replenishment using the **project root** (not the worktree path)

**Files to modify:**
- `src-tauri/src/ipc/acp_handlers.rs` — pool claim logic (line ~189), pool replenishment (line ~202)
- `src-tauri/src/acp/manager.rs` — `PooledSession` struct (add `cwd` field if needed)

## Bug 2: Double-prefixed path for existing worktrees

**Location:** `src/utils/hooks/useExecuteTask.ts` line 53

```typescript
cwd = `${projectPath}/${existingWorktree.path}`;
```

`existingWorktree.path` from `listWorktreesWithStatus` is **already absolute** (built as `format!("{}/{}", repo_path, db_row.path)` in `worktree_handlers.rs:140`). Prepending `projectPath` produces a broken double-prefixed path like `/home/user/repo//home/user/repo/.maestro/worktrees/task-42`.

This likely causes the IPC call to fail or fall back to the project root.

**Fix:** Use `existingWorktree.path` directly (it's already absolute).

```typescript
cwd = existingWorktree.path;
```

**File to modify:**
- `src/utils/hooks/useExecuteTask.ts` — line 53

## Implementation Order

1. Fix Bug 2 first (one-line frontend fix, immediately testable)
2. Fix Bug 1 (Rust pool logic, requires understanding pool struct)

## Verification

1. Create a task with `isolated_worktree = true`
2. Execute it — confirm agent spawns in `.maestro/worktrees/task-{id}/` not project root
3. Execute a second worktree task — confirm it doesn't claim a pool session meant for project root
4. Execute a non-worktree task — confirm pool still works for project-root sessions
5. Run `cargo check` and `pnpm build` to verify no type errors
