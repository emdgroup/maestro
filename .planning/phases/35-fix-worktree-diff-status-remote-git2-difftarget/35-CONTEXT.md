# Phase 35: Fix worktree diff and status for remote projects — remove git2, add DiffTarget

**Gathered:** 2026-03-31
**Status:** Ready for planning
**Source:** User brainstorm session

<domain>
## Phase Boundary

This phase fixes two broken/degraded git operations for SSH remote projects, removes git2 as a dependency from worktree diff, and adds a user-selectable DiffTarget to control what get_worktree_diff compares against. No schema changes, no DB migrations.

**In scope:**
- `git/mod.rs` — add `run_git_in_dir` dispatcher (local + remote)
- `git/remote.rs` — add generic `run_git_in_remote_dir` helper
- `ipc/worktree_handlers.rs` — fix `get_worktree_diff` (remote dispatch + DiffTarget param), fix `list_worktrees_with_status` (remote git status + diff-stat)
- `models/` — add `DiffTarget` enum with `#[derive(TS)]`
- Frontend WorktreesView / DiffViewer — add diff target toggle + branch picker
- Run `pnpm tauri:gen` to regenerate TypeScript bindings

**Out of scope:**
- Schema changes
- SSH session management changes
- Any other worktree IPC handlers (create, delete, cleanup)

</domain>

<decisions>
## Implementation Decisions

### Remove git2 from get_worktree_diff
- Replace the git2 `Repository::open()` + in-process diff with a subprocess git call
- Use `git diff --unified=6 {args}` via the new `run_git_in_dir` dispatcher
- git2 should be completely removed from this code path (may still be needed elsewhere — check before removing from Cargo.toml)

### Unified run_git_in_dir dispatcher
- Add `pub async fn run_git_in_dir(conn: &GitConnection, abs_path: &str, args: &[&str]) -> Result<String, String>` to `git/mod.rs`
- Local: `TokioCommand::new("git").args(args).current_dir(abs_path)`
- Remote: SSH execute `cd '{abs_path}' && git {args joined with spaces}`
- Shell-safe: use `remote::shell_quote(abs_path)` for the cd path in remote; args are NOT shell-quoted individually — construct the command string carefully
- This single function handles both status and diff calls for worktrees

### DiffTarget enum
- Add to `models/` (appropriate existing file, or new `diff.rs`)
- Must have `#[derive(Deserialize, Serialize, TS)]` and `#[ts(export)]`
- Use `#[serde(tag = "type", content = "branch")]` for clean JSON serialization:
  ```rust
  pub enum DiffTarget {
      Head,           // git diff HEAD  (uncommitted changes vs last commit)
      Branch(String), // git diff --unified=6 origin/{branch}..HEAD
  }
  ```
- Run `pnpm tauri:gen` after adding

### get_worktree_diff IPC changes
- Add `diff_target: DiffTarget` parameter
- Load project + build `GitConnection` (same pattern as `list_worktrees_with_status` lines 23-33)
- Construct `worktree_abs_path = format!("{}/{}", repo_path, wt_path)` for local; for remote the abs path on the remote machine is the same string (remote_path + "/" + wt_path)
- Dispatch via `run_git_in_dir`:
  - `DiffTarget::Head` → args `["diff", "HEAD"]`
  - `DiffTarget::Branch(b)` → args `["diff", "--unified=6", &format!("origin/{}..HEAD", b)]`

### list_worktrees_with_status remote fix
- Replace `if !is_remote { ... }` block (lines 106-137) with a `match &git_conn` block
- Both local and remote branches use `tokio::spawn` parallelism
- For remote: spawn one task per worktree, each running two `run_git_in_dir` calls:
  - `git status --porcelain` → status string
  - `git diff --shortstat` → diff_stat string
- `Arc<RemoteSshSession>` is cloneable — clone it per task
- `wt.path` from `ParsedWorktree` is already the absolute path on the remote machine — pass directly as `abs_path`

### Frontend DiffTarget selector
- Add a two-way toggle to the WorktreesView diff panel (wherever DiffViewer is rendered for worktrees):
  - "Uncommitted" → `{ type: "Head" }`
  - "Branch diff" → `{ type: "Branch", branch: selectedBranch }`
- For "Branch diff": show a branch name input (text input or dropdown populated from available branches)
- Pre-populate the branch input with the worktree's `branch_name` value as a reasonable default (the base branch the worktree was created from)
- Wire to `get_worktree_diff` IPC call with the selected `DiffTarget`

### Claude's Discretion
- Whether to add a separate `run_git_in_remote_dir` to `remote.rs` or inline in the dispatcher
- Exact UI layout of the diff target toggle (tabs vs radio vs segmented control)
- Whether to parallelize remote status calls with `FuturesUnordered` or simple `join!`
- Whether git2 can be removed from Cargo.toml after this change (check other usages first)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Current implementation (read before modifying)
- `src-tauri/src/ipc/worktree_handlers.rs` — current get_worktree_diff (line 225) and list_worktrees_with_status (lines 13-217)
- `src-tauri/src/git/mod.rs` — existing dispatcher pattern and local implementations
- `src-tauri/src/git/remote.rs` — existing SSH helpers (shell_quote, create/delete/list/status/diff functions)

### Pattern references
- `src-tauri/src/ipc/review_handlers.rs` — how to load project + build GitConnection in an IPC handler (the established pattern)
- `src-tauri/src/models/` — where to add DiffTarget enum

### Frontend references
- `src/views/WorktreesView.tsx` — where worktree diff is triggered from
- `src/components/` — DiffViewer component location

### Build tooling
- Run `pnpm tauri:gen` after adding `DiffTarget` to regenerate `src/types/bindings.ts`
- `CLAUDE.md` — project conventions and build commands

</canonical_refs>

<specifics>
## Specific Ideas

### run_git_in_dir local implementation sketch
```rust
GitConnection::Local { .. } => {
    let out = TokioCommand::new("git")
        .args(args)
        .current_dir(abs_path)
        .output()
        .await
        .map_err(|e| format!("git failed: {}", e))?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
```

### run_git_in_dir remote implementation sketch
```rust
GitConnection::Remote { ssh, remote_path: _ } => {
    // abs_path is already the full path on remote machine
    let git_args = args.join(" ");
    let cmd = format!("cd {} && git {}", remote::shell_quote(abs_path), git_args);
    ssh.execute_command(&cmd).await
        .map_err(|e| format!("Remote git error: {:?}", e))
}
```

### DiffTarget JSON shapes
- `{ "type": "Head" }` — diff vs HEAD
- `{ "type": "Branch", "branch": "dev" }` — diff vs origin/dev..HEAD

### list_worktrees remote parallelism sketch
```rust
GitConnection::Remote { ssh, .. } => {
    let handles: Vec<_> = disk_worktrees.iter().map(|wt| {
        let wt_path = wt.path.clone();
        let conn = git_conn.clone(); // GitConnection must be Clone
        tokio::spawn(async move {
            let status = run_git_in_dir(&conn, &wt_path, &["status", "--porcelain"])
                .await.unwrap_or_default();
            let diff_stat = run_git_in_dir(&conn, &wt_path, &["diff", "--shortstat"])
                .await.unwrap_or_default();
            let diff_stat = if diff_stat.trim().is_empty() { None } else { Some(diff_stat.trim().to_string()) };
            (wt_path, status, diff_stat)
        })
    }).collect();
    // collect as before
}
```

Note: `GitConnection` may need `#[derive(Clone)]` if not already present.

</specifics>

<deferred>
## Deferred Ideas

- Remove git2 from Cargo.toml entirely — only after confirming no other usages remain
- Caching of remote git status to reduce SSH round-trips on frequent list_worktrees calls
- Diff against arbitrary commits (not just HEAD or origin branch)

</deferred>

---

*Phase: 35-fix-worktree-diff-status-remote-git2-difftarget*
*Context gathered: 2026-03-31 via brainstorm session*
