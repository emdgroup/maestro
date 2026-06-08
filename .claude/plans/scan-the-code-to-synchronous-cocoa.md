# Connection Type Disparity Audit: Local vs SSH vs WSL

## Context

Maestro supports three connection types: **Local**, **SSH (Remote)**, and **WSL**. Each feature that touches the filesystem, runs git commands, or manages sessions must handle all three. This audit found several disparities where WSL or SSH paths are broken or missing.

## Findings

### BUG 1: Patch file path broken for SSH and WSL (HIGH)

**Files:** `src-tauri/src/git/worktree_handlers.rs` (lines 583-602 and 652-668)

**Functions:** `stage_worktree_files` and `discard_worktree_changes`

Both functions write patch content to a **local temp file** (`std::env::temp_dir()`), then pass that local path as an argument to `git apply` via `run_git_in_dir`. For SSH connections, `run_git_in_dir` executes the git command on the remote machine — which cannot access the local temp file. For WSL, the command runs inside `wsl.exe` — which may not be able to resolve a Windows temp path depending on config.

**Fix:** Pipe patch content via stdin instead of temp files. For SSH, use `execute_command` with `echo '<patch>' | git apply --cached`. For WSL, pipe through `wsl.exe` stdin. For local, can keep temp file or also switch to stdin. The cleanest approach: add a `run_git_in_dir_with_stdin` variant to `git/mod.rs` that handles all three connection types, feeding patch data through stdin to `git apply`.

### BUG 2: WSL session_start_sha never resolved (HIGH)

**File:** `src-tauri/src/acp/session_handlers.rs` (lines 112-127)

**Function:** `spawn_acp_session`

The SHA resolution only branches on `connection_id` (SSH) vs else (local). WSL projects have `connection_id = None` but `wsl_connection_id = Some(id)`. They fall into the `else` branch which constructs `GitConnection::Local { path: cwd }` where `cwd` is a Linux path (e.g., `/home/user/project`). On the Windows host, local git cannot resolve this path → `rev-parse HEAD` silently fails (`.ok()`) → `session_start_sha = None` → task's `execution_start_sha` never saved → **rollback capability lost for all WSL sessions**.

**Fix:** Add a third branch: `else if let Some(wsl_id) = wsl_connection_id` that constructs `GitConnection::Wsl { distro, path: cwd }` after looking up the distro name from DB. This routes the SHA resolution through `run_wsl_git` which handles the path correctly.

### BUG 3: Branch names not shell-quoted in `get_remote_diff` (MEDIUM)

**File:** `src-tauri/src/git/remote.rs` (line 69-72)

```rust
let cmd = format!(
    "cd {} && git diff --unified=6 {}...{}",
    shell_quote(remote_path), base_branch, branch  // ← not quoted!
);
```

`remote_path` is quoted but `base_branch` and `branch` are not. Branch names with spaces or special chars could cause command injection or breakage on SSH. Contrast with `create_remote_worktree` which correctly quotes all arguments.

**Fix:** Apply `shell_quote()` to both `base_branch` and `branch`.

### GAP 4: No WSL session restoration (MEDIUM)

**File:** `src-tauri/src/acp/manager.rs` (lines 2183-2234)

`restore_acp_sessions` only handles SSH connections — takes a `connection_id: i32` parameter, uses `resolve_remote_context` (SSH-only), and hardcodes `ConnectionKey::Ssh`. If a WSL connection server crashes, active sessions are lost with no recovery path.

**Fix:** Either generalize `restore_acp_sessions` to accept a `ConnectionKey` and branch for WSL, or add a parallel `restore_wsl_acp_sessions` function. WSL is simpler since there's no SSH reconnection — just re-launch `wsl.exe` transport and reload sessions from `restorable_sessions` keyed by WSL connection ID.

**Caveat:** `restorable_sessions` is currently keyed by `i32` (SSH connection_id). WSL sessions would need either a separate map or a key scheme that distinguishes SSH vs WSL IDs.

### GAP 5: `WslDistroState` always hardcoded to `Stopped` (LOW)

**File:** `src-tauri/src/connectivity/wsl.rs` (line 166)

`parse_distro_list` uses `--quiet` which doesn't report running state, so every distro shows as `Stopped`. The `WslDistroState` enum exists but is never populated correctly.

**Fix:** Use `wsl --list --verbose` instead of `--quiet`, parse the `Running`/`Stopped` state column.

### SMELL 6: Branch deletion bypasses `run_git_in_dir` dispatcher (LOW)

**Files:** `src-tauri/src/git/worktree_handlers.rs` (lines 387-419), `src-tauri/src/git/review_handlers.rs` (lines 439-459)

Both manually match on `GitConnection` variants and run `git branch -d` directly instead of using the centralized `run_git_in_dir`. Works correctly today but duplicates dispatch logic.

**Fix:** Replace inline match with `run_git_in_dir(&git_conn, &project_path, &["branch", "-d", &branch])`.

### SMELL 7: `todo!()` in `spawn_agent_execution` Local arm (LOW)

**File:** `src-tauri/src/execution/process.rs` (line 41)

Dead code path but would panic if reached. Comment says "use ipc::execution_handlers for local" — callers seem to avoid this path, but it's a latent crash.

**Fix:** Replace `todo!()` with a descriptive `Err(...)` matching the WSL arm pattern.

## Implementation Priority

| # | Bug/Gap | Severity | Effort |
|---|---------|----------|--------|
| 1 | Patch file path broken SSH/WSL | HIGH | Medium — need `run_git_in_dir_with_stdin` |
| 2 | WSL session_start_sha | HIGH | Small — add WSL branch in if-else |
| 3 | Unquoted branch names in remote diff | MEDIUM | Trivial — wrap in `shell_quote()` |
| 4 | No WSL session restoration | MEDIUM | Medium — need key scheme change |
| 5 | WslDistroState always Stopped | LOW | Small |
| 6 | Branch deletion dispatch duplication | LOW | Small |
| 7 | `todo!()` panic | LOW | Trivial |

## Verification

After fixes:
1. **Bug 1:** Test `stage_worktree_files` and `discard_worktree_changes` with a patch on SSH project — verify patch applies correctly on remote
2. **Bug 2:** Spawn ACP session on WSL project, check that `execution_start_sha` is saved in tasks table
3. **Bug 3:** Create branch with special chars on SSH project, run diff — verify no breakage
4. **Bug 4-7:** Code review + `cargo check` / `cargo test`
