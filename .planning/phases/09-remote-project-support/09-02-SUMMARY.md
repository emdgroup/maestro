---
phase: 09-remote-project-support
plan: 02
subsystem: Remote Git Operations
tags: [git-operations, remote-execution, ssh-integration, dispatcher-pattern, transparent-routing]

completed: 2026-02-08
duration: "20 minutes"

dependencies:
  requires: [Plan 09-01 SSH Connection Infrastructure]
  provides: [Remote-aware git operations dispatcher, seamless local/remote routing]
  affects: [09-03 Remote Process Execution, 09-04 Remote Terminal Streaming]

tech-stack:
  added: []
  patterns:
    - Dispatcher pattern (local vs remote routing without caller knowledge)
    - Transparent execution (single git module serves both local and remote)
    - Remote command execution via SSH (git commands over ssh2 channels)

file-tracking:
  key-files:
    created:
      - src-tauri/src/models/connection.rs (GitConnection enum, 41 lines)
      - src-tauri/src/git/mod.rs (Dispatcher module, 145 lines)
      - src-tauri/src/git/remote.rs (Remote git operations, 81 lines)
    modified:
      - src-tauri/src/models/mod.rs (export GitConnection)
      - src-tauri/src/db/connection.rs (added get_git_connection helper)
      - src-tauri/src/db/mod.rs (export get_git_connection)
      - src-tauri/src/ipc/handlers.rs (updated get_diff_for_review to use dispatcher)
      - src-tauri/src/lib.rs (export git module and GitConnection)

---

# Phase 9 Plan 2: Remote Git Operations Summary

**One-liner:** Created dispatcher pattern for transparent local/remote git operations routing, enabling seamless SSH-executed git commands while keeping business logic unchanged.

## What Was Built

### 1. GitConnection Enum and Dispatcher Foundation

**Created src-tauri/src/models/connection.rs:**
- `GitConnection` enum with two variants:
  - `Local { path: String }` - Direct local filesystem access
  - `Remote { ssh: Arc<RemoteSshSession>, remote_path: String }` - SSH-tunneled operations
- Helper methods:
  - `is_remote()` - Type check for routing logic
  - `path()` - Get project path (works for both local and remote)
  - `ssh_session()` - Extract SSH session for remote operations

**Helper function get_git_connection():**
- Added to db/connection.rs for easy construction of GitConnection from Project
- For local projects: creates GitConnection::Local with project.path
- For remote projects: retrieves SSH session from AppState, creates GitConnection::Remote
- Returns Result with appropriate error messages for connection failures

### 2. Remote Git Operations Module

**Created src-tauri/src/git/remote.rs (5 functions):**

All functions follow pattern: `command && execute_over_SSH`

1. **create_remote_worktree()**
   - Executes: `cd {remote_path} && git worktree add {worktree_name} {branch}`
   - Creates new working tree on remote machine

2. **delete_remote_worktree()**
   - Executes in sequence:
     - `cd {remote_path} && git worktree remove {worktree_name} --force`
     - `git -C {remote_path} branch -D {worktree_name}`
     - `git -C {remote_path} remote prune origin`
   - Non-fatal failures on branch delete/prune (best-effort cleanup)

3. **get_remote_diff()**
   - Executes: `cd {remote_path} && git diff --unified=6 {base_branch}...{branch}`
   - Returns unified diff with 6 context lines

4. **get_remote_status()**
   - Executes: `cd {remote_path} && git status --short`
   - Returns git status output

5. **list_remote_branches()**
   - Executes: `cd {remote_path} && git branch -a`
   - Parses and returns Vec<String> of branch names

### 3. Git Operations Dispatcher

**Created src-tauri/src/git/mod.rs (dispatcher module):**

Implements 5 public dispatcher functions that route to local OR remote:

1. **create_worktree()** - Route to local stub OR remote::create_remote_worktree()
2. **delete_worktree()** - Route to local stub OR remote::delete_remote_worktree()
3. **git_diff()** - Route to local stub OR remote::get_remote_diff()
4. **git_status()** - Route to local stub OR remote::get_remote_status()
5. **list_branches()** - Route to local stub OR remote::list_remote_branches()

**Dispatcher pattern benefits:**
- Callers pass GitConnection, don't care about routing
- Match on GitConnection enum determines execution path
- Local implementations stubbed (waiting for Phase 3-01 sidecar integration)
- Remote implementations call SSH module functions
- Error handling: SshError mapped to String for IPC compatibility

### 4. IPC Handler Integration

**Updated src-tauri/src/ipc/handlers.rs:**

**get_diff_for_review() handler - Now supports both local and remote projects:**

For local projects:
- Continues existing behavior: calls Node.js sidecar
- Maintains Phase 3-01 integration point

For remote projects:
- Constructs GitConnection via get_git_connection()
- Calls git::git_diff() dispatcher
- Dispatcher transparently executes git diff over SSH
- Returns same format to UI (transparent to DiffViewer component)

**Key insight:** Handler signature unchanged - all routing is internal. UI code doesn't know or care about local vs remote.

### 5. Type Exports and Integrations

**Updated module exports:**
- `src-tauri/src/lib.rs`: Exported git module and GitConnection type
- `src-tauri/src/db/mod.rs`: Exported get_git_connection helper
- `src-tauri/src/models/mod.rs`: Exported GitConnection to models

## Implementation Decisions

1. **Dispatcher pattern for transparent routing** - Callers don't change; implementation routing handles both local and remote
2. **Single code path for git operations** - git/mod.rs is single entry point for all git operations
3. **Remote operations via SSH** - All git commands execute on remote machine, not locally
4. **Error mapping** - SshError converted to String for IPC compatibility (maintains handler signatures)
5. **Local implementations stubbed** - Waiting for Phase 3-01 sidecar integration; remote is fully functional now
6. **No path translation** - Local and remote git paths stored/used as-is; dispatcher doesn't translate between systems

## Verification Checklist

All success criteria met:

✓ GitConnection enum created with Local and Remote variants
✓ is_remote(), path(), ssh_session() helper methods implemented
✓ get_git_connection() helper constructs GitConnection from Project + AppState
✓ Remote git operations module created (src-tauri/src/git/remote.rs)
✓ create_remote_worktree: git worktree add via SSH
✓ delete_remote_worktree: removes worktree, deletes branch, prunes refs via SSH
✓ get_remote_diff: git diff --unified=6 over SSH
✓ get_remote_status: git status --short over SSH
✓ list_remote_branches: lists branches from remote machine
✓ Dispatcher pattern in git/mod.rs routes to local OR remote transparently
✓ All public git functions accept GitConnection parameter
✓ IPC handlers updated to use dispatcher (no signature changes)
✓ Error handling maps SshError to String for IPC returns
✓ Dispatcher is transparent—handlers don't change logic
✓ DiffViewer component uses get_diff_for_review handler (unchanged)
✓ get_diff_for_review internally uses git_diff dispatcher for remote projects
✓ No UI component has local/remote branching logic
✓ Cargo build succeeds with no errors

## Output Structure

```
src-tauri/src/models/connection.rs (41 lines)
  ├─ GitConnection enum: Local | Remote
  └─ Methods: is_remote(), path(), ssh_session()

src-tauri/src/git/mod.rs (145 lines)
  ├─ Dispatcher functions: create_worktree, delete_worktree, git_diff, git_status, list_branches
  └─ Local stubs for Phase 3-01 integration

src-tauri/src/git/remote.rs (81 lines)
  ├─ create_remote_worktree() - git worktree add via SSH
  ├─ delete_remote_worktree() - git worktree remove + branch cleanup
  ├─ get_remote_diff() - git diff over SSH
  ├─ get_remote_status() - git status over SSH
  └─ list_remote_branches() - git branch listing

Updated handlers:
  ├─ get_diff_for_review() - Now routes local→sidecar, remote→SSH dispatcher
  └─ All handlers import git module and GitConnection type
```

## Dispatcher Flow Diagram

```
UI Component (DiffViewer)
         ↓
invoke("get_diff_for_review", task_id)
         ↓
IPC Handler: get_diff_for_review()
         ↓
Get Project from DB
         ↓
project.is_remote?
    ├─ YES: get_git_connection() → GitConnection::Remote
    │        ↓
    │        git::git_diff() dispatcher
    │        ↓
    │        match GitConnection::Remote
    │        ↓
    │        git::remote::get_remote_diff()
    │        ↓
    │        ssh.execute_command("git diff")
    │        ↓
    │        Return diff string
    │
    └─ NO: Project path local
           ↓
           git::git_diff() dispatcher
           ↓
           match GitConnection::Local
           ↓
           (Calls local stub for now)
           ↓
           Fallback: Node.js sidecar call (current)
           ↓
           Return diff string
         ↓
Parse and display diff in UI
```

## Deviations from Plan

None - plan executed exactly as specified. All success criteria met.

## Next Steps

**Plan 09-03: Remote Process Execution**
- Route spawn_agent_cli through SSH for remote command execution
- Remote terminal PTY management using ssh2 channels
- Process lifecycle management on remote host
- Return process exit codes and output via SSH

**Plan 09-04: Remote Terminal Streaming**
- Direct PTY over SSH (spawn PTY on remote, stream through SSH connection)
- Real-time terminal I/O handling through RemoteSshSession
- Terminal resize and signal handling (Ctrl+C) over SSH

## Integration Notes

- **Local projects remain unchanged:** Existing sidecar-based workflows continue to work
- **Remote projects now functional:** Can execute git diff over SSH
- **Transparent to UI:** DiffViewer component works unchanged with both local and remote
- **Future integration:** When Phase 3-01 sidecar integration completes, local stubs will be replaced with actual sidecar calls
- **Error handling:** All SSH errors properly mapped to String for IPC compatibility

---

**Build Status:** ✓ Compiles without errors (0 errors, pre-existing warnings only)
**Type Safety:** ✓ Full Rust type checking with dispatcher pattern
**Integration:** ✓ Ready for Phase 09-03 (Process Execution)
**Testing Ready:** ✓ Foundation complete for remote git operation testing
