# Plan: CLAUDE.md Quality Improvements

## Context

Audit revealed 6 factual issues in the project CLAUDE.md (78/100 score). Most critical: the IPC communication section incorrectly describes where TanStack Query hooks live, and several lists are stale/incomplete.

## Changes

### 1. Fix IPC Communication section (lines 183-189)

**Current (wrong):**
> Service functions in `src/services/` wrap `invoke()`. Hooks in `src/utils/hooks/` wrap services via `useQuery`/`useMutation`.

**Corrected:**
> TanStack Query hooks (useQuery/useMutation) are co-located in service files (`src/services/*.service.ts`), not in a separate hooks directory. `src/utils/hooks/` contains non-query custom hooks (keyboard nav, path nav, execute task, etc.).

Also update "37+ hooks" → "100+ hooks" in the Tech Stack section.

### 2. Update Database tables list (line 179)

Add `task_attachments` to the list:

```
Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `task_attachments`, `worktrees`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`, `wsl_connections`, `session_aliases`
```

### 3. Update IPC handlers list (line 152)

Replace abbreviated list with complete list:

```
- `ipc/` — Tauri command handlers, one file per domain (`task_handlers.rs`, `project_handlers.rs`, `worktree_handlers.rs`, `execution_handlers.rs`, `review_handlers.rs`, `acp_handlers.rs`, `ssh_handlers.rs`, `integration_handlers.rs`, `issue_tracking_handlers.rs`, `issue_tracking_lookup_handlers.rs`, `filesystem_handlers.rs`, `sftp_handlers.rs`, `settings_handlers.rs`)
```

### 4. Update services list (line 144)

Replace "task.service, worktree.service, etc." with complete list:

```
- `services/` — IPC service layer with co-located TanStack Query hooks (task.service, worktree.service, execution.service, project.service, connection.service, settings.service, integration.service, issue-tracking-lookup.service)
```

### 5. Update maestro-server key files (line 167)

Add missing files:

```
Key files: `main.rs` (entry, message routing), `session_handler.rs` (ACP session lifecycle), `agent.rs` (subprocess spawn), `detection.rs` (agent discovery), `registry.rs` (session registry), `sessions.rs` (session types), `terminal.rs` (terminal I/O), `file_ops.rs` (file operations).
```

### 6. Update utils/hooks description

Change:
```
- `utils/` — hooks/, helpers/, constants/
```
To:
```
- `utils/` — hooks/ (useExecuteTask, useKeyboardNavigation, usePathNavigation, etc.), helpers/, constants/
```

## Files Modified

- `CLAUDE.md` (6 edits, all within existing sections)

## Verification

- Re-read file after edits to confirm no structural breakage
- Grep to verify all updated claims match codebase reality
