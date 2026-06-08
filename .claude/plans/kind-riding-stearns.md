# Handle pre-commit hook failures gracefully in approve flow

## Context

When approving a task, `squash_merge_to_main` runs `git commit`. If a pre-commit hook fails (exit 1), the commit is aborted. Currently this propagates as a hard `Err(...)` → raw error toast.

Pre-commit hooks are legitimate quality gates. Fix: surface hook output to user with two options:
- **"Fix issues"** (default) — sends hook output back to agent as rework feedback (same as review rework flow with global comment = hook output)
- **"Force commit (skip hooks)"** (dropdown) — re-calls approve with `skip_hooks: true`

---

## Implementation

### 1. Add `hook_output` to `MergeResult`

**File:** `src-tauri/src/git/review_models.rs`

```rust
pub struct MergeResult {
    pub success: bool,
    pub task_status: String,
    pub conflicts: Vec<String>,
    pub hook_output: Option<String>,
}
```

### 2. Revert `--no-verify`, add `skip_hooks` param, handle commit failure

**File:** `src-tauri/src/git/mod.rs` — `squash_merge_to_main`

```rust
pub async fn squash_merge_to_main(
    conn: &GitConnection,
    task_id: i32,
    branch_name: &str,
    task_name: &str,
    skip_hooks: bool,
) -> Result<MergeResult, String> {
    // ... steps 1-4 unchanged ...

    // Step 5: commit
    let mut commit_args = vec!["commit"];
    if skip_hooks { commit_args.push("--no-verify"); }
    commit_args.extend(["-m", &commit_msg]);

    match run_git_in_dir(conn, repo_path, &commit_args).await {
        Ok(_) => Ok(MergeResult { success: true, task_status: "Done".into(), conflicts: vec![], hook_output: None }),
        Err(e) => {
            // Commit blocked — reset staged merge so worktree isn't left dirty
            let _ = run_git_in_dir_lossy(conn, repo_path, &["reset", "--hard", "HEAD"]).await;
            let _ = run_git_in_dir_lossy(conn, repo_path, &["checkout", branch_name]).await;
            Ok(MergeResult {
                success: false,
                task_status: "Review".into(),
                conflicts: vec![],
                hook_output: Some(e),
            })
        }
    }
}
```

### 3. Add `skip_hooks` to `approve_task_and_merge` IPC

**File:** `src-tauri/src/git/review_handlers.rs`

```rust
pub async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    merge_strategy: String,
    skip_hooks: bool,
) -> Result<MergeResult, String> {
```

Handle `hook_output` case — no state change, just return result:

```rust
if merge_result.success {
    // finalize ...
} else if !merge_result.conflicts.is_empty() {
    // reject on conflict ...
} else if merge_result.hook_output.is_some() {
    Ok(merge_result)
} else {
    Err("Merge failed with unknown error".into())
}
```

### 4. Frontend: `HookFailureDialog` in `ReviewConfirmModals.tsx`

New component with:
- Warning icon + "Pre-commit hook blocked commit" title
- Monospace scrollable hook output
- ButtonGroup: **"Fix issues"** (default) + dropdown **"Force commit (skip hooks)"**

```tsx
interface HookFailureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hookOutput: string;
  onFix: () => void;       // rework flow with hook output as feedback
  onForce: () => void;     // re-approve with skip_hooks=true
}
```

### 5. `TaskReviewPanel.tsx` — wire up hook failure handling

State:
```tsx
const [hookFailure, setHookFailure] = useState<string | null>(null);
```

In `handleApproveConfirm` `onSuccess`:
```tsx
if (result.hook_output) {
  setApproveModalOpen(false);
  setHookFailure(result.hook_output);
} else if (result.success) {
  // existing success path
}
```

"Fix issues" handler — triggers same flow as rework:
```tsx
const handleHookFix = () => {
  const feedbackText = `# Pre-commit hook failed\n\nFix the issues reported by the pre-commit hook:\n\n\`\`\`\n${hookFailure}\n\`\`\``;
  requestChanges(
    { taskId: task.id, generalFeedback: feedbackText, perFileComments: null },
    {
      onSuccess: async () => {
        setHookFailure(null);
        if (activeSession) {
          await api.sendAcpPromptStructured(activeSession.session_key, [{ type: "text", text: feedbackText }]);
        } else {
          execute(task);
        }
        onClose();
      },
    },
  );
};
```

"Force commit" handler:
```tsx
const handleHookForce = () => {
  approveAndMerge(
    { taskId: task.id, mergeStrategy: "CommitAndMerge", skipHooks: true },
    {
      onSuccess: () => { setHookFailure(null); reviewStore.clearTask(task.id); onClose(); },
    },
  );
};
```

### 6. Update mutation + service

**File:** `src/services/task.service.ts` — add `skipHooks` to mutation params:
```tsx
mutationFn: ({ taskId, mergeStrategy, skipHooks = false }) =>
  api.approveTaskAndMerge(taskId, mergeStrategy, skipHooks),
```

### 7. Regenerate bindings

`pnpm tauri:gen` to update `MergeResult` type + `approve_task_and_merge` signature.

---

## Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/git/review_models.rs` | Add `hook_output: Option<String>` to `MergeResult` |
| `src-tauri/src/git/mod.rs` | Add `skip_hooks` param, handle commit failure structurally |
| `src-tauri/src/git/review_handlers.rs` | Add `skip_hooks` param, handle hook_output case |
| `src/components/execution/diff/ReviewConfirmModals.tsx` | Add `HookFailureDialog` |
| `src/components/execution/diff/TaskReviewPanel.tsx` | Hook failure state + fix/force handlers |
| `src/services/task.service.ts` | Pass `skipHooks` in approve mutation |

---

## Verification

1. `cargo check` + `pnpm tauri:gen` + `pnpm build` — clean
2. Project with pre-commit hook: approve → hook fails → dialog shows output → "Fix issues" sends rework to agent
3. "Force commit" → re-calls with skip_hooks=true → succeeds
4. Project without hooks: approve works as before (hook_output = null)
