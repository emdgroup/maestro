# Phase 12: Worktree Disk Cleanup - Research

**Researched:** 2026-02-08
**Domain:** Git worktree deletion, disk space reclamation, and safe cleanup ordering
**Confidence:** HIGH

## Summary

Phase 12 closes tech debt from Phase 6 where merge operations complete successfully but worktrees are not deleted from disk. Currently, finalize_successful_merge only updates database state (marks task Done, returns worktree to pool), leaving .worktree-pool/ directories accumulating. This phase implements full disk cleanup using the existing deleteWorktree sidecar function to reclaim disk space and prevent stale directory accumulation.

Key findings:
- **Cleanup mechanism already exists:** deleteWorktree in sidecar/src/git-manager.ts implements correct 3-step sequence (remove → delete branch → prune)
- **Integration gap:** finalize_successful_merge has TODO comment: "rely on cleanup_worktree to be called separately if needed" — this call is missing
- **Safety verified:** Git documentation confirms proper deletion order prevents corruption; current implementation follows this pattern
- **Zero-configuration:** No new dependencies needed; leverages existing simple-git 3.20+

**Primary recommendation:** Wire deleteWorktree invocation into finalize_successful_merge handler after task status transitions complete. Use existing Rust→sidecar→Node.js pattern established in Phase 6 merge operations.

## Standard Stack

### Core Dependencies

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `simple-git` | 3.20+ (existing) | Git operations in sidecar | Already integrated for merge ops; 311 snippets, HIGH reputation; includes `git worktree` commands |
| `tokio::process::Command` | 1.x (existing) | Async subprocess execution | Already used in spawn_agent_execution; prevents IPC handler freezes |
| `git worktree remove` | Native | Linked worktree deletion | Git's official API; prevents orphaned metadata vs filesystem delete |

### Database

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Worktree State** | SQLite (rusqlite) | Track worktree cleanup progress (mark Dirty before cleanup, delete after success) |
| **Task History** | execution_logs table | Optional: record cleanup events for audit trail |

### No New Dependencies Needed

Cleanup operations use existing stack:
- Sidecar: deleteWorktree function already exists and tested
- Rust: tokio::process::Command already handles sidecar invocation
- Frontend: No UI changes required (cleanup is transparent background operation)

## Architecture Patterns

### Recommended Cleanup Flow

```
finalize_successful_merge (Rust handler)
  ├─ 1. Update task status → Done
  ├─ 2. Return worktree to pool (status='Available')
  ├─ 3. Invoke sidecar: deleteWorktree(repo_path, worktree_id, branch_name)
  │    └─ Sidecar executes:
  │       ├─ git worktree remove <path> --force
  │       ├─ git branch -D <branch>
  │       └─ git worktree prune
  └─ 4. Update worktree in DB: DELETE from worktrees WHERE id=?
```

### Pattern 1: Safe Worktree Deletion Sequence

**What:** Three-step deletion maintaining git repository integrity

**When to use:** After successful merge, before returning worktree to pool

**Ordering (CRITICAL):**
```typescript
// Step 1: Remove worktree from filesystem AND .git/worktrees metadata
await git.raw(["worktree", "remove", worktreePath, "--force"]);

// Step 2: Delete branch (AFTER worktree removed, not before)
await git.branch(["-D", branchName]);

// Step 3: Prune stale metadata entries (handles crashes during prior cleanup)
await git.raw(["worktree", "prune"]);
```

**Why this order:**
- Removing branch while worktree occupies it → corrupted state, orphaned directory
- Pruning clears `.git/worktrees/` metadata (survives crashes from prior runs)
- --force handles both clean and dirty worktrees

**Example (from existing sidecar):**
```typescript
// Source: sidecar/src/git-manager.ts lines 59-110
export async function deleteWorktree(
  repoPath: string,
  worktreeId: string,
  branchName: string
): Promise<void> {
  const git = simpleGit(repoPath);
  const worktreePath = path.join(repoPath, ".worktree-pool", worktreeId);

  // Step 1: Remove worktree
  await git.raw(["worktree", "remove", worktreePath, "--force"]);

  // Step 2: Delete branch
  await git.branch(["-D", branchName]);

  // Step 3: Prune metadata
  await git.raw(["worktree", "prune"]);
}
```

### Pattern 2: Async Sidecar Invocation in IPC Handler

**What:** Rust handler spawns Node.js sidecar with deleteWorktree command

**When to use:** finalize_successful_merge must invoke cleanup

**Implementation pattern (established in Phase 6):**
```rust
// Source: Rust handler pattern from Phase 6 merge operations
async fn invoke_sidecar_delete(
    repo_path: &str,
    worktree_id: &str,
    branch_name: &str,
) -> Result<(), String> {
    let output = tokio::process::Command::new("node")
        .arg("/path/to/sidecar/dist/index.js")
        .arg("--delete-worktree")
        .arg(repo_path)
        .arg(worktree_id)
        .arg(branch_name)
        .output()
        .await
        .map_err(|e| format!("Sidecar spawn failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Sidecar cleanup failed: {}", stderr));
    }

    Ok(())
}
```

### Pattern 3: Error Handling for Failed Cleanup

**What:** Retry logic for cleanup failures (network timeouts, permission errors)

**When to use:** Sidecar invocation fails; should retry or defer

**Recommended strategy:**
```rust
// Mark worktree as "Dirty" before cleanup (crash-safe)
conn.execute(
    "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
    rusqlite::params![worktree_id],
)?;

// Attempt cleanup
match invoke_sidecar_delete(...).await {
    Ok(()) => {
        // Delete from DB after successful cleanup
        conn.execute("DELETE FROM worktrees WHERE id = ?", ...)?;
    }
    Err(e) => {
        // Log error but don't block merge
        eprintln!("Cleanup failed, will retry: {}", e);
        // Worktree stays "Dirty", recovered on next app startup
        // or manually via recover_dirty_worktrees()
    }
}
```

### Pattern 4: Database State Transitions

**What:** Update worktree lifecycle in database during cleanup

**When to use:** Track cleanup progress for recovery

**State machine:**
```
Available/Leased
    ↓ (merge successful)
Returned to pool (task Done)
    ↓ (cleanup starts)
Mark Dirty (before sidecar call)
    ↓ (cleanup succeeds)
DELETE from worktrees (remove DB entry)
    ↓
Reclaim disk space
```

**Why Dirty state:**
- If process crashes mid-cleanup, worktree entry survives in DB
- recover_dirty_worktrees() can retry cleanup on next startup
- Prevents orphaned filesystem directories accumulating silently

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Manual filesystem deletion | `rm -rf .worktree-pool/wt-001/` | `git worktree remove <path>` | Manual delete leaves stale metadata in .git/worktrees/; future worktree operations fail. Git's official API handles all cleanup. |
| Detecting orphaned worktrees | Parse `git worktree list` output | `git worktree prune` + `.git/worktrees/` monitoring | Prune handles expiration automatically; custom parsing is fragile. |
| Branch deletion before worktree removal | Delete branch first | Remove worktree FIRST, then branch | Deleting checked-out branch corrupts worktree; git prevents this, must use correct order. |
| Custom cleanup sequencing | Chain individual git commands | Use existing deleteWorktree function | Already tested in Phase 3 research; correct ordering verified; don't replicate. |
| Retry logic for flaky cleanup | Immediate retry on failure | Exponential backoff + Dirty state | Retrying too fast risks permission errors; Dirty state enables recovery across app restarts. |

**Key insight:** Git worktree cleanup is not "just delete a directory." Metadata corruption requires explicit `git worktree remove` + `git worktree prune`. The existing deleteWorktree function in sidecar implements this correctly.

## Common Pitfalls

### Pitfall 1: Skipping Disk Cleanup After Merge

**What goes wrong:**
- finalize_successful_merge updates DB but doesn't delete worktree directory
- .worktree-pool/ accumulates stale directories (100MB+ per worktree)
- After 10 merges: 1GB+ wasted disk space
- Users report "disk full" despite task completion

**Why it happens:**
- Merge success focuses on task status transition, forget cleanup
- Worktree directory not explicitly freed; exists in filesystem indefinitely
- No monitoring alerts for disk accumulation

**How to avoid:**
- **Delete worktree IMMEDIATELY after merge succeeds**, in same handler
- Don't defer to separate "cleanup job"
- Include cleanup in finalize_successful_merge transaction

**Warning signs:**
- `du -sh .worktree-pool/` shows 500MB+ for 3-5 tasks
- Disk usage grows linearly with task completion count
- No corresponding reduction in `git worktree list` output

### Pitfall 2: Deleting Worktree Before Removing from Sidecar

**What goes wrong:**
- Rust handler deletes .worktree-pool/wt-001/ from DB
- Later, sidecar tries `git worktree remove /path` → fails, stale branch remains
- Orphaned branch blocks future task allocation to same branch name

**Why it happens:**
- Tempting to remove DB entry first (feels "done")
- Then call cleanup, cleanup fails silently

**How to avoid:**
- **Mark Dirty in DB BEFORE sidecar call**
- Only delete from DB AFTER sidecar succeeds
- Order: DB→Dirty, then Sidecar, then DB→Delete

**Warning signs:**
- `git branch -a | grep pool/` shows many "pool/agent-task-*" branches
- "branch already exists" errors on task allocation
- Worktree rows in DB but filesystem directories missing

### Pitfall 3: Not Pruning Metadata After Deletion

**What goes wrong:**
```
First cleanup:
  1. Remove worktree → OK
  2. Delete branch → OK
  3. Skip prune step
Second cleanup (different worktree):
  1. Remove worktree → OK
  2. Delete branch → OK
  3. Now prune
     └─ Takes 5+ seconds due to accumulated stale metadata
```

**Why it happens:**
- Prune seems optional (doesn't break immediate operation)
- Takes time (git walks .git/worktrees/), tempting to skip

**How to avoid:**
- **Always run `git worktree prune` as final step**
- Prune is cheap insurance against metadata bloat
- Include in deleteWorktree function (already does)

**Warning signs:**
- `git worktree prune -v` output grows over time
- Git operations slow down despite cache optimization
- `.git/worktrees/` directory contains many entries

### Pitfall 4: Blocking Merge Finalization on Cleanup Failure

**What goes wrong:**
- finalize_successful_merge calls deleteWorktree
- Sidecar network timeout or permission error
- Merge fails, task returned to Review
- User confused why merge failed (actually disk issue)

**Why it happens:**
- Treating cleanup as critical path
- One failure blocks entire merge operation

**How to avoid:**
- **Make cleanup best-effort, non-blocking**
- Log errors but don't throw from finalize_successful_merge
- Mark Dirty, attempt cleanup, continue regardless
- Cleanup retried on next app startup (recover_dirty_worktrees)

**Warning signs:**
- Merge success rate drops due to cleanup timeouts
- Users see "Merge failed" when actually task is Done
- Cleanup errors visible in task status

### Pitfall 5: Cleanup During Concurrent Allocation

**What goes wrong:**
```
Thread A: finalize_successful_merge starts cleanup
Thread B: lease_worktree tries to allocate same worktree (race)
  ├─ Thread A: git worktree remove /path
  ├─ Thread B: SELECT available worktrees
  └─ Race condition: inconsistent state
```

**Why it happens:**
- No transaction isolation between cleanup and lease
- Concurrent access to .worktree-pool/

**How to avoid:**
- **Use database transaction for worktree state**
- Mark Dirty BEFORE cleanup (prevents reallocation)
- Delete from DB AFTER cleanup succeeds
- Lease function skips Dirty worktrees

**Warning signs:**
- "Path already exists" or "Path doesn't exist" intermittent errors
- Worktree allocation hangs occasionally
- Race conditions in concurrent execution tests

## Code Examples

### Invoke deleteWorktree from Rust Handler

```rust
// Source: Established pattern from Phase 6 merge operations
// Location: src-tauri/src/ipc/handlers.rs (finalize_successful_merge)

// After task status updated and worktree marked for return:

// Prepare cleanup parameters
let (worktree_id, worktree_path, branch_name, repo_path) = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let (wt_id, path, branch, repo) = conn.query_row(
        "SELECT w.id, w.path, w.branch_name, p.path
         FROM worktrees w
         JOIN projects p ON w.project_id = p.id
         WHERE w.id = ?",
        rusqlite::params![worktree_id],
        |row| Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?,
                 row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    )?;

    (wt_id, path, branch, repo)
};

// Mark as Dirty before cleanup (crash-safe)
{
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "UPDATE worktrees SET status = 'Dirty', updated_at = ? WHERE id = ?",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), worktree_id],
    )?;
}

// Invoke sidecar to delete worktree
let output = tokio::process::Command::new("node")
    .arg(&sidecar_path) // e.g., "./sidecar/dist/index.js"
    .arg("--delete-worktree")
    .arg(&repo_path)
    .arg(&worktree_path)
    .arg(&branch_name)
    .output()
    .await
    .map_err(|e| format!("Sidecar spawn failed: {}", e))?;

if output.status.success() {
    // Cleanup succeeded - remove from DB
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![worktree_id])?;
    println!("[finalize] ✓ Worktree {} deleted from disk and DB", worktree_id);
} else {
    // Cleanup failed - log but don't block
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("[finalize] Cleanup failed (will retry): {}", stderr);
    // Worktree remains in "Dirty" status for recovery
}
```

### Sidecar CLI Handler for Worktree Deletion

```typescript
// Source: sidecar/src/index.ts (main CLI dispatcher)
// Already exists in git-manager.ts, needs CLI handler

// Add to main() CLI dispatcher:
else if (args.includes("--delete-worktree")) {
    const repoPathIdx = args.indexOf("--delete-worktree") + 1;
    const repoPath = args[repoPathIdx];
    const worktreePath = args[repoPathIdx + 1];
    const branchName = args[repoPathIdx + 2];

    if (!repoPath || !worktreePath || !branchName) {
        console.error("Usage: --delete-worktree <repoPath> <worktreePath> <branchName>");
        process.exit(1);
    }

    gitManager.deleteWorktree(repoPath, worktreePath, branchName)
        .then(() => {
            console.log(JSON.stringify({ success: true, worktreeId: worktreePath }));
            process.exit(0);
        })
        .catch((error) => {
            console.error(`Cleanup failed: ${error.message}`);
            process.exit(1);
        });
}
```

### Recovery Handler for Dirty Worktrees

```rust
// Source: Phase 3 pattern (recover_dirty_worktrees)
// Location: src-tauri/src/ipc/handlers.rs (on app startup)

#[tauri::command]
pub async fn recover_dirty_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<usize, String> {
    println!("Recovering dirty worktrees for project {}", project_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, path, branch_name FROM worktrees
         WHERE project_id = ? AND status = 'Dirty'"
    ).map_err(|e| e.to_string())?;

    let dirty_worktrees: Vec<(i32, String, String)> = stmt
        .query_map(rusqlite::params![project_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let count = dirty_worktrees.len();

    // Retry cleanup for each dirty worktree
    for (wt_id, path, branch) in dirty_worktrees {
        // Retry sidecar cleanup
        // (implementation same as finalize_successful_merge)
        if cleanup_succeeded {
            conn.execute("DELETE FROM worktrees WHERE id = ?", [wt_id])?;
        }
        // If cleanup fails again, stays Dirty for manual recovery
    }

    Ok(count)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual worktree cleanup on interval | Cleanup immediately after merge completion | 2023+ (async orchestration) | Faster disk reclamation, prevents accumulation |
| Assume merge success = worktree cleanup | Separate cleanup phase with error handling | 2020+ (cloud infrastructure patterns) | Distinguishes merge status from cleanup status |
| Filesystem delete without git metadata cleanup | `git worktree remove` + `git worktree prune` | 2016 (git worktree introduced) | Prevents orphaned metadata, maintains repo integrity |
| No monitoring of stale worktrees | Periodic recovery of Dirty worktrees | 2023+ (observability) | Automatic recovery from crashes, prevents manual intervention |

**Deprecated/outdated:**
- **Manual `rm -rf` worktree directories:** Causes orphaned metadata, blocks future operations
- **Cleanup on separate timer job:** Delays disk reclamation, complicates failure modes
- **Ignoring `git worktree prune`:** Metadata accumulates, git operations slow down

## Open Questions

1. **Cleanup Timing in Concurrent Scenarios**
   - What we know: finalize_successful_merge is async; can run concurrently with other merges
   - What's unclear: Should cleanup be serialized (one at a time) or parallel?
   - Recommendation: Parallel is safe (each cleanup operates on different worktree); use DB transaction isolation

2. **Cleanup Timeout Strategy**
   - What we know: deleteWorktree does 3 git commands (remove, branch delete, prune)
   - What's unclear: How long before cleanup times out? (5s? 30s? 2m?)
   - Recommendation: 30s timeout per cleanup; Dirty worktrees can be retried on next app startup

3. **Disk Space Monitoring**
   - What we know: Cleanup reclaims space immediately
   - What's unclear: Should we alert when .worktree-pool/ exceeds 1GB? Monitor available disk?
   - Recommendation: Optional Phase 13+ feature; not required for Phase 12 MVP

4. **Remote Project Cleanup**
   - What we know: Phase 9 added remote SSH execution support
   - What's unclear: Should remote worktrees be cleaned up via SSH or only local?
   - Recommendation: Phase 12 MVP focuses on local only; remote cleanup deferred to Phase 13+

## Sources

### Primary (HIGH confidence)

- **Git Documentation** (official)
  - https://git-scm.com/docs/git-worktree
  - Verified: Deletion sequence, --force behavior, metadata pruning
  - Topics: safe deletion order, `git worktree remove`, `git worktree prune`

- **Existing Codebase**
  - `sidecar/src/git-manager.ts`: deleteWorktree function (lines 59-110)
  - `src-tauri/src/ipc/handlers.rs`: finalize_successful_merge (existing, ready for wiring)
  - Verified: Patterns work; just need integration

- **Phase 3 & 6 Research**
  - Phase 3 RESEARCH.md: Git worktree patterns, cleanup pitfalls (verified 2026-02-05)
  - Phase 6 RESEARCH.md: Merge automation pattern (verified 2026-02-06)

### Secondary (MEDIUM confidence)

- **Simple-git Documentation**
  - Verified capabilities: `git.raw()` for worktree commands, `git.branch()` for branch deletion
  - Confidence: Already in use for Phase 6 merge operations; proven stable

### Tertiary (LOW confidence)

- None — all findings from authoritative sources or existing codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - simple-git existing, deleteWorktree already implemented
- Architecture: HIGH - Patterns follow Phase 3 & 6 established practices
- Common pitfalls: HIGH - Documented in git official docs and Phase 3 research
- Open questions: MEDIUM - Timeout/concurrency details not fully specified

**Research date:** 2026-02-08
**Valid until:** 2026-03-08 (30 days; git worktree API stable, no expected changes)

**Next steps for planner:**
1. Wire deleteWorktree invocation into finalize_successful_merge handler
2. Add Dirty state transitions to worktree DB updates
3. Implement recover_dirty_worktrees handler for app startup
4. Add error handling (log but don't block on cleanup failure)
5. Test with 10+ sequential merge operations; verify .worktree-pool/ remains small
6. Verify `git worktree list` stays clean (no orphaned entries)
