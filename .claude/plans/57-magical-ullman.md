# Execute Phase 57: Data Model & Backend

## Context

Phase 57 is the first phase of v1.7 Tasks UX Rework. It adds backend infrastructure all frontend phases (58-63) depend on: new task fields (`auto_approve`, `isolated_worktree`), a `task_attachments` table, and an `interrupt_task` IPC command.

## Execution Configuration

- **Plans**: 2 (Wave 1: 57-01, Wave 2: 57-02)
- **Parallelization**: false (sequential)
- **Branching**: none (stay on main)
- **Worktrees**: disabled (sequential mode)
- **Commit docs**: false
- **No flags active**: standard full-phase execution

## Execution Flow

### Wave 1: Plan 57-01 — Schema V18 + Models

**Tasks:**
1. Bump schema V17 → V18, add `auto_approve`/`isolated_worktree` columns to tasks DDL, add `task_attachments` table, update drop block and tests
2. Extend Task struct with 2 new fields, add TaskAttachment model, update TASK_SELECT and from_row indices, export from mod.rs

**Verify:** `cargo test test_schema_initialization` + `cargo check`

### Wave 2: Plan 57-02 — IPC Handlers + Bindings + Frontend Hooks

**Depends on Wave 1** (needs TaskAttachment model to exist)

**Tasks:**
1. Add 4 IPC handlers in task_handlers.rs: `get_task_attachments`, `add_task_attachment`, `remove_task_attachment`, `interrupt_task` (async)
2. Register commands in lib.rs, run `pnpm tauri:gen` for TypeScript bindings
3. Add 4 TanStack Query hooks in task.service.ts

**Verify:** `cargo test` + `cargo check` + `pnpm tauri:gen` + `pnpm lint`

### Post-Execution

- Run code review (advisory)
- Verify phase goal achievement
- Update ROADMAP.md progress

## Critical Files

- `src-tauri/src/db/schema.rs` — schema DDL (currently V17)
- `src-tauri/src/models/task.rs` — Task struct + TASK_SELECT
- `src-tauri/src/models/mod.rs` — re-exports
- `src-tauri/src/ipc/task_handlers.rs` — new handlers
- `src-tauri/src/ipc/acp_handlers.rs` — reference for cancel logic
- `src-tauri/src/ipc/execution_handlers.rs` — reference for PTY close logic
- `src-tauri/src/lib.rs` — command registration
- `src/types/bindings.ts` — generated types
- `src/services/task.service.ts` — frontend hooks

## Verification

After both waves complete:
- `cd src-tauri && cargo test` — all pass
- `cd src-tauri && cargo check` — clean
- `pnpm tauri:gen` — generates bindings with TaskAttachment + updated Task
- `pnpm lint` — clean
- Grep checks: SCHEMA_VERSION=18, TaskAttachment exported, 4 commands registered, 4 hooks exported
