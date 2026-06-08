# Customizable commit message template for squash merge

## Context

Users with commit message enforcement tools (YACC, commitlint, etc.) need control over the merge commit message format. Currently the message is hardcoded in Rust. We add:
1. A `.maestro/commit-template.txt` file created at project registration
2. Backend resolves template variables and returns preview
3. Approve modal shows editable textarea pre-filled with resolved message
4. Final message sent to backend for the actual commit

Previous work (already done): `squash_merge_to_main` renamed to `squash_merge_to_base`, now accepts `target_branch` param from `t.base_branch`.

## Template

**File**: `.maestro/commit-template.txt`

**Default content**:
```
Merge task #{task_id}: {task_name}

Squash merge {branch} into {target_branch}.
```

**Available variables**:
- `{task_id}` — task ID
- `{task_name}` — task title
- `{branch}` — worktree branch name
- `{target_branch}` — base branch (merge target)
- `{external_id}` — Jira/Linear/GitHub ticket ID (empty string if none)
- `{description}` — task description (first line only, empty if none)

**Resolution**: simple string `.replace()` for each variable. No conditional logic needed now.

## Changes

### 1. Template file creation — `src-tauri/src/core/project_storage.rs`

Add `ensure_commit_template_exists(project_path: &str)` function:
- Path: `<project_path>/.maestro/commit-template.txt`
- Only writes if file doesn't exist (don't overwrite user edits)
- Contains the default template

Call it from `register_project_in_db()` in `src-tauri/src/project/handlers.rs` — right after `create_project_maestro_folder()` for Local and WSL projects. Also call in `open_project()` so existing projects get the file on next open.

### 2. New IPC: `resolve_commit_message` — `src-tauri/src/git/review_handlers.rs`

```rust
#[tauri::command]
pub async fn resolve_commit_message(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String>
```

Steps:
1. Query task (title, base_branch, external_id, description) + worktree (branch_name) + project (path)
2. Read `.maestro/commit-template.txt` from project path (fallback to hardcoded default if missing)
3. Replace all `{variable}` placeholders
4. Return resolved string

### 3. Update `approve_task_and_merge` — `src-tauri/src/git/review_handlers.rs`

Add `commit_message: String` parameter. Pass it to `squash_merge_to_base` instead of generating inside.

### 4. Update `squash_merge_to_base` — `src-tauri/src/git/mod.rs`

Replace internal `format!()` commit message with a `commit_message: &str` parameter. Caller provides it.

```rust
pub async fn squash_merge_to_base(
    conn: &GitConnection,
    branch_name: &str,
    target_branch: &str,
    commit_message: &str,
) -> Result<MergeResult, String>
```

Remove `task_id` and `task_name` params (no longer needed — message comes pre-built).

### 5. Frontend: service hook — `src/services/task.service.ts`

Add `useResolveCommitMessageQuery(taskId)` — calls new IPC. Enabled only when approve modal opens.

### 6. Frontend: ApproveModal — `src/components/execution/diff/ReviewConfirmModals.tsx`

- Add `commitMessage: string` prop (pre-filled from resolved template)
- Add `<textarea>` for editing commit message
- Include `commitMessage` in `onConfirm` data: `{ mergeStrategy, includeUntracked, commitMessage }`

### 7. Frontend: TaskReviewPanel — `src/components/execution/diff/TaskReviewPanel.tsx`

- Call `useResolveCommitMessageQuery(task.id)` when approve modal opens
- Pass resolved message to ApproveModal
- Thread `commitMessage` from `handleApproveConfirm` through to `approveAndMerge` mutation

### 8. Register new command — `src-tauri/src/lib.rs`

Add `resolve_commit_message` to `collect_commands![]`.

## Files to modify

- `src-tauri/src/core/project_storage.rs` — `ensure_commit_template_exists()`
- `src-tauri/src/project/handlers.rs` — call it at registration + open
- `src-tauri/src/git/review_handlers.rs` — new `resolve_commit_message` IPC + add `commit_message` param to `approve_task_and_merge`
- `src-tauri/src/git/mod.rs` — simplify `squash_merge_to_base` signature (accept message, drop task_id/task_name)
- `src-tauri/src/lib.rs` — register new command
- `src/services/task.service.ts` — new query hook
- `src/components/execution/diff/ReviewConfirmModals.tsx` — textarea in ApproveModal
- `src/components/execution/diff/TaskReviewPanel.tsx` — wire up resolved message + pass through

## Verification

1. `cargo check` — compilation
2. `cargo test` — no regressions
3. `pnpm build` — frontend compiles
4. Manual: open project → verify `.maestro/commit-template.txt` exists with default content
5. Manual: approve task → verify textarea shows resolved message → edit → confirm → check git log shows edited message
6. Manual: edit template file → approve another task → verify new format used
