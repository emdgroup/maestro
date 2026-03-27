# Phase 3: Git Worktree Infrastructure - Research

**Researched:** 2026-02-05
**Domain:** Git worktree creation, lifecycle management, pooling, and automatic cleanup
**Confidence:** HIGH

## Summary

Phase 3 requires implementing hybrid git worktree pooling (pre-create 3-5 for instant allocation, expand dynamically on exhaustion) with full lifecycle management (create, lease, return, delete with automatic cleanup post-merge). The standard approach uses simple-git for Node.js-based git operations via the Tauri sidecar, SQLite for worktree state tracking, and careful orchestration of create/delete/branch workflows to avoid corruption. Key challenges: concurrent access safety, stale metadata cleanup, and proper deletion ordering (worktree removal before branch deletion).

**Primary recommendation:** Implement worktree pooling with explicit state transitions (available → leased → in-use → returned → cleanup), use SQLite transactions for atomic state updates, and adopt the git safety pattern of `worktree remove` + `branch delete` in correct order.

---

## Standard Stack

### Core Git Operations

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **simple-git** | 3.20+ | Node.js git command wrapper | **Verified via Context7 (311 snippets, High reputation)**. Provides promise-based API for git commands including worktree operations. Best choice for: orchestrating git commands from Node.js sidecar. Alternatives (isomorphic-git) lack native git worktree support. |

### Database & State Management

| Component | Technology | Version | Purpose | Why Standard |
|-----------|-----------|---------|---------|--------------|
| **Worktree State Tracking** | SQLite (rusqlite) | 3.46+ | Persistent worktree pool state | Already in schema: `worktrees` table with status, lease tracking. Atomic transactions for state updates |
| **Sidecar Process** | Node.js | 22 LTS | Run git commands, manage worktree lifecycle | Already in architecture (from Phase 2 stack research). child_process for spawning Claude Code CLI, simple-git for git ops |

### Process & Lifecycle Management

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **execa** | 6.1+ | Cross-platform process execution | **Benchmark 89.2, verified via Context7**. Better DX than raw child_process: error handling, timeout, signal management. Essential for Claude Code CLI integration in Phase 4 |
| **child_process** | Built-in | Spawn and manage CLI processes | Node.js built-in. Use for capturing output, managing signals, lifecycle tracking |

---

## Architecture Patterns

### Recommended Worktree Pool Structure

```
Project Repository (.git/)
├── worktrees/             # Git internal worktree metadata
│   ├── wt-agent-1/
│   ├── wt-agent-2/
│   ├── wt-agent-3/
│   └── wt-agent-4/
├── .worktree-pool/        # App-managed worktrees
│   ├── wt-001/
│   ├── wt-002/
│   ├── wt-003/
│   ├── wt-004/
│   └── wt-005/
```

**Rationale:**
- Pre-create in `.worktree-pool/` directory separate from main worktree
- Git metadata in `.git/worktrees/` (native)
- Naming: `wt-001`, `wt-002` (sortable, deterministic)
- Each worktree gets branch: `pool/agent-task-{taskId}` (unique per task allocation)

### Pattern 1: Worktree Lease Lifecycle

**What:** State machine for worktree allocation and return

**When to use:** Every time a task needs execution environment

**State Transitions:**
```
available ──(lease)──> leased ──(execute)──> in-use ──(return)──> available
                                    │
                                    └──(error)──> dirty ──(cleanup)──> available
```

**Example flow:**
```typescript
// Pseudo-code showing state machine

// 1. Lease: find available worktree or create new one
const worktree = await leaseWorktree(projectId);
// UPDATE worktrees SET status='leased', leased_at=NOW() WHERE id=worktree.id

// 2. Execute: task execution updates status
// UPDATE worktrees SET status='in-use' WHERE id=worktree.id

// 3. Return: after completion (success or failure)
await returnWorktree(worktree.id);
// UPDATE worktrees SET status='available', returned_at=NOW() WHERE id=worktree.id

// 4. Cleanup (Phase 6): post-merge, delete branch and clean worktree
await cleanupWorktree(worktree.id);
// UPDATE worktrees SET status='dirty' WHERE id=worktree.id
// DELETE FROM worktrees WHERE id=worktree.id (after branch deleted)
```

### Pattern 2: Dynamic Pool Expansion

**What:** Automatically create worktrees when pool exhausted

**When to use:** Lease request with all worktrees in-use/leased

**Implementation:**
```typescript
async function leaseWorktree(projectId: i32, maxPoolSize: i32 = 5): Promise<Worktree> {
  // 1. Find available worktree
  let available = await db.getAvailableWorktree(projectId);
  if (available) return available;

  // 2. Check if we can expand (not at max)
  const currentCount = await db.getWorktreeCount(projectId);
  if (currentCount < maxPoolSize) {
    // 3. Create new worktree
    const newWorktree = await createWorktree(projectId);
    return newWorktree;
  }

  // 4. Wait for one to be returned (exponential backoff, max 30s timeout)
  return await waitForAvailableWorktree(projectId, timeout: 30000);
}
```

**Configuration:** Default pool size = 5, expandable up to 10 (configurable)

### Pattern 3: Safe Deletion Sequence

**What:** Correct ordering of operations to avoid git corruption

**When to use:** Cleanup after task merge (Phase 6)

**Critical Ordering:**

```typescript
// CORRECT sequence (git requirement):
async function cleanupWorktree(projectId: i32, worktreeId: i32): Promise<void> {
  const worktree = await db.getWorktree(worktreeId);

  // Step 1: Remove worktree (git command)
  await git.worktreeRemove(worktree.path, force: false);

  // Step 2: Delete branch (only after worktree removed)
  await git.branch(['-D', worktree.branchName]);

  // Step 3: Cleanup git metadata
  await git.raw(['worktree', 'prune']);

  // Step 4: Remove from DB
  await db.deleteWorktree(worktreeId);
}

// WRONG - will cause orphaned worktree:
// git.branch(['-D', branchName]) then git.worktreeRemove()
```

**Why this order matters:**
- Deleting branch while worktree checks it out → corrupted state
- Must use `git worktree remove <path>` not just filesystem delete
- Pruning clears stale metadata entries

---

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Running git commands from Node | Custom git binary spawn | **simple-git** | Handles error parsing, timeout, signal management. Custom spawn is error-prone |
| Worktree directory creation | Manual mkdir + git config | **git worktree add** | Git handles metadata, branch tracking, refs isolation. Manual setup corrupts repository state |
| Tracking worktree state | In-memory pool object | **SQLite transactions** | Memory loss on crash → orphaned worktrees. SQLite provides durability + atomic transitions |
| Branch checkout isolation | Detached HEAD worktrees | **Named branches per worktree** | Detached HEAD loses context, harder to track in pool. Named branches make identity/lifecycle clear |
| Cleanup retry logic | Immediate delete on failure | **Exponential backoff + recovery** | Process crash during cleanup → stale worktrees. Need retry logic + `git worktree repair` for recovery |
| Pool expansion timing | Expand on every lease | **Expand only on exhaustion** | Creates unnecessary worktrees, wastes disk space. Pre-create 3-5, expand only when needed |

**Key insight:** Git worktrees share `.git/objects/` repository state. Naive concurrent operations (no transaction isolation, no state tracking) corrupt the repository. Simple-git + SQLite atomicity solves this.

---

## Common Pitfalls

### Pitfall 1: Manual Directory Deletion Without `git worktree remove`

**What goes wrong:**
```bash
# WRONG - leaves stale metadata
rm -rf .worktree-pool/wt-001/
# Now git thinks worktree exists but directory missing
# Can't create new worktree at same path
# `git worktree list` shows orphaned entry
```

**Why it happens:**
- Developers familiar with file operations think delete = cleanup
- Git worktree metadata in `.git/worktrees/` is invisible to filesystem

**How to avoid:**
- **Always** use `git worktree remove <path>` before deleting directory
- Never use filesystem delete directly
- Pattern: `worktree remove` → `branch delete` → `worktree prune`

**Warning signs:**
- `git worktree list` shows "detached" or "prunable" worktrees
- `git worktree add <path>` fails with "already exists" but directory gone
- `.git/worktrees/` accumulates entries over time

### Pitfall 2: Deleting Branch Before Worktree Removal

**What goes wrong:**
```bash
# WRONG - corrupts worktree
git branch -D pool/agent-task-123
# Then: git worktree remove .worktree-pool/wt-001
# Result: orphaned worktree, can't create new one at same path
```

**Why it happens:**
- Developer thinks "delete branch, then clean directory"
- Doesn't realize worktree has exclusive checkout lock on branch

**How to avoid:**
- **Always** remove worktree BEFORE deleting branch
- Codify in cleanup function (enforce order in code)
- Use simple-git to hide raw git commands (prevent mistakes)

**Warning signs:**
- "Branch already checked out" error when trying to delete
- Worktree directory exists but branch missing
- `git worktree list` shows worktree with no branch ref

### Pitfall 3: Concurrent Worktree Creation at Same Path

**What goes wrong:**
```
Task A leases worktree, creates branch
  │
  ├─ Task B requests lease, no available worktrees
  │  ├─ Task B checks count (4) < max (5)
  │  └─ Task B starts creating new worktree at path-5
  │
  └─ Task A returns, deletes worktree at path-5
     ├─ Task B's creation fails (path deleted mid-operation)
     └─ Task B's branch orphaned
```

**Why it happens:**
- Check-then-create isn't atomic
- No file lock between availability check and actual creation

**How to avoid:**
- **Use database transaction** for lease operation
- Increment counter atomically before creation
- Use file lock (`flock`) or git lock during creation

**Warning signs:**
- "Path already exists" or "Path doesn't exist" race errors
- Worktree creation fails intermittently
- Stale branches accumulate in `git branch -a`

### Pitfall 4: Not Pruning Stale Metadata

**What goes wrong:**
```
Crash during cleanup → worktree partially deleted
  │
  └─ Metadata remains in .git/worktrees/
     └─ `git worktree add` on new worktree mysteriously slow/fails
     └─ `git worktree list` shows phantom entries
```

**Why it happens:**
- Prune is manual operation, not automatic
- Stale entries accumulate silently

**How to avoid:**
- **Run `git worktree prune` after every cleanup**
- Include in cleanup retry logic
- Monitor `.git/worktrees/` size (accumulation warning)

**Warning signs:**
- `git worktree list` output includes phantom entries
- Git operations slow down over time
- Errors mentioning "corrupted" or "invalid" worktree

### Pitfall 5: Not Handling Process Signals During Cleanup

**What goes wrong:**
```
Cleanup in progress:
  1. Remove worktree
  2. Delete branch
  3. Prune metadata
  4. ← Process killed (SIGTERM)
     └─ Partial cleanup → corrupted state
```

**Why it happens:**
- Cleanup can take 1-5 seconds (multiple git commands)
- If process crashes mid-cleanup, orphaned state

**How to avoid:**
- **Make cleanup atomic at transaction level**
- Use database transactions for state updates
- If cleanup fails, mark as "dirty" and retry on next pool operation

**Warning signs:**
- Worktrees stuck in "dirty" status
- `git worktree repair` fixes issues between restarts
- Cleanup never completes in logs

### Pitfall 6: Exhausting Pool Without Monitoring

**What goes wrong:**
```
Pool size = 5 (pre-created)
Execute 5 tasks
  ├─ Worktree 1-5 leased
  └─ Execute 6th task → wait for available (blocks)
     └─ If task takes >1 hour, 6th task timeout

Later: Tasks 1-5 crash → orphaned in "in-use" state
  └─ Pool now empty, all tasks block forever
```

**Why it happens:**
- No monitoring of pool health
- No timeout for lease waits
- No recovery for "stuck" leases

**How to avoid:**
- **Monitor pool utilization** (log when >3/5 worktrees leased)
- **Set timeout on lease waits** (max 30s, then fail task)
- **Implement lease timeout** (if in-use for >2 hours, force return)
- **Alert on failed cleanup** (mark as dirty, increment counter)

**Warning signs:**
- Lease waits exceed 30 seconds
- "Dirty" worktree count increases
- Pool never expands even under load

---

## Code Examples

### Create Worktree (simple-git)

**Source:** Git documentation + simple-git API patterns

```typescript
// Node.js sidecar service

import SimpleGit from 'simple-git';

async function createWorktree(
  repoPath: string,
  worktreeId: string,
  taskId: i32
): Promise<{ path: string; branch: string }> {
  const git = SimpleGit(repoPath);

  const branchName = `pool/agent-task-${taskId}`;
  const worktreePath = `.worktree-pool/${worktreeId}`;

  try {
    // Create worktree with new branch
    await git.worktree(['add', worktreePath, '-b', branchName, 'main']);

    return {
      path: worktreePath,
      branch: branchName,
    };
  } catch (error) {
    throw new Error(`Failed to create worktree: ${error.message}`);
  }
}
```

### Lease Worktree from Pool (with Atomicity)

**Source:** SQLite transaction patterns

```typescript
// Rust backend (Tauri IPC handler)

#[tauri::command]
pub fn lease_worktree(
  project_id: i32,
  task_id: i32,
  state: State<Arc<AppState>>,
) -> Result<Worktree, String> {
  let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

  // Start transaction
  let tx = conn
    .transaction()
    .map_err(|e| format!("Transaction failed: {}", e))?;

  // 1. Find available worktree (FOR UPDATE to prevent race)
  let available: Option<i32> = tx.query_row(
    "SELECT id FROM worktrees
     WHERE project_id = ? AND status = 'available'
     LIMIT 1",
    [project_id],
    |row| row.get(0),
  ).ok();

  let worktree_id = if let Some(id) = available {
    id
  } else {
    // 2. Check if we can expand pool
    let count: i32 = tx.query_row(
      "SELECT COUNT(*) FROM worktrees WHERE project_id = ?",
      [project_id],
      |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    if count >= 5 {
      return Err("Worktree pool exhausted, waiting for availability".to_string());
    }

    // 3. Create new worktree entry in DB
    let now = chrono::Utc::now().to_rfc3339();
    let branch = format!("pool/agent-task-{}", task_id);
    let path = format!(".worktree-pool/wt-{:03}", count + 1);

    tx.execute(
      "INSERT INTO worktrees (project_id, branch_name, path, status, created_at)
       VALUES (?, ?, ?, 'available', ?)",
      rusqlite::params![project_id, &branch, &path, &now],
    ).map_err(|e| e.to_string())?;

    tx.last_insert_rowid() as i32
  };

  // 4. Update status to leased (atomic)
  let now = chrono::Utc::now().to_rfc3339();
  tx.execute(
    "UPDATE worktrees SET status = 'leased', leased_at = ? WHERE id = ?",
    rusqlite::params![&now, worktree_id],
  ).map_err(|e| e.to_string())?;

  // Commit transaction (atomic operation complete)
  tx.commit()
    .map_err(|e| format!("Commit failed: {}", e))?;

  // Fetch updated worktree record
  // ... query and return

  Ok(worktree)
}
```

### Return Worktree to Pool

```typescript
// Rust backend (Tauri IPC handler)

#[tauri::command]
pub fn return_worktree(
  worktree_id: i32,
  state: State<Arc<AppState>>,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

  let now = chrono::Utc::now().to_rfc3339();

  conn.execute(
    "UPDATE worktrees SET status = 'available', returned_at = ? WHERE id = ?",
    rusqlite::params![&now, worktree_id],
  ).map_err(|e| e.to_string())?;

  Ok(())
}
```

### Cleanup Worktree (Delete Branch + Remove)

**Source:** Git documentation (correct sequence)

```typescript
// Node.js sidecar service

import SimpleGit from 'simple-git';

async function cleanupWorktree(
  repoPath: string,
  worktreeId: string,
  branchName: string
): Promise<void> {
  const git = SimpleGit(repoPath);
  const worktreePath = `.worktree-pool/${worktreeId}`;

  try {
    // Step 1: Remove worktree (BEFORE deleting branch)
    await git.worktree(['remove', worktreePath]);

    // Step 2: Delete branch
    await git.branch(['-D', branchName]);

    // Step 3: Prune stale metadata
    await git.worktree(['prune']);

    console.log(`Cleaned up worktree ${worktreeId} (branch: ${branchName})`);
  } catch (error) {
    console.error(`Cleanup failed for ${worktreeId}: ${error.message}`);
    // Mark in DB as "dirty" for retry
    throw error;
  }
}
```

### List and Validate Pool Health

```typescript
// Check pool status

#[tauri::command]
pub fn get_pool_status(
  project_id: i32,
  state: State<Arc<AppState>>,
) -> Result<PoolStatus, String> {
  let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

  // Count by status
  let available: i32 = conn.query_row(
    "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'available'",
    [project_id],
    |row| row.get(0),
  ).unwrap_or(0);

  let leased: i32 = conn.query_row(
    "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'leased'",
    [project_id],
    |row| row.get(0),
  ).unwrap_or(0);

  let dirty: i32 = conn.query_row(
    "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'dirty'",
    [project_id],
    |row| row.get(0),
  ).unwrap_or(0);

  let total: i32 = available + leased + dirty;

  Ok(PoolStatus {
    total,
    available,
    leased,
    dirty,
    utilization: (leased as f64 / total as f64) * 100.0,
  })
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual git worktree commands in shell scripts | Promise-based simple-git in Node sidecar | ~2020 (npm adoption) | Better error handling, integrates with process lifecycle |
| In-memory worktree pool (list, set, map) | SQLite-persisted pool state with status tracking | 2024+ (desktop apps) | Survives crashes, enables replay/recovery |
| Synchronous `exec()` for git commands | Async `simple-git` with timeout handling | 2019+ (Node.js maturity) | Non-blocking, prevents UI freezing |
| Manual cleanup scripts on interval | Event-driven cleanup after task completion | 2023+ (container orchestration patterns) | Faster cleanup, less stale metadata |
| No pool monitoring | Alert on exhaustion, monitor dirty count | 2023+ (observability) | Prevents silent failures, unblocks stuck tasks |

**Deprecated/outdated:**
- **Git CLI via shell exec**: Replaced by simple-git (better error handling, type safety)
- **In-memory pool state**: Replaced by SQLite (persistence across restarts)
- **Manual `git worktree prune` on startup**: Should be part of every cleanup cycle (prevent accumulation)

---

## Open Questions

1. **Lease Timeout Strategy**
   - What we know: Tasks can run 1-2 hours. Worktree should be returned when task completes.
   - What's unclear: If task crashes (no explicit return), how long until lease considered expired?
   - Recommendation: Implement 2-hour lease timeout, automatic return on execution error. Mark as "dirty" if not returned by timeout.

2. **Pool Size Configuration**
   - What we know: Pre-create 3-5, expand dynamically up to 10.
   - What's unclear: Should this be configurable per project? Per task load profile?
   - Recommendation: Default 5 pre-created + 5 dynamic max. Add to project settings (Phase 7).

3. **Git Worktree Lock Usage**
   - What we know: `git worktree lock --reason` prevents external deletion.
   - What's unclear: Should we lock worktrees while in-use to prevent accidental deletion?
   - Recommendation: Lock during execution, unlock on return. Prevents external interference.

4. **Branch Naming Strategy**
   - What we know: `pool/agent-task-{taskId}` is unique per task.
   - What's unclear: What if task retried? Should we reuse branch or create new?
   - Recommendation: Delete and recreate branch on retry. Ensures clean state.

5. **Concurrent Cleanup and Allocation**
   - What we know: Cleanup is serial (one worktree at a time).
   - What's unclear: If cleanup takes 3 seconds and someone leases during cleanup, what happens?
   - Recommendation: Use database transaction to atomic transition from "dirty" to "available". Cleanup can retry asynchronously.

---

## Sources

### Primary (HIGH confidence)

- **Git worktree documentation**: https://git-scm.com/docs/git-worktree — Official git commands and guarantees
- **Context7 - simple-git** (311 snippets, High reputation): `/steveukx/git-js` — Node.js git wrapper API patterns
- **Context7 - Tauri** (16,899 snippets, High reputation): `/websites/rs_tauri_2_9_5` — Sidecar process model, IPC patterns
- **Existing schema**: `.planning/phases/01-foundation` — Already has `worktrees` table with status tracking

### Secondary (MEDIUM confidence)

- **Node.js child_process documentation**: https://nodejs.org/api/child_process.html — Process lifecycle, signal handling, resource cleanup
- **SQLite transactions**: https://sqlite.org/autoinc.html — Atomic operations for state transitions
- **Project architecture decisions** (Phase 2 research): Simple-git + Node sidecar confirmed as standard stack

---

## Metadata

**Confidence breakdown:**
- **Standard stack**: HIGH — simple-git verified via Context7, Rust sidecar architecture confirmed in Phase 1
- **Architecture patterns**: HIGH — Git worktree commands are stable APIs, state machine patterns well-established
- **Common pitfalls**: HIGH — Git documentation clearly specifies deletion ordering, concurrent access issues
- **Implementation patterns**: MEDIUM — specific to this codebase (Tauri + Node sidecar), patterns verified against official docs

**Research date:** 2026-02-05
**Valid until:** 2026-02-20 (git stable, simple-git unlikely to break; monitor Tauri 2.x updates)

**Next steps for planner:**
1. Verify SQLite schema already has `worktrees` table (confirmed ✓)
2. Design worktree IPC command handlers (create, lease, return, cleanup, status)
3. Implement Node.js sidecar git manager module
4. Plan database transaction patterns for lease/return atomicity
5. Plan monitoring/alerting for pool exhaustion and cleanup failures

---

*Research completed: 2026-02-05*
*Next phase: Planning (03-01, 03-02, 03-03)*
