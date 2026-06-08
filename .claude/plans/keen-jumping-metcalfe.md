# Fix 3 Skipped Code Review Issues

## Context

Code review of last 25 commits identified 8 bugs, 5 were fixed. Three were skipped as requiring more than a one-line fix. This plan addresses all three: remote template reads, commit-only strategy, and WSL git-repo detection.

---

## Fix 1: `resolve_commit_message` — Read template from Remote/WSL

**File:** `src-tauri/src/git/review_handlers.rs` (lines 192-240)

**Problem:** Uses `std::fs::read_to_string` which only works locally. Remote/WSL projects silently fall back to default template.

**Changes:**

1. Extend SQL query (line 199) to also select `p.connection_id, p.wsl_connection_id`
2. Destructure two new `Option<i32>` fields from query result
3. Build `ConnectionKey::from_ids(connection_id, wsl_connection_id)`
4. Replace `std::fs::read_to_string` block (lines 217-221) with match on `ConnectionKey`:
   - `Local` → `std::fs::read_to_string` (current behavior)
   - `Ssh { id }` → `app_state.ssh.get_session(id).await` then `session.execute_command(&format!("cat {}", shell_quote(&template_path)))`
   - `Wsl { id }` → query distro from DB, run `wsl.exe -d <distro> -- cat <path>`
   - All error paths → fall back to `DEFAULT_COMMIT_TEMPLATE`

**Pattern to follow:** `get_project_settings` in `src-tauri/src/project/handlers.rs:846-879` (identical dispatch logic for `.maestro/settings.json`)

**Imports:** `use crate::acp::ConnectionKey;` and `use crate::git::remote::shell_quote;`

---

## Fix 2: `commit-only` Merge Strategy

**File:** `src-tauri/src/git/review_handlers.rs` (lines 253-338)

**Problem:** `let _ = merge_strategy;` at line 260 discards the user's selection. Always squash-merges and deletes worktree regardless.

**Changes:**

1. Remove `let _ = merge_strategy;` (line 260)
2. After the untracked-files commit block (after line 307), insert early return for CommitOnly:

```rust
if merge_strategy == "CommitOnly" {
    app_state.app_handle.emit("tasks-changed", ()).ok();
    return Ok(MergeResult {
        success: true,
        task_status: "Review".to_string(),
        conflicts: vec![],
    });
}
```

3. Rest of function (squash merge + finalize) runs only for "CommitAndMerge" — no changes needed there.

**Semantics:** CommitOnly = stage+commit untracked on feature branch, skip merge/delete, task stays in Review. User can continue working or later approve with CommitAndMerge.

---

## Fix 3: `is_task_project_git_repo` — Proper WSL/SSH Check

**File:** `src-tauri/src/acp/manager.rs` (lines 861-890)

**Problem:** For SSH/WSL projects, blindly returns `true` without checking. WSL paths like `/home/user/project` can't be checked with `Path::exists()` from Windows host.

**Changes:**

1. Make `is_task_project_git_repo` async, change signature:
   ```rust
   async fn is_task_project_git_repo(app_state: &crate::core::AppState, task_id: i32) -> bool
   ```

2. Add `p.id` to SQL query to get project_id

3. For local projects (both connection IDs are None): keep `Path::new(&path).join(".git").exists()`

4. For SSH/WSL projects: call `get_project_with_git_conn(app_state, project_id)` then `run_git_in_dir(&git_conn, &path, &["rev-parse", "--is-inside-work-tree"])`. Return `true` if output trims to "true", else `false`.

5. Make `try_complete_task` async:
   ```rust
   async fn try_complete_task(app_state: &crate::core::AppState, task_id: i32) -> bool
   ```
   Move the git-repo check BEFORE locking DB (avoid holding lock across await).

6. Update 5 call sites to add `.await`:
   - Line 817, 852, 1437, 1548, 1802

All call sites already inside `async move` blocks or `async fn`.

**Imports:** `use crate::core::get_project_with_git_conn;` and `use crate::git::run_git_in_dir;`

---

## Verification

1. `cargo check` (workspace root) — compilation clean
2. `pnpm build` — TypeScript still compiles (no frontend changes here)
3. Manual scenarios:
   - CommitOnly: select "Commit only" in review modal → worktree survives, task stays in Review
   - CommitAndMerge: existing behavior unchanged
   - Remote template: SSH project with custom `.maestro/commit-template.txt` → template resolved correctly
   - Remote no-template: SSH project without template → default template used (no error)
