# Phase 28: Zombie Cleanup on Project Open — Research

**Researched:** 2026-03-30
**Domain:** Rust IPC command + TypeScript frontend hook
**Confidence:** HIGH

---

## Summary

Phase 28 adds a single new IPC command `cleanup_zombie_worktrees(project_id, repo_path)` that runs automatically when a project is opened. It queries the DB for worktrees meeting zombie criteria (no task link OR task status is Done/Cancelled, AND created more than 10 minutes ago), cross-references `git worktree list --porcelain` to confirm the path still exists on disk, then deletes each confirmed zombie via the existing `delete_worktree_local` pattern. The frontend calls this command in a `useEffect` in `App.tsx` keyed on `currentProject.id`.

The existing codebase provides all the primitive operations this command needs: `list_worktrees_local` (wraps `git worktree list --porcelain`), `delete_worktree_local` (wraps `git worktree remove --force`), Mutex-guarded SQLite access, and `chrono` for timestamp comparison. No new dependencies are required.

`recover_dirty_worktrees` was removed as part of Phase 25 (REQ-05) — it no longer exists in the codebase. The frontend `App.tsx` also no longer calls it. Phase 28 is therefore a net-new addition, not a replacement of a live call.

**Primary recommendation:** Add `cleanup_zombie_worktrees` as a new `#[tauri::command]` in `worktree_handlers.rs`, register it in `lib.rs`, regenerate TypeScript bindings, add a `useCleanupZombieWorktreesMutation` hook to `worktree.service.ts`, and call it from `App.tsx` on `currentProject` change.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-34 | `cleanup_zombie_worktrees(project_id)` IPC — finds worktrees where `task_id IS NULL` OR task status is Done/Cancelled, AND path confirmed on disk by `git worktree list`. Never deletes DB-only. | DB query pattern from `list_worktrees_with_status`; disk confirmation via `list_worktrees_local` |
| REQ-35 | Time threshold — only consider worktrees with `created_at` older than 10 minutes | `chrono::Utc::now()` minus 10 min; parse `created_at` as RFC3339; already used throughout codebase |
| REQ-36 | Called on project open, replacing `recover_dirty_worktrees` call in `App.tsx` | `recover_dirty_worktrees` already removed; new `useEffect` on `currentProject.id` triggers the mutation |
</phase_requirements>

---

## Project Constraints (from CLAUDE.md)

- **Rust async IPC:** All git subprocess calls must use `tokio::process::Command`; never block the async runtime with `std::process::Command`
- **DB access:** Always lock `app_state.db.lock()` before accessing SQLite; never hold the lock across `.await` points
- **Type generation:** After any Rust model change, run `pnpm tauri:gen` to regenerate `src/types/bindings.ts`
- **No barrel `index.ts`:** Use direct imports; barrel files have been removed from all domain directories
- **Service layer:** All IPC calls from the frontend go through `api.*` (the Proxy wrapper in `tauri-utils.ts`) via TanStack Query hooks; no direct `invoke()` in components
- **IPC registration:** New commands must be added to the `collect_commands![]` macro in `lib.rs`
- **TaskStatus serialization:** `PascalCase` (`Done`, `Cancelled`, not `done`/`cancelled`) via `#[serde(rename_all = "PascalCase")]`

---

## Standard Stack

No new dependencies required for this phase. All necessary crates are already present.

### Already Available
| Crate / Library | Version | Purpose | Where Used |
|-----------------|---------|---------|------------|
| `chrono` | existing | Timestamp parsing + arithmetic for 10-min threshold | `worktree_handlers.rs` (imports `chrono::Utc`) |
| `tokio::process::Command` | existing | Non-blocking `git worktree list` and `git worktree remove` | `git/mod.rs` |
| `rusqlite` | existing | SQLite queries for zombie detection | All IPC handlers |
| `tauri-specta` | existing | TypeScript binding generation | `lib.rs`, all `#[tauri::command]` handlers |
| `@tanstack/react-query` | existing | `useMutation` hook for frontend trigger | `worktree.service.ts` |

**No `npm install` or `Cargo.toml` edits required.**

---

## Architecture Patterns

### Recommended Structure

This phase adds:
- 1 new `#[tauri::command]` in `src-tauri/src/ipc/worktree_handlers.rs`
- 1 registration line in `src-tauri/src/lib.rs`
- 1 new `useMutation` hook in `src/services/worktree.service.ts`
- 1 new `useEffect` block in `src/App.tsx`

No new files. No new directories.

### Pattern 1: Zombie Detection SQL Query

The query follows the exact same structure as `list_worktrees_with_status` — lock DB, prepare statement, query rows, release lock before any `async` work.

```rust
// Source: pattern from worktree_handlers.rs list_worktrees_with_status
let candidates: Vec<(i32, String, String)> = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT w.id, w.path, w.created_at
         FROM worktrees w
         LEFT JOIN tasks t ON t.id = w.task_id
         WHERE w.project_id = ?
           AND (w.task_id IS NULL OR t.status IN ('Done', 'Cancelled'))"
    ).map_err(|e| format!("Prepare failed: {}", e))?;
    // collect rows, release lock
};
```

Key constraint: **never hold the Mutex across an `.await` point.** The DB lock must be acquired, rows collected into an owned `Vec`, and the lock released before calling any async git functions.

### Pattern 2: Time Threshold Filtering

```rust
// Source: chrono pattern from existing created_at usage throughout codebase
use chrono::{DateTime, Utc, Duration};

let threshold = Utc::now() - Duration::minutes(10);
let candidates: Vec<_> = all_candidates
    .into_iter()
    .filter(|(_, _, created_at)| {
        created_at.parse::<DateTime<Utc>>()
            .map(|dt| dt < threshold)
            .unwrap_or(false)  // If parse fails, skip (don't delete)
    })
    .collect();
```

Timestamps are stored as ISO 8601 RFC3339 strings throughout the schema. `chrono` is already imported in `worktree_handlers.rs` via `use chrono::Utc;`.

### Pattern 3: Disk Confirmation via git worktree list

```rust
// Source: git/mod.rs list_worktrees_local
let disk_worktrees = crate::git::list_worktrees_local(&repo_path).await?;
let disk_paths: std::collections::HashSet<String> =
    disk_worktrees.iter().map(|wt| wt.path.clone()).collect();

// Only process candidates confirmed on disk
for (id, relative_path, _) in candidates {
    let abs_path = format!("{}/{}", repo_path, relative_path);
    if disk_paths.contains(&abs_path) {
        // Safe to delete
    }
}
```

Note: `list_worktrees_local` returns absolute paths in `wt.path` (git reports full paths). The DB stores relative paths (e.g., `.maestro/worktrees/task-42`). The join must prefix with `repo_path`.

### Pattern 4: Delete via Existing Helper

The existing `delete_worktree_local` in `git/mod.rs` calls `git worktree remove --force`. The Rust handler should reuse this directly rather than re-implementing it.

```rust
// Source: git/mod.rs delete_worktree_local (private function, called via delete_worktree dispatcher)
let git_conn = crate::models::GitConnection::Local { path: repo_path.clone() };
let _ = crate::git::delete_worktree(&git_conn, &relative_path).await;
// Best-effort: don't fail if git remove fails; still delete DB row

let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
conn.execute("DELETE FROM worktrees WHERE id = ?", [id])
    .map_err(|e| format!("Delete failed: {}", e))?;
```

### Pattern 5: Frontend useEffect on Project Open

`App.tsx` shows `currentProject` is a value from `useSelectedProject()`. When `currentProject` becomes non-null (project selected), a `useEffect` should fire the mutation. The pattern mirrors how other one-shot mutations are called at mount time.

```typescript
// Source: App.tsx pattern — useEffect keyed on currentProject?.id
const cleanupZombiesMutation = useCleanupZombieWorktreesMutation();

useEffect(() => {
  if (currentProject) {
    cleanupZombiesMutation.mutate({
      projectId: currentProject.id,
      repoPath: currentProject.path,
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [currentProject?.id]);
```

The mutation dependency array uses `currentProject?.id` (not the full object) to prevent re-firing on reference changes.

### Pattern 6: TanStack Mutation Hook in worktree.service.ts

```typescript
// Source: pattern from useDeleteWorktreeMutation in worktree.service.ts
export function useCleanupZombieWorktreesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, repoPath }: { projectId: number; repoPath: string }) => {
      return await api.cleanupZombieWorktrees(projectId, repoPath);
    },
    onSuccess: (deletedCount) => {
      if (deletedCount > 0) {
        queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      }
    },
    onError: (error) => {
      console.error("[DEBUG] cleanup_zombie_worktrees failed:", error);
      // Silent: do not toast on failure — zombie cleanup is background housekeeping
    },
  });
}
```

Silent on error is the correct choice here — this is background housekeeping, not a user-initiated action. No toast on success either (unless `deletedCount > 0`, at which point a subtle info toast is optional).

### Anti-Patterns to Avoid

- **Holding Mutex across `.await`:** Never do `let conn = app_state.db.lock()?; conn...await...`. Collect all DB data first, drop the guard, then do async git calls.
- **Deleting based on DB state alone:** REQ-34 is explicit — must confirm existence via `git worktree list` before deleting. A zombie that's already been deleted on disk (no DB row cleanup) should not trigger a failing `git worktree remove`.
- **Failing if git remove fails:** Use `let _ = crate::git::delete_worktree(...)` — best-effort, always proceed to delete the DB row. This matches `delete_worktree_for_task` pattern.
- **Blocking on `is_zombie` from `WorktreeWithStatus`:** Phase 28's logic is richer than the current `is_zombie` flag (which only checks `task_id IS NULL`). The new command also includes worktrees whose task is Done/Cancelled.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| List on-disk worktrees | Custom `git worktree list` parser | `crate::git::list_worktrees_local()` — already implemented and tested |
| Delete a worktree | Custom `git worktree remove` call | `crate::git::delete_worktree(&git_conn, path)` — already handles `--force` flag |
| Timestamp arithmetic | Manual string manipulation | `chrono::Duration::minutes(10)` — crate already in `Cargo.toml` |
| Result unwrapping in frontend | Direct `invoke()` + manual unwrap | `api.*` Proxy wrapper — auto-unwraps `Result<T, E>` and throws on error |

---

## Common Pitfalls

### Pitfall 1: Path Mismatch (DB relative vs. git absolute)
**What goes wrong:** `git worktree list --porcelain` returns absolute paths (e.g., `/home/user/project/.maestro/worktrees/task-5`). The DB stores relative paths (`.maestro/worktrees/task-5`). Comparing them directly produces no matches — zero zombies found, nothing deleted.
**Why it happens:** `list_worktrees_with_status` constructs absolute paths via `format!("{}/{}", repo_path, row.path)`. The new command must do the same.
**How to avoid:** Build the `HashSet<String>` of disk paths using absolute paths; construct the candidate's absolute path as `format!("{}/{}", repo_path, relative_path)` before looking it up.
**Warning signs:** `cleanup_zombie_worktrees` returns 0 deletions even when zombies are clearly visible in the Worktrees view.

### Pitfall 2: Mutex Held Across Await
**What goes wrong:** `Lock already acquired` panic or deadlock at runtime when the DB lock is held across an `.await` point (e.g., during the `git worktree list` subprocess).
**Why it happens:** `MutexGuard` is `!Send`; holding it across `.await` in an async context triggers a compile error or panic depending on executor.
**How to avoid:** Collect all DB data into an owned `Vec` inside a block `{}`, drop the guard, then call `list_worktrees_local`.
**Warning signs:** `cargo check` produces "future is not Send" errors; or runtime panics with "attempt to lock a mutex that is already locked".

### Pitfall 3: Zombie Detected but Task Has Active Execution
**What goes wrong:** A task transitions to Done status in the DB while an agent is still running (race condition or manual status change). The zombie cleanup deletes the worktree the agent is writing to.
**Why it happens:** The 10-minute time threshold (REQ-35) mitigates startup races, but not mid-execution Done status changes.
**How to avoid:** In the SQL query, add a guard: exclude worktrees where there is a running execution. Add `AND NOT EXISTS (SELECT 1 FROM execution_logs el WHERE el.task_id = w.task_id AND el.status = 'running')` to the WHERE clause. This is a safety net beyond what REQ-34 specifies, and aligns with the "never delete what's actively in use" principle.
**Warning signs:** Agent execution fails mid-run with file system errors; worktree directory disappears unexpectedly.

### Pitfall 4: TypeScript Bindings Not Regenerated
**What goes wrong:** After adding the `#[tauri::command]` in Rust, the frontend has no `commands.cleanupZombieWorktrees` method. `api.cleanupZombieWorktrees` is undefined at runtime.
**Why it happens:** `src/types/bindings.ts` is auto-generated; it only updates when `pnpm tauri:gen` is run.
**How to avoid:** Always run `pnpm tauri:gen` after any Rust IPC changes, before writing frontend code.
**Warning signs:** TypeScript compiler errors — `Property 'cleanupZombieWorktrees' does not exist on type`.

### Pitfall 5: Forgetting to Register in lib.rs
**What goes wrong:** The IPC command exists in Rust but is never exposed to the frontend. `invoke("cleanup_zombie_worktrees", ...)` fails at runtime with "command not found".
**Why it happens:** `tauri-specta` requires explicit registration in `collect_commands![]` in `lib.rs`.
**How to avoid:** Add `crate::ipc::cleanup_zombie_worktrees` to the `collect_commands![]` list in `lib.rs`.
**Warning signs:** `pnpm tauri:gen` completes but `bindings.ts` does not contain the new command.

---

## Code Examples

### Complete IPC Handler Shape

```rust
// Source: patterns from worktree_handlers.rs
#[tauri::command]
#[specta::specta]
pub async fn cleanup_zombie_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    // Returns: number of worktrees deleted

    // 1. Query DB candidates (lock, collect, release)
    let threshold = chrono::Utc::now() - chrono::Duration::minutes(10);
    let candidates: Vec<(i32, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        // SELECT + filter by time threshold + zombie condition
    };

    // 2. Get on-disk worktree paths
    let disk_worktrees = crate::git::list_worktrees_local(&repo_path).await?;
    let disk_paths: std::collections::HashSet<String> = disk_worktrees
        .iter().map(|wt| wt.path.clone()).collect();

    // 3. Delete confirmed zombies
    let mut deleted = 0i32;
    for (id, relative_path) in candidates {
        let abs_path = format!("{}/{}", repo_path, relative_path);
        if disk_paths.contains(&abs_path) {
            let git_conn = crate::models::GitConnection::Local { path: repo_path.clone() };
            let _ = crate::git::delete_worktree(&git_conn, &relative_path).await;
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", [id]);
            deleted += 1;
        }
    }

    println!("cleanup_zombie_worktrees: deleted {} zombie worktrees", deleted);
    Ok(deleted)
}
```

### SQL Query for Zombie Candidates

```sql
SELECT w.id, w.path, w.created_at
FROM worktrees w
LEFT JOIN tasks t ON t.id = w.task_id
WHERE w.project_id = ?
  AND (w.task_id IS NULL OR t.status IN ('Done', 'Cancelled'))
  AND NOT EXISTS (
      SELECT 1 FROM execution_logs el
      WHERE el.task_id = w.task_id AND el.status = 'running'
  )
```

Note: The `TaskStatus` enum serializes as PascalCase strings in SQLite. Verify the actual stored values by checking `tasks.status` in the DB — they are stored as `'Done'`, `'Cancelled'`, etc. (confirmed by `#[serde(rename_all = "PascalCase")]` and `impl FromStr for TaskStatus` which matches `"Done"` and `"Cancelled"`).

---

## Runtime State Inventory

> Step 2.5: Not a rename/refactor phase. SKIPPED.

---

## Environment Availability

> Step 2.6: This phase uses only the git CLI and existing Rust/Node toolchains already confirmed available by prior phases (25, 27).

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `git` CLI | `list_worktrees_local`, `delete_worktree_local` | Confirmed (Phase 27 used same functions) | any | — |
| `chrono` crate | Timestamp arithmetic | Confirmed (already in `Cargo.toml`, used in `worktree_handlers.rs`) | existing | — |
| `pnpm tauri:gen` | Binding regeneration | Confirmed (used in all prior phases) | existing | — |

**No missing dependencies.**

---

## Validation Architecture

> `workflow.nyquist_validation` key is absent from `.planning/config.json` — treated as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Frontend framework | Vitest |
| Rust unit tests | `cargo test` (inline `#[cfg(test)]` modules) |
| Quick run (frontend) | `pnpm test` |
| Quick run (Rust) | `cd src-tauri && cargo test` |
| Build check | `pnpm build` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | Notes |
|--------|----------|-----------|-------------------|-------|
| REQ-34 | Zombie detection SQL returns correct candidates | Manual smoke test via app | — | IPC command not unit-testable without Tauri runtime; use `cargo check` |
| REQ-34 | Never deletes if path not on disk | Manual | — | Verified by observing no deletion when git confirms absence |
| REQ-35 | 10-minute threshold filters recent worktrees | Manual | — | Would require in-process unit test with mock; not in current Rust test infra |
| REQ-36 | `useEffect` fires on project open | Manual app launch test | — | Verify via console log output |

### Wave 0 Gaps

None — this phase does not require new test files. The existing `cargo check` + `pnpm build` pipeline is sufficient to verify correctness. The behavior is simple enough that a manual smoke test (open a project with a known Done-task worktree older than 10 min, confirm it disappears) serves as the acceptance gate.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `recover_dirty_worktrees` (pool-based status reset) | `cleanup_zombie_worktrees` (delete confirmed zombies) | Phase 25 (REQ-05 removed old command) | Net-new addition; no migration needed |
| `WorktreeStatus` pool enum (`Dirty`, `Available`, etc.) | No status enum; worktrees deleted not returned | Phase 25 | Simplifies cleanup logic |

**Deprecated/outdated:**
- `recover_dirty_worktrees`: Removed in Phase 25 as part of REQ-05 pool command removal. Does not exist in current `worktree_handlers.rs` or `lib.rs`. The requirements description saying "replaces" this call refers to the conceptual intent, not a live code replacement.

---

## Open Questions

1. **Should `cleanup_zombie_worktrees` return the count of deleted worktrees?**
   - What we know: The frontend mutation's `onSuccess` callback could invalidate the worktree query if `deletedCount > 0`, skipping an unnecessary cache invalidation when nothing was cleaned up.
   - What's unclear: Whether the planner wants `Result<i32, String>` (count) or `Result<(), String>` (unit).
   - Recommendation: Return `i32` (count). Enables smarter cache invalidation; zero overhead.

2. **Should the running-execution guard be added?**
   - What we know: REQ-34 specifies `task_id IS NULL OR task status is Done/Archived`. Adding a running-execution guard exceeds the requirement but prevents a dangerous race condition.
   - What's unclear: Whether "Archived" in REQ-34 maps to `Cancelled` in the TaskStatus enum (no `Archived` variant exists).
   - Recommendation: Map "Archived" to `Cancelled` (the only terminal non-Done status). Add the running-execution guard as a safety net.

3. **Silent failure on app open?**
   - What we know: The mutation is background housekeeping; user doesn't initiate it.
   - Recommendation: Log errors via `console.error` only; no toast on failure. The Worktrees view still works even if cleanup fails.

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/src/ipc/worktree_handlers.rs` — existing `list_worktrees_with_status` and `delete_worktree` patterns
- `src-tauri/src/git/mod.rs` — `list_worktrees_local`, `delete_worktree_local` implementations
- `src-tauri/src/db/schema.rs` — worktrees table schema (schema v3)
- `src-tauri/src/models/worktree.rs` — `WORKTREE_PATH_PREFIX`, `worktree_path_for_task`
- `src-tauri/src/models/task.rs` — `TaskStatus` enum with PascalCase variants
- `src/App.tsx` — project open trigger pattern; `currentProject` source
- `src/services/worktree.service.ts` — mutation hook patterns
- `src/utils/helpers/tauri-utils.ts` — `api` Proxy wrapper
- `.planning/REQUIREMENTS.md` — REQ-34, REQ-35, REQ-36 specifications

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` — confirms `recover_dirty_worktrees` removed in Phase 25 (REQ-05)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies verified present in codebase
- Architecture: HIGH — patterns lifted directly from existing `worktree_handlers.rs` code
- Pitfalls: HIGH — Mutex-across-await and path mismatch are confirmed patterns from Phase 25 accumulated decisions in STATE.md

**Research date:** 2026-03-30
**Valid until:** 2026-04-30 (stable codebase; no fast-moving dependencies)
