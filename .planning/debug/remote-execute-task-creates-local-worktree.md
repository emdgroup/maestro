---
status: awaiting_human_verify
trigger: "When manually executing a task from the board view of a remote project, it fails because it tries to create a local git worktree instead of creating it on the remote SSH machine."
created: 2026-03-30T00:00:00Z
updated: 2026-03-30T00:00:00Z
---

## Current Focus

hypothesis: create_worktree_for_task and delete_worktree_for_task in worktree_handlers.rs hardcode GitConnection::Local instead of resolving the project's actual git connection
test: Read the function bodies directly — both functions construct `GitConnection::Local { path: repo_path.to_string() }` unconditionally
expecting: Confirmed — both helpers bypass the SSH-aware dispatch layer entirely
next_action: Rewrite both helpers to query the project and call get_git_connection, then skip local fs create_dir_all for remote projects

## Symptoms

expected: Worktree should be created on the remote machine via SSH, then the agent should run there
actual: The execution attempt creates a worktree directory locally (on the Tauri app host), which fails with a Windows path error
errors: "Failed to start execution: Failed to create worktree directory: The filename, directory name, or volume label syntax is incorrect. (os error 123)"
reproduction: Open a remote project (connected via SSH), go to Kanban board, manually click "Execute" on a task
started: Current behavior; worktree creation IPC handlers were recently made SSH-aware in Phase 31, but the execution flow may not use those handlers

## Eliminated

- hypothesis: The public IPC create_worktree handler is not SSH-aware
  evidence: create_worktree (IPC command) already uses get_git_connection and skips local dir creation for remote projects — it is correct
  timestamp: 2026-03-30T00:00:00Z

## Evidence

- timestamp: 2026-03-30T00:00:00Z
  checked: worktree_handlers.rs lines 385-427 (create_worktree_for_task)
  found: Hard-codes `let git_conn = crate::models::GitConnection::Local { path: repo_path.to_string() };` without querying the project or checking is_remote. Also unconditionally calls `tokio::fs::create_dir_all` locally.
  implication: Any call to this helper (from spawn_agent_execution, resume_agent_execution) will always attempt local fs and local git operations, even for remote projects.

- timestamp: 2026-03-30T00:00:00Z
  checked: worktree_handlers.rs lines 578-597 (delete_worktree_for_task)
  found: Also hard-codes `GitConnection::Local`. Called from run_agent_background_task on cleanup.
  implication: Deletion after execution also runs locally — secondary bug.

- timestamp: 2026-03-30T00:00:00Z
  checked: execution_handlers.rs spawn_agent_execution and resume_agent_execution
  found: Both call super::create_worktree_for_task with repo_path and project_id, but repo_path is first run through canonicalize_repo_path() which calls std::path::Path::canonicalize() — this also fails on Windows for Linux remote paths.
  implication: Two failure points: (1) canonicalize_repo_path on a Linux path from Windows, (2) create_dir_all locally.

- timestamp: 2026-03-30T00:00:00Z
  checked: spawn_interactive_execution (execution_handlers.rs lines 710-827)
  found: Already does this correctly — it queries the project, calls get_git_connection, checks is_remote, and skips local canonicalize/create_dir_all for remote projects.
  implication: The pattern to follow is already present in the same file.

## Resolution

root_cause: `create_worktree_for_task` and `delete_worktree_for_task` in worktree_handlers.rs hardcode `GitConnection::Local` instead of resolving the project's actual connection via `get_git_connection`. Additionally, `spawn_agent_execution` and `resume_agent_execution` call `canonicalize_repo_path` on the repo_path before passing it to the helper, which fails on Windows when the path is a remote Linux path.
fix: (1) Rewrite create_worktree_for_task to accept app_state, query the project, call get_git_connection, and skip local dir creation for remote projects. (2) Rewrite delete_worktree_for_task to do the same for deletion. (3) Skip canonicalize_repo_path in spawn_agent_execution and resume_agent_execution for remote projects (or move canonicalization inside the helper, local-only).
verification: cargo check passes clean; awaiting manual test on remote project
files_changed:
  - src-tauri/src/ipc/worktree_handlers.rs
  - src-tauri/src/ipc/execution_handlers.rs
