# Phase 31: Fix remote SSH worktree bugs: git ops, origin branch detection, and worktree path filtering - Research

**Researched:** 2026-03-30
**Domain:** Rust backend SSH/git integration, worktree IPC layer
**Confidence:** HIGH (all findings are from direct source code inspection)

## Summary

Phase 31 targets three distinct Rust backend bugs that only manifest when a project is connected via SSH (remote project). All three bugs are code-inspection-confirmed: the root causes are concretely identified in specific file/line locations. No exploratory research is needed — this is a pure bug-fix phase.

**Bug 1 — SSH session key mismatch:** `get_git_connection()` in `db/connection.rs` looks up the SSH session using `project.id` but SSH sessions are keyed by `connection_id`. For any remote project, this always returns `None`, causing the fallback `unwrap_or_else` in `list_project_branches` to silently use a local `GitConnection` instead of SSH. Every single remote git operation that routes through `get_git_connection` is broken.

**Bug 2 — Remote `create_worktree` ignores `new_branch_name`:** `remote::create_remote_worktree` in `git/remote.rs` executes `cd {path} && git worktree add {worktree_name} {branch}` — it never includes `-b {new_branch}` even when `new_branch` is `Some`. The local path also has `tokio::fs::create_dir_all` called on a remote path, which fails silently on remote projects.

**Bug 3 — `list_worktrees_with_status` filters on absolute-path equality with a local-style string:** The main worktree filter at line 28 does `wt.path != repo_path`. For SSH projects, `repo_path` is the remote POSIX path (e.g. `/home/user/project`) and `wt.path` from `git worktree list --porcelain` is an absolute path on the remote machine — but this IPC is only being called today with a local path, so this code path isn't exercised yet. Additionally, the DB path lookup at line 79 uses `format!("{}/{}", repo_path, row.path)` which constructs absolute paths using a locally-interpolated prefix that won't match the remote absolute paths returned by `git worktree list`.

**Primary recommendation:** Fix the three bugs in `db/connection.rs`, `git/remote.rs`, and `ipc/worktree_handlers.rs`. All fixes are surgical — no architecture changes, no new IPC commands.

## Bug Analysis (HIGH confidence — code inspection)

### Bug 1: Wrong key in `get_git_connection`

**File:** `src-tauri/src/db/connection.rs` line 100

```rust
// BROKEN: uses project.id (e.g., 3) as the SSH session key
let ssh_session = app_state.get_ssh_session(project.id).await
    .ok_or("SSH session not initialized for remote project")?;
```

SSH sessions are stored in `AppState.ssh_sessions: HashMap<i32, RemoteSshSession>` keyed by `connection_id` — the `ssh_connections.id` foreign key. `project.connection_id` is the correct key. Because `list_project_branches` calls `get_git_connection` and silently falls back on error:

```rust
let git_conn = crate::db::get_git_connection(&project, &app_state).await
    .unwrap_or_else(|_| crate::models::GitConnection::Local { path: project.path.clone() });
```

...remote projects silently get a local `GitConnection` with the remote path string. `get_current_branch` then tries `git rev-parse --abbrev-ref HEAD` with `.current_dir("/remote/path")` which either fails (returns `"main"` default) or runs git in the wrong local directory.

**Fix:** Change `project.id` to `project.connection_id.unwrap_or(project.id)` — or preferably, require `connection_id` from the `Project` since `is_remote()` already guarantees it's `Some`.

### Bug 2: `create_remote_worktree` ignores `new_branch_name`

**File:** `src-tauri/src/git/remote.rs` lines 6-19

```rust
pub async fn create_remote_worktree(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    branch: &str,
    worktree_name: &str,   // ← new_branch_name is NOT a parameter
) -> Result<(), SshError> {
    let cmd = format!(
        "cd {} && git worktree add {} {}",
        remote_path, worktree_name, branch
    );
    ssh.execute_command(&cmd).await?;
    Ok(())
}
```

The public dispatcher in `git/mod.rs` calls this:

```rust
GitConnection::Remote { ssh, remote_path } => {
    remote::create_remote_worktree(ssh, remote_path, branch, worktree_name)
        .await
        // new_branch: Option<&str>  ← silently dropped, never forwarded
```

When the caller passes `new_branch = Some("task-5")`, that branch name is never used in the SSH command. The worktree is created with the wrong branch or the command fails because the named branch doesn't exist.

Additionally, `create_worktree` in `worktree_handlers.rs` (line 320) calls `tokio::fs::create_dir_all` with a local path derived from `repo_path` before any git operation. For SSH projects, `repo_path` is a remote POSIX path — calling `tokio::fs::create_dir_all` on it tries to create the directory on the **local** machine.

**Fix:**
1. Add `new_branch: Option<&str>` parameter to `create_remote_worktree`.
2. Build the correct command: with `new_branch` → `git worktree add {name} -b {new_branch} {branch}`; without → `git worktree add {name} {branch}`.
3. In `create_worktree` (worktree_handlers.rs), gate `tokio::fs::create_dir_all` on `git_conn.is_local()` — or for SSH projects, run `mkdir -p` via SSH instead.

### Bug 3: Path filtering in `list_worktrees_with_status`

**File:** `src-tauri/src/ipc/worktree_handlers.rs`

Three sub-issues:

**3a — Main worktree filter (line 28):** Uses string equality `wt.path != repo_path` to exclude the main worktree. This works locally because `git worktree list --porcelain` returns the same canonical absolute path. For SSH projects, `list_worktrees_with_status` calls `crate::git::list_worktrees_local(&repo_path)` (line 23) — a hardcoded local function, not the `git::list_worktrees` dispatcher. SSH projects have no remote counterpart implemented. The filter condition itself is fine for local but the function never dispatches to SSH.

**3b — DB path lookup (line 79):** `format!("{}/{}", repo_path, row.path)` constructs an absolute path used to match against paths returned by `git worktree list --porcelain`. Locally, `row.path` is relative (e.g. `.maestro/worktrees/task-5`) and `repo_path` is absolute — the concat works. For SSH projects this path would need to be constructed remotely.

**3c — No remote `list_worktrees`:** `git/mod.rs` has no `list_worktrees` dispatcher function. `list_worktrees_local` is public but called directly by handlers. The `remote` module has no `list_remote_worktrees` function. This means `list_worktrees_with_status` cannot work for SSH projects as-is.

**Current impact:** `list_worktrees_with_status` is only called with `repo_path` from the frontend, which is `currentProject.path`. For SSH projects, this is the remote path string. `current_dir(repo_path)` on a remote path will fail because the directory doesn't exist locally — git will exit non-zero and the call returns an error.

**Fix scope for phase 31:** Either (a) add SSH branch to `list_worktrees_with_status` via a remote `git worktree list --porcelain` command via SSH, or (b) scope the fix to be "return empty list gracefully for SSH projects until full remote worktree support is added". Option (a) is the complete fix; option (b) avoids a crash but defers functionality.

## Architecture Patterns

### Existing SSH Dispatch Pattern (How Git Ops Should Work)

All git operations in `git/mod.rs` follow this pattern — it should be extended consistently:

```rust
pub async fn some_git_op(conn: &GitConnection, ...) -> Result<T, String> {
    match conn {
        GitConnection::Local { path } => local_impl(path, ...).await,
        GitConnection::Remote { ssh, remote_path } => {
            remote::remote_impl(ssh, remote_path, ...)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}
```

`list_worktrees` does NOT have this dispatch — it's missing entirely from `git/mod.rs`.

### How SSH Sessions Are Keyed

```
AppState.ssh_sessions: HashMap<i32, RemoteSshSession>
                               ^
                               connection_id (== ssh_connections.id)

Project { id: 3, connection_id: Some(1), ... }
                               ^
                               This is what should be used as the key
```

The `get_git_connection` function must look up by `project.connection_id.unwrap()`, not `project.id`.

### Remote Command Execution Pattern

```rust
// Via RemoteSshSession::execute_command
let cmd = format!("cd {} && git worktree add {} -b {} {}", remote_path, wt_name, new_branch, origin);
ssh.execute_command(&cmd).await
```

Paths with spaces should be quoted. Existing code in `project_handlers.rs` uses `replace('"', "\\\"")` for safety but the remote git commands in `remote.rs` don't do this. Phase 31 should add shell quoting to remote commands.

### Local-only Operations That Must Be Gated

```rust
// tokio::fs::create_dir_all — LOCAL ONLY
// canonicalize() — LOCAL ONLY (git/worktree_handlers.rs lines 363-365)
// git2::Repository::open — LOCAL ONLY (get_worktree_diff)
```

For SSH projects:
- `create_dir_all` → `mkdir -p` via SSH
- `canonicalize` → not applicable for remote paths (skip or use as-is)
- `git2::Repository::open` → not applicable; `get_worktree_diff` has no remote path

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Shell quoting for SSH commands | Custom escaping logic | `shlex`-style wrapping with `'` quotes | Consistent with how `list_remote_directories` escapes single-quotes already |
| SSH command builder | New abstraction | Extend existing `remote.rs` functions | Pattern is already established; just add parameters |
| Remote worktree listing | New protocol | SSH `git worktree list --porcelain` via `execute_command` | Same approach as all other remote git ops |

## Common Pitfalls

### Pitfall 1: `get_current_branch` for Remote Returns Hardcoded "main"

**What goes wrong:** `git/mod.rs` line 122-124:
```rust
GitConnection::Remote { .. } => {
    // Remote current branch detection not implemented; default to main
    Ok("main".to_string())
}
```
Even after fixing `get_git_connection`, `get_current_branch` will return `"main"` for all SSH projects. This is the "origin branch detection" bug from the phase title.

**How to avoid:** Implement `remote::get_remote_current_branch(ssh, remote_path)` that runs `cd {path} && git rev-parse --abbrev-ref HEAD` via SSH.

### Pitfall 2: `list_remote_branches` Returns Raw Lines Including Asterisk

**File:** `git/remote.rs` lines 76-86:
```rust
pub async fn list_remote_branches(ssh, remote_path) -> Result<Vec<String>, SshError> {
    let cmd = format!("cd {} && git branch -a", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    Ok(output.lines().map(|s| s.trim().to_string()).collect())
}
```

The local implementation (`list_branches_local`) strips the `*` asterisk from the current branch and strips `remotes/origin/` prefixes and deduplicates. The remote implementation does none of this — it returns raw `git branch -a` output including lines like `* main` and `  remotes/origin/main`. When used to populate a dropdown, this produces duplicates and an asterisk-prefixed entry.

**How to avoid:** Apply the same normalization to remote branch output that `list_branches_local` applies.

### Pitfall 3: `canonicalize()` Will Fail for SSH Paths

**File:** `ipc/worktree_handlers.rs` lines 362-365, `ipc/execution_handlers.rs` line 65-69:
```rust
let repo_path_canon = std::path::Path::new(repo_path)
    .canonicalize()
    .map_err(|e| format!("Invalid repository path '{}': {}", repo_path, e))?;
```
For SSH projects, `repo_path` is a remote POSIX path like `/home/user/project`. `canonicalize()` resolves symlinks on the **local** machine — it will fail with "No such file or directory" for paths that only exist on the remote server.

`create_worktree_for_task` is called from `spawn_agent_execution` and `resume_agent_execution`, both of which also canonicalize. These execution handlers only work for local projects today (PTY sessions are local), but the canonicalize guard will also fail if these are ever used with SSH projects.

**How to avoid:** Gate `canonicalize()` on `connection_id.is_none()`. For SSH projects, trust the path as-is.

### Pitfall 4: `get_worktree_diff` Uses git2 (Local Disk Only)

**File:** `ipc/worktree_handlers.rs` lines 237-282.

`get_worktree_diff` uses `git2::Repository::open(&worktree_abs_clone)` which requires the worktree to exist on the local filesystem. For SSH projects this will fail with "Failed to open repo". This is a separate issue from the three being fixed in this phase — it is not in scope but should be noted.

### Pitfall 5: `list_worktrees_with_status` Calls `list_worktrees_local` Unconditionally

The IPC handler at line 23 calls `crate::git::list_worktrees_local(&repo_path)` — not a dispatcher. For SSH projects, this tries to run `git worktree list --porcelain` with `.current_dir("/remote/path")` which fails because that directory doesn't exist locally. The error propagates as an Err return from the IPC command, which the frontend displays as an error.

## Code Examples

### Correct `get_git_connection` lookup

```rust
// src-tauri/src/db/connection.rs
pub async fn get_git_connection(project: &Project, app_state: &AppState) -> Result<GitConnection, String> {
    if project.is_remote() {
        let conn_id = project.connection_id
            .ok_or("Remote project has no connection_id")?;
        let ssh_session = app_state.get_ssh_session(conn_id).await   // ← FIX: conn_id not project.id
            .ok_or("SSH session not initialized for remote project")?;
        Ok(GitConnection::Remote {
            ssh: Arc::new(ssh_session),
            remote_path: project.path.clone(),
        })
    } else {
        Ok(GitConnection::Local { path: project.path.clone() })
    }
}
```

### Correct `create_remote_worktree` with `new_branch` support

```rust
// src-tauri/src/git/remote.rs
pub async fn create_remote_worktree(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    branch: &str,
    worktree_name: &str,
    new_branch: Option<&str>,   // ← ADD this parameter
) -> Result<(), SshError> {
    let cmd = match new_branch {
        Some(nb) => format!(
            "cd '{}' && git worktree add '{}' -b '{}' '{}'",
            remote_path, worktree_name, nb, branch
        ),
        None => format!(
            "cd '{}' && git worktree add '{}' '{}'",
            remote_path, worktree_name, branch
        ),
    };
    ssh.execute_command(&cmd).await?;
    Ok(())
}
```

### Remote `get_current_branch` implementation

```rust
// src-tauri/src/git/remote.rs
pub async fn get_remote_current_branch(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<String, SshError> {
    let cmd = format!("cd '{}' && git rev-parse --abbrev-ref HEAD", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    let branch = output.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        Ok("main".to_string())
    } else {
        Ok(branch)
    }
}
```

### Remote `list_worktrees` with normalization

```rust
// src-tauri/src/git/remote.rs
pub async fn list_remote_worktrees(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<Vec<crate::git::ParsedWorktree>, SshError> {
    let cmd = format!("cd '{}' && git worktree list --porcelain", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    Ok(crate::git::parse_worktree_list_pub(&output))  // reuse local parser
}
```

### Normalizing remote `list_branches` output

The remote implementation should apply the same logic as the local one:

```rust
let branches: Vec<String> = output.lines()
    .map(|line| {
        let trimmed = line.trim_start_matches(|c: char| c == ' ' || c == '*').trim();
        trimmed.strip_prefix("remotes/origin/").unwrap_or(trimmed).to_string()
    })
    .filter(|b| !b.is_empty() && !b.contains("HEAD ->") && !b.contains("HEAD"))
    .collect::<std::collections::BTreeSet<_>>()  // dedup via set
    .into_iter()
    .collect()
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `project.id` as SSH session key | Must be `project.connection_id` | Phase 31 | Fixes all SSH git ops via `get_git_connection` |
| `create_remote_worktree` ignores `new_branch` | Add `new_branch: Option<&str>` param | Phase 31 | Fixes worktree creation on SSH projects |
| `get_current_branch` hardcodes "main" for remote | Implement SSH `git rev-parse` | Phase 31 | Fixes origin branch detection dropdown |
| `list_worktrees_local` called unconditionally | Add SSH dispatch | Phase 31 | Fixes worktree listing for SSH projects |

## Open Questions

1. **Is `get_worktree_diff` in scope for phase 31?**
   - What we know: Uses `git2::Repository::open` which requires local disk access; will fail for SSH projects
   - What's unclear: Whether diff viewing for SSH projects is a P1 fix for this phase or deferred
   - Recommendation: Out of scope for phase 31 unless explicitly added; the phase title doesn't mention diff

2. **Are `spawn_agent_execution` / `resume_agent_execution` expected to work for SSH projects?**
   - What we know: Both use local PTY sessions; both call `canonicalize()` which fails for remote paths
   - What's unclear: Whether agent execution on SSH machines is in scope for v1.4
   - Recommendation: Leave as-is; `canonicalize` fix only needed if SSH execution is in scope

3. **Should `list_worktrees_with_status` be fully implemented for SSH or return empty gracefully?**
   - What we know: Calling it on an SSH project currently errors; a full implementation requires remote `git worktree list`
   - Recommendation: Implement fully (add `git::list_worktrees` dispatcher + `remote::list_remote_worktrees`); it's a small delta once the dispatcher pattern is extended

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — this is a pure Rust backend code fix phase)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend) + cargo test (backend) |
| Config file | `vite.config.ts` (frontend), `Cargo.toml` (backend) |
| Quick run command | `cd /home/m306213/workspace/maestro && cargo check` |
| Full suite command | `pnpm build && cargo test` |

### Phase Requirements → Test Map
| ID | Behavior | Test Type | Automated Command | File Exists? |
|----|----------|-----------|-------------------|-------------|
| Bug 1 | `get_git_connection` uses correct SSH session key | unit | `cargo test` | ❌ Wave 0 |
| Bug 2 | `create_remote_worktree` passes `new_branch` to git | unit | `cargo test` | ❌ Wave 0 |
| Bug 3 | Remote branch list normalized (no asterisk, deduped) | unit | `cargo test` | ❌ Wave 0 |
| Bug 4 | `get_current_branch` returns real branch for SSH | unit | `cargo test` | ❌ Wave 0 |

**Note:** The SSH bugs require a live SSH connection to test end-to-end. Unit tests can verify the command strings being constructed (mock `execute_command`) and the normalization logic. End-to-end validation requires manual testing with an SSH-connected project.

### Wave 0 Gaps
- Unit tests for `create_remote_worktree` command string construction (verify `-b new_branch` is present)
- Unit tests for `list_remote_branches` normalization (strip `*`, strip `remotes/origin/`, deduplicate)
- Unit tests for `get_remote_current_branch` output parsing

*(Existing `cargo test` infrastructure is present; specific test functions are missing)*

## Sources

### Primary (HIGH confidence)
- `src-tauri/src/db/connection.rs` — `get_git_connection` implementation, SSH session lookup
- `src-tauri/src/git/mod.rs` — dispatch pattern, `get_current_branch` remote stub
- `src-tauri/src/git/remote.rs` — all remote git implementations, missing `new_branch` parameter
- `src-tauri/src/ipc/worktree_handlers.rs` — `list_worktrees_with_status` local-only call, path construction
- `src-tauri/src/ipc/task_handlers.rs` — `list_project_branches` using `get_git_connection`
- `src-tauri/src/models/connection.rs` — `GitConnection` enum definition

### Secondary (MEDIUM confidence)
- `src-tauri/src/ssh/session.rs` — `RemoteSshSession` type used as map value
- `src-tauri/src/ipc/project_handlers.rs` — correct pattern: `get_ssh_session(conn_id)` where `conn_id` comes from request param
- `src-tauri/src/ipc/execution_handlers.rs` — `canonicalize()` calls that break for SSH paths

## Metadata

**Confidence breakdown:**
- Bug identification: HIGH — direct source code inspection, bugs confirmed by reading specific line numbers
- Fix approach: HIGH — follows existing patterns already in the codebase (`project_handlers.rs` uses correct `conn_id` pattern; `git/mod.rs` dispatcher pattern is established)
- Scope completeness: MEDIUM — there may be additional SSH-specific issues not triggered in current testing (e.g. `get_worktree_diff` via git2)

**Research date:** 2026-03-30
**Valid until:** N/A — findings are code-inspection facts, not ecosystem research
