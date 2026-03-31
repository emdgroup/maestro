---
status: awaiting_human_verify
trigger: "Cannot create a new agent session. Two distinct failures depending on branch selection."
created: 2026-03-30T00:00:00Z
updated: 2026-03-30T00:00:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: "Bug 1 fix revised: use git worktree list (authoritative) to find where the selected branch is currently checked out. If found in any worktree entry (including main repo), use that path directly. Only create a new worktree if git confirms the branch is not checked out anywhere. Bug 2 fix: strip '+' from git branch -a output (already applied and confirmed)."
test: "cargo check passes. Logic covers 3 cases: main-repo branch, existing-worktree branch, unchecked-out branch."
expecting: "Human to verify: selecting master opens session in repo root; selecting an existing-worktree branch opens in that worktree; selecting an unchecked-out branch creates a new worktree."
next_action: "Await human verification"

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Creating a new agent session should work regardless of whether the selected branch is the current checkout branch ("master") or a branch from an existing worktree ("test-branch")
actual:
  1. When selecting "master" (current branch): error says it cannot check out "master" - but this should be handled gracefully or not error at all
  2. When selecting a branch from an existing worktree ("test-branch"): "Failed to spawn interactive session: Error: Remote git error: CommandExecutionError { exit_code: 128, stderr: 'fatal: invalid reference: + test-branch\n' }"
errors:
  - Error 1: Cannot check out "master" (exact message unknown, likely a git worktree error)
  - Error 2: "Failed to spawn interactive session: Error: Remote git error: CommandExecutionError { exit_code: 128, stderr: 'fatal: invalid reference: + test-branch\n' }"
reproduction:
  1. Open Agents view in Maestro app
  2. Try to create new agent session with "master" branch selected
  3. Try to create new agent session with a branch that already has a worktree checked out (e.g. "test-branch")
timeline: Recent - related to SSH/worktree work in phases 29-31

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-03-30T00:05:00Z
  checked: "git branch -a output in the working repo"
  found: "Output is: '* master', '+ sunny-ravens-lick-1774299629570', '+ test-branch'. The '+' prefix marks branches checked out in OTHER worktrees."
  implication: "list_branches_local uses trim_start_matches(|c: char| c == ' ' || c == '*') which does NOT strip '+'. These branches are returned verbatim as '+ test-branch'."

- timestamp: 2026-03-30T00:06:00Z
  checked: "git/mod.rs list_branches_local line 310"
  found: "trim_start_matches only strips ' ' and '*'. Same pattern in remote.rs list_remote_branches."
  implication: "Any branch checked out in a worktree gets a malformed name with leading '+ '. When passed to git worktree add as the branch argument, git rejects it as invalid reference."

- timestamp: 2026-03-30T00:07:00Z
  checked: "spawn_interactive_execution in execution_handlers.rs"
  found: "When no existing worktree for branch: calls create_worktree(&git_conn, &branch_name, &relative_path, None). If branch_name is '+ test-branch', git worktree add gets a bad refspec."
  implication: "Error 2 is fully explained. Error 1 (master) is separate: master is the currently checked-out branch, and git worktree add of an already-checked-out branch fails."

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: |
  Two bugs, same underlying issue with one shared root:

  Bug 2 (fatal: invalid reference: + test-branch):
  list_branches_local (git/mod.rs) and list_remote_branches (git/remote.rs) both use
  trim_start_matches(|c: char| c == ' ' || c == '*') to strip the current-branch marker from
  git branch -a output. However, git uses '+' (not '*') to mark branches checked out in OTHER
  worktrees. These were not stripped, so branches like "test-branch" were returned as
  "+ test-branch". When passed to git worktree add, git rejected "+ test-branch" as an
  invalid reference.

  Bug 1 (cannot check out master):
  spawn_interactive_execution had no guard for the case where the selected branch is the
  currently-checked-out main worktree branch. It would attempt git worktree add for master,
  which fails because master is already checked out in the repo root.

fix: |
  1. git/mod.rs list_branches_local: added '+' to the trim_start_matches character set to strip
     the worktree-checkout marker from git branch -a output.
  2. git/remote.rs list_remote_branches: same fix.
  3. execution_handlers.rs spawn_interactive_execution: replaced the two-step check
     (get_current_branch + DB worktrees lookup) with a single `git worktree list --porcelain`
     call (crate::git::list_worktrees). This is authoritative for all three cases:
     - Branch found in git worktrees (main repo or existing worktree) → use that absolute path
     - Branch not found in git worktrees → create a new worktree

verification: "cargo check passes. Awaiting human verification of all 3 cases."
files_changed:
  - src-tauri/src/git/mod.rs
  - src-tauri/src/git/remote.rs
  - src-tauri/src/ipc/execution_handlers.rs
