---
phase: 24-improve-project-picker
plan: "01"
subsystem: backend-ipc
tags: [rust, ipc, git, tanstack-query, project-management]
dependency_graph:
  requires: []
  provides: [git_init_project-ipc, clone_project-ipc, create_new_project-ipc, useGitInitProject-hook, useCloneProject-hook, useCreateNewProject-hook]
  affects: [src/services/project.service.ts, src/types/bindings.ts]
tech_stack:
  added: []
  patterns: [inline-db-after-await, tokio-process-Command, tauri-specta-async-command]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/project_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
    - src/services/project.service.ts
decisions:
  - "Inline DB logic in async commands instead of calling create_project() to avoid State<'_> lifetime issues after .await points"
  - "useCreateNewProject.onError does not toast - Create dialog handles inline errors; useCloneProject.onError does toast - git failures are not inline-displayable"
metrics:
  duration: "0.226h"
  completed: "2026-03-28T18:08:00Z"
  tasks_completed: 2
  files_modified: 4
---

# Phase 24 Plan 01: IPC Backend for Git Project Operations Summary

Three async Rust IPC commands (git_init_project, clone_project, create_new_project) with TypeScript bindings and TanStack Query mutation hooks provide the backend foundation for the improved project picker UI.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add three async IPC commands in Rust and register them | 0b06f0d | project_handlers.rs, lib.rs, bindings.ts |
| 2 | Add TanStack Query mutation hooks for clone and create-new | 5860b89 | project.service.ts, diff-utils.test.ts |

## What Was Built

### Rust IPC Commands (`src-tauri/src/ipc/project_handlers.rs`)

**`git_init_project(path: String) -> Result<(), String>`**
- No-op if `.git` directory already exists
- Runs `git init <path>` via `tokio::process::Command`
- Returns `Ok(())` on success

**`clone_project(url, target_path) -> Result<Project, String>`**
- Runs `git clone <url> <target_path>` via tokio
- Inlines DB insert + `.maestro` init (avoids `State<'_>` lifetime issue after `.await`)
- Returns fully populated `Project` struct

**`create_new_project(parent_dir, folder_name) -> Result<Project, String>`**
- Validates directory doesn't already exist
- Creates directory with `std::fs::create_dir_all`
- Runs `git init` in the new directory
- Inlines DB insert + `.maestro` init
- Returns fully populated `Project` struct

### TypeScript Bindings (`src/types/bindings.ts`)
Regenerated via `pnpm tauri:gen`:
- `gitInitProject(path: string): Promise<Result<null, string>>`
- `cloneProject(url: string, targetPath: string): Promise<Result<Project, string>>`
- `createNewProject(parentDir: string, folderName: string): Promise<Result<Project, string>>`

### Mutation Hooks (`src/services/project.service.ts`)
- `useGitInitProject()` — silent pre-step, no success toast, error toast on failure
- `useCloneProject()` — invalidates local project list, success + error toasts
- `useCreateNewProject()` — invalidates local list, success toast, inline error handling only

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing TS2532 in diff-utils.test.ts**
- **Found during:** Task 2 verification (`pnpm build`)
- **Issue:** `result[0].newFile.fileName` accessed without null check, TypeScript strict mode flagged it
- **Fix:** Changed to `result[0].newFile?.fileName` (optional chain)
- **Files modified:** `src/utils/helpers/diff-utils.test.ts`
- **Commit:** 5860b89

**2. [Architecture] Inline DB logic instead of calling `create_project()`**
- **Found during:** Task 1 implementation
- **Issue:** Async commands using `State<'_>` after `.await` points can fail to compile due to Rust lifetime constraints (anticipated by RESEARCH.md Pitfall 1)
- **Fix:** Inlined the DB insert + `.maestro` init logic from `create_project()` in both `clone_project` and `create_new_project`
- **Files modified:** `src-tauri/src/ipc/project_handlers.rs`
- **Commit:** 0b06f0d

## Known Stubs

None — no placeholder data, hardcoded empty values, or unconnected props introduced.

## Self-Check: PASSED
