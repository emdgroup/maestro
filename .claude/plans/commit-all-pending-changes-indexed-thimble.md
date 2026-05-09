# Plan: Commit all pending changes

## Context

Large in-progress refactoring spread across 26 modified files and 11 untracked plan files. Changes unify the ACP transport layer (merging local/remote `ProjectServer`), fix a race condition in maestro-server session loading, simplify the frontend activity panel rendering, and batch remote SSH probe commands.

## Approach

Single commit encompassing all changes. The untracked `.claude/plans/` files are ephemeral planning artifacts — include them for completeness.

### Commit message

```
Unify ACP transport layer, fix session load race, and refactor activity panel

- Merge ProjectServer and RemoteProjectServer into a single struct with
  TransportTarget enum for local/remote dispatch
- Extract helper functions in acp_handlers (resolve_remote_context,
  get_session_cache, session_file_rpc) reducing 681 lines
- Fix maestro-server race: register session route before sending load
  request so history notifications during load aren't dropped
- Batch 3 remote SSH probe calls (arch, version, HOME) into 1 command
- Extract AgentResponseSection component and groupIntoAgentSections
  utility for cleaner activity panel rendering
- Move plan panel above scroll area as fixed header
```

### Steps

1. `git add -A` — stage all modified + untracked files
2. `git commit` with message above

## Verification

- `git log --oneline -1` shows new commit
- `git status` clean after commit
