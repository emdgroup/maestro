# Phase 11: Agent Execution UX Polish - Research

**Researched:** 2026-02-08
**Domain:** React UI components, real-time status display, toast notifications, CSS animations, Tauri state coordination
**Confidence:** HIGH

## Summary

Phase 11 polishes the existing agent execution workflow (from Phase 4) with visual feedback, real worktree integration, and failure notifications. The phase requires:

1. **Status badges** on TaskCard showing execution state with live elapsed time
2. **Failure notifications** combining toast alerts + persistent badges
3. **Real worktree leasing** (automatic, transparent to users)
4. **Execute button loading states** during worktree creation
5. **No new capabilities** — polish existing Phase 4 execution framework

The established approach uses:

- **React state** for elapsed time updates (1-second interval during execution)
- **CSS keyframes** for subtle pulsing animation (already used in codebase)
- **Sonner toast library** (already integrated Phase 2) for failure notifications
- **Tauri IPC** coordination between frontend button states and backend worktree leasing
- **Zustand store** for tracking execution lifecycle state

**Primary recommendation:** Implement elapsed time display with minute-granular updates, pulsing CSS animation for running badge, and automatic toast/badge notifications triggered by execution log polling (already established pattern).

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Status Visualization**
- Badge position: Top-right corner of TaskCard (floating badge, highly visible)
- States with visual treatment: Running (InProgress) and Failed only
- Animation: Pulsing badge animation for Running state (subtle, not distracting)
- Colors: Semantic colors (blue for running, red for failed)
- Elapsed time: Display live elapsed time in badge (e.g., "2m 34s")
- Success state: Badge persists with green checkmark until task moved to next column
- Post-execution: No badge after InProgress column (cleaner Review/Done views)
- Interaction: Badge is display-only (not clickable, existing card click opens history)

**Failure Notifications**
- Notification method: Badge + toast combo (toast for immediate alert, badge persists)
- Toast content: Task name + error type (e.g., "Failed: Add user auth — CompilationError")
- Duration: Auto-dismiss after 10 seconds (failed badge persists on card)
- Multiple failures: Stack toasts (Sonner default behavior, each failure visible)

**Worktree Integration**
- Worktree visibility: Hide from users (internal implementation detail)
- Lease failure handling: Retry automatically with silent worktree creation (user sees brief delay)
- Pool status: No global pool visibility (fully automatic capacity management)
- Fatal failures: Show error toast, user must manually retry Execute (clear feedback + control)
- Execute button states: Show loading spinner during lease/creation (visual feedback)
- Lease timing: Lease worktree on Execute click, before agent spawn (guarantees availability)

### Claude's Discretion

- Exact badge sizing and corner offset
- Pulse animation implementation (CSS keyframes vs JS)
- Error toast styling details (icon choice, spacing)
- Retry backoff strategy for automatic worktree creation
- Loading spinner animation style

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

</user_constraints>

## Standard Stack

### Core Frontend
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | ^19.2.4 | Component rendering with hooks (useState for elapsed time) | Project standard; already integrated |
| Zustand | ^4.5.0 | State management for execution tracking | Project standard (boardStore.ts); already manages task status |
| Sonner | ^1.5.0 | Toast notifications for failure alerts | Phase 2 integrated; already used for success/error toasts |
| @tauri-apps/api | ^2.10.1 | IPC communication for execute/lease commands | Project standard; enables worktree coordination |

### Styling & Animation
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| CSS (vanilla) | ES2023 | Keyframes, positioning, pseudo-elements | Project uses vanilla CSS; App.css already has @keyframes spin example |
| CSS variables | ES2023 | Semantic colors (--text-primary, theme colors) | Project convention; KanbanBoard.css uses extensively |

### Backend Coordination (Rust)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tokio | ^1 (full features) | Async execution, background tasks | Project standard for spawning processes |
| rusqlite | ^0.31 | Database operations (worktree tracking) | Project standard for persistence |
| Tauri | ^2 | IPC handlers for lease_worktree, spawn_agent_execution | Project standard backend framework |

### Supporting Tools
| Tool | Purpose | Current Status |
|------|---------|-----------------|
| ExecutionHistory component | Polls execution logs every 5s | Exists; triggers error toasts on "paused" status |
| TaskCard component | Renders task UI with status badges | Exists; needs elapsed time + running badge |
| boardStore.ts | Manages task status updates | Exists; executeTask already sets status to InProgress |

**No new dependencies required.** All necessary libraries are already in package.json and Cargo.toml.

## Architecture Patterns

### UI Pattern: Status Badge with Elapsed Time

**Location:** Top-right corner of TaskCard (position: absolute inside task-card, top: 8px, right: 8px)

**Implementation approach:**
```typescript
// TaskCard component
const [elapsedTime, setElapsedTime] = useState<string>("0s");

useEffect(() => {
  if (task.status !== 'InProgress') return;

  const interval = setInterval(() => {
    // Calculate from task.started_at (from execution log)
    // Format: "2m 34s" (minute-granular display)
    setElapsedTime(formatElapsedTime(task.started_at));
  }, 1000); // Update every second

  return () => clearInterval(interval);
}, [task.status, task.started_at]);
```

**Badge states:**
- InProgress: Blue badge with pulsing animation, displays elapsed time + spinner icon
- Failed: Red badge (semantic color from Phase 8), no animation
- Success (Complete in InProgress column): Green badge with checkmark, no animation
- All other states: No badge

### CSS Animation Pattern

**Pulsing badge (Running state):**
```css
@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.badge-running {
  animation: pulse-badge 1.5s ease-in-out infinite;
}
```

**Rationale:** Subtle opacity change (not scale/color shift) — non-distracting per user requirement; 1.5s period is standard UI pattern.

### Toast Notification Pattern

**Failure notifications trigger from ExecutionHistory polling:**

Current code (ExecutionHistory.tsx, lines 63-74) already detects "paused" status changes and shows error toast. Phase 11 extends this:

```typescript
// When execution log transitions to Failed status
const failedLogs = logs.filter(
  log => log.status === 'Failed' &&
         !previousLogs.find(p => p.id === log.id && p.status === 'Failed')
);

if (failedLogs.length > 0) {
  failedLogs.forEach(log => {
    const errorType = log.error_event?.error_type || 'Unknown Error';
    const message = `Failed: ${taskName} — ${errorType}`;
    toast.error(message, { duration: 10000 }); // 10s auto-dismiss
  });
}
```

**Toast stacking:** Sonner's visibleToasts setting (currently 3 in ErrorToast.tsx) handles stacking automatically.

### Worktree Leasing Integration Pattern

**Current state (Phase 4):** spawn_agent_execution handler exists in src-tauri/src/ipc/handlers.rs (line 10)

**Phase 11 requirement:** Call lease_worktree before spawning agent

**Execution flow:**
```rust
#[tauri::command]
pub async fn spawn_agent_execution(
  project_id: i32,
  task_id: i32,
  repo_path: String,
) -> Result<i32, String> {
  // 1. Lease worktree (automatic, transparent)
  let worktree = lease_worktree(project_id, task_id, &repo_path).await?;

  // 2. Update task status to InProgress (frontend)
  // 3. Spawn agent in background (existing logic)
  // 4. Return worktree to pool when done (existing logic)
}
```

**Frontend coordination:**
```typescript
// TaskCard: Show loading spinner during Execute click
const [isExecuting, setIsExecuting] = useState(false);

const handleExecute = async () => {
  setIsExecuting(true); // Shows spinner in button
  try {
    await store.executeTask(...);
  } finally {
    setIsExecuting(false);
  }
};
```

**Button visual states (already implemented in TaskCard.tsx lines 223-240):**
- Ready state: "Execute" button (blue)
- Loading state: "Executing..." button (grayed, spinner)
- Returns to normal when task transitions to InProgress

### Execution History Coordination

**Pattern:** ExecutionHistory component polls every 5 seconds (line 50), checks for status changes, triggers toasts.

Phase 11 extends to watch for:
1. Running → Complete transitions (show success badge on card)
2. Running → Failed transitions (show failure badge + toast)
3. Failed status with error_event present (extract error_type for toast message)

**No UI modal needed** — existing ExecutionHistory component in modal handles detailed view.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Toast notifications | Custom toast + portal | Sonner library (already in deps) | Handles stacking, auto-dismiss, accessibility, animation |
| Elapsed time formatting | Naive date math | Existing chrono-based logic in backend + simple frontend calculation | Edge cases: DST, timezone, leap seconds |
| Pulsing animation | Inline style animation in JS | CSS @keyframes | Better performance, easier to tune, works with browser devtools |
| Worktree leasing retry logic | Custom retry in IPC handler | Tokio + backoff crate (if needed) | Exponential backoff, circuit breaking already proven patterns |
| Execution state polling | Websocket + server push | REST polling (already established) | Simpler for Tauri's IPC model; 5s interval is acceptable for user experience |
| Badge positioning | Flex/grid magic | position: absolute in top-right corner | Simplest, doesn't affect card layout, standard UI pattern |

**Key insight:** UI polish relies on coordination between frontend state (elapsed time) and backend notifications (error events in execution logs). Don't add complexity with custom solutions — leverage existing Sonner integration and CSS features already proven in the codebase (spinner animation in App.css).

## Common Pitfalls

### Pitfall 1: Elapsed Time Sync Issues

**What goes wrong:** Frontend calculates elapsed time from task.started_at, but if task is fetched from database at different times or execution log polling is delayed, displayed time appears to jump backward or freeze.

**Why it happens:** Started timestamp is single ISO 8601 string from database; frontend updates continuously on 1-second interval. Clock skew between database server and client can cause inconsistencies.

**How to avoid:**
- Always calculate elapsed time as `Date.now() - new Date(task.started_at).getTime()`
- Verify started_at is set synchronously when task transitions to InProgress (in boardStore.ts executeTask)
- Format granularly (minutes.seconds) to hide sub-second jitter

**Warning signs:** Elapsed time displays "2m 45s" then suddenly shows "2m 40s" (backward), or stays frozen for >5 seconds (polling delay).

### Pitfall 2: Pulsing Animation Distraction

**What goes wrong:** Rapid pulsing (0.5s-1s animation) draws excessive attention, distracts from reviewing other tasks on board.

**Why it happens:** Common mistake is copying web frameworks' pulse utilities which default to very rapid rates; or using scale/color shifts instead of opacity changes.

**How to avoid:**
- Use 1.5s-2s animation period (slow, subtle)
- Use opacity changes only (0.7 → 1.0) — not scale, color, or shadow
- Test on actual Kanban board with 10+ tasks to verify non-distracting

**Warning signs:** After 30 seconds of looking at board, eyes are drawn to badge instead of task content; animation feels "jumpy."

### Pitfall 3: Toast Message Overflow

**What goes wrong:** Error message in toast is too long (e.g., full error stack trace), gets cut off or breaks layout.

**Why it happens:** Phase decision specifies format "Failed: [Task name] — [Error type]" but implementer includes full error details or stack trace.

**How to avoid:**
- Strict message format: `Failed: ${taskName} — ${errorEvent.error_type}`
- Never include error_event.message or suggestions in toast (that's for modal detail view)
- Test with longest realistic task name + error type (e.g., "Failed: Implement OAuth2 provider for microservice — CompilationError")
- Verify message fits in Sonner's max-width (typically 360px)

**Warning signs:** Toast appears cut off at edge of screen; text wraps to 3+ lines.

### Pitfall 4: Badge Click Interfering with Card Click

**What goes wrong:** User clicks badge (intending just to dismiss it), accidentally opens ExecutionHistory modal.

**Why it happens:** Badge is positioned absolutely inside task-card, but card's onClick handler still fires due to event bubbling.

**How to avoid:**
- Badge must be `pointer-events: none` (not clickable per user spec: "display-only")
- If badge uses clickable elements (e.g., checkmark icon), add `stopPropagation()` to its click handler
- Test: Click badge → verify ExecutionHistory modal does NOT open

**Warning signs:** Users report "clicking badge opened history unexpectedly."

### Pitfall 5: Worktree Lease Timeout Handling

**What goes wrong:** User clicks Execute, sees loading spinner, but never sees execution start. Worktree lease fails silently or exceeds max retries.

**Why it happens:** lease_worktree has timeout logic, but error is not properly surfaced to Execute button or shown in toast.

**How to avoid:**
- Per phase requirement: fatal failures show error toast, user must retry Execute
- Ensure ExecuteTask IPC handler catches lease_worktree errors and throws them (not silently fails)
- Frontend TaskCard.handleExecute must catch error and show toast (already does, lines 50-51)
- Test: Simulate pool exhaustion → verify toast appears: "Failed to start execution: Pool exhausted..."

**Warning signs:** Users see "Executing..." button hang indefinitely with no feedback.

## Code Examples

### Example 1: Elapsed Time Display in TaskCard

```typescript
// Source: Phase 4 execution_log.rs shows started_at ISO 8601 timestamp
// Frontend uses this to display elapsed time

import { useEffect, useState } from 'react';

function formatElapsedTime(startedAtIso: string): string {
  const start = new Date(startedAtIso).getTime();
  const now = Date.now();
  const diffMs = now - start;

  if (diffMs < 1000) return '0s';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// In TaskCard component
const [elapsedTime, setElapsedTime] = useState('0s');

useEffect(() => {
  if (task.status !== 'InProgress') return;

  const interval = setInterval(() => {
    // Get started_at from execution log (fetched via API)
    const started = task.execution_log?.started_at || task.created_at;
    setElapsedTime(formatElapsedTime(started));
  }, 1000);

  return () => clearInterval(interval);
}, [task.status, task.execution_log?.started_at]);
```

### Example 2: Pulsing Badge CSS

```css
/* Source: App.css @keyframes spin pattern */

@keyframes pulse-badge {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.badge-running {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background-color: #3b82f6; /* Blue for running */
  color: white;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  position: absolute;
  top: 8px;
  right: 8px;
  animation: pulse-badge 1.5s ease-in-out infinite;
  pointer-events: none;
  z-index: 10;
}

.badge-failed {
  /* Existing Phase 8 colors */
  background-color: #fee2e2;
  color: #991b1b;
  animation: none; /* No animation for failed */
}

.badge-success {
  /* Green checkmark for successful execution in InProgress column */
  background-color: #dcfce7;
  color: #166534;
  animation: none;
}
```

### Example 3: Failure Toast Pattern

```typescript
// Source: ExecutionHistory.tsx lines 63-74, extended for Phase 11
// In ExecutionHistory component polling loop

const previousLogsRef = useRef<ExecutionLog[]>([]);

useEffect(() => {
  loadExecutionLogs();
  const interval = setInterval(loadExecutionLogs, 5000);
  return () => clearInterval(interval);
}, [taskId]);

const loadExecutionLogs = async () => {
  const logs = await invoke<ExecutionLog[]>('get_execution_logs', { task_id: taskId });
  const previousLogs = previousLogsRef.current;

  // Detect NEW failed logs
  const newFailedLogs = logs.filter(log =>
    log.status === 'Failed' &&
    !previousLogs.find(p => p.id === log.id && p.status === 'Failed')
  );

  newFailedLogs.forEach(log => {
    const errorType = log.error_event?.error_type || 'Unknown Error';
    const message = `Failed: ${taskName} — ${errorType}`;
    toast.error(message, { duration: 10000 }); // 10s auto-dismiss
  });

  previousLogsRef.current = logs;
  setLogs(logs);
};
```

### Example 4: Execute Button Loading State

```typescript
// Source: TaskCard.tsx lines 223-240, verified pattern

const [isExecuting, setIsExecuting] = useState(false);

const handleExecute = async () => {
  setIsExecuting(true);
  try {
    const executionLogId = await store.executeTask(
      task.project_id,
      task.id,
      projectPath
    );
    showSuccessToast(`Execution started for "${task.name}"`);
  } catch (error) {
    showErrorToast(`Failed to start execution: ${error}`);
  } finally {
    setIsExecuting(false);
  }
};

return (
  <button
    onClick={handleExecute}
    disabled={isExecuting}
    style={{
      backgroundColor: isExecuting ? '#ccc' : '#0066cc',
      cursor: isExecuting ? 'not-allowed' : 'pointer',
    }}
  >
    {isExecuting ? 'Executing...' : 'Execute'}
  </button>
);
```

### Example 5: Worktree Leasing in Rust Handler

```rust
// Source: src-tauri/src/ipc/handlers.rs lease_worktree (lines 683-760)
// Phase 11 integration: call lease_worktree before spawning agent

#[tauri::command]
pub async fn spawn_agent_execution(
  state: State<Arc<AppState>>,
  project_id: i32,
  task_id: i32,
  repo_path: String,
) -> Result<i32, String> {
  // 1. Lease worktree (Phase 11 requirement: do this on Execute click)
  let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
  let worktree = lease_worktree(&conn, project_id, task_id, &repo_path)?;
  drop(conn); // Release lock before async spawn

  // 2. Create execution log (existing code)
  let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
  let exec_log = create_execution_log(&conn, task_id)?;
  let exec_id = exec_log.id;
  drop(conn);

  // 3. Spawn agent in background (existing code)
  tokio::spawn(async move {
    let result = run_agent_process(&worktree.path, task_id).await;

    // Update DB (existing code)
    let conn = state.db.lock().unwrap();
    update_execution_log(&conn, exec_id, result).ok();

    // Return worktree to pool (existing code)
    return_worktree(&conn, worktree.id).ok();
  });

  Ok(exec_log.id)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Inline style animation | CSS @keyframes in dedicated file | React/CSS best practices | Better performance, easier to maintain |
| Toast notifications | Custom Zustain actions + UI | Sonner library adoption (Phase 2) | Consistent UX, accessibility, stacking |
| Elapsed time in log (static) | Live elapsed time display (React state) | Phase 11 requirement | Better UX for long-running tasks |
| Manual worktree management | Automatic leasing on Execute (Phase 11) | Worktree pool matured (Phase 3) | Transparent to users, less manual control |
| Execution status polling (slow) | Continue 5s polling (ExecutionHistory) | Existing pattern proven | Acceptable latency for user experience |

**Deprecated/outdated:**
- None in this phase — polishing existing proven patterns, not replacing them.

## Open Questions

1. **Execution log started_at format consistency**
   - What we know: ExecutionLog.started_at is ISO 8601 RFC3339 string (CLAUDE.md, line 77)
   - What's unclear: Does execution log started_at include microseconds? Should frontend round to seconds?
   - Recommendation: Treat as Date.parse-able ISO string; formatElapsedTime handles any precision. Verify in integration testing.

2. **Worktree lease timeout retry strategy**
   - What we know: User decisions say "retry automatically with silent worktree creation" and "show error toast if fatal"
   - What's unclear: How many automatic retries? Backoff strategy (linear/exponential)? When is it "fatal"?
   - Recommendation: Start with 3 retries with 500ms exponential backoff; if still fails, show toast and let user manually retry Execute. Refine based on testing.

3. **Badge on InProgress column only**
   - What we know: Phase decisions say "No badge after InProgress column (cleaner Review/Done views)"
   - What's unclear: When task moves from InProgress to Review, does badge disappear instantly or fade?
   - Recommendation: Badge renders only when task.status === 'InProgress'. No animation on state transition (instant hide).

4. **Elapsed time persistence in modal**
   - What we know: ExecutionHistory modal shows execution logs with their own durations
   - What's unclear: Should live elapsed time badge update WHILE ExecutionHistory modal is open?
   - Recommendation: Yes, update every 1s. Modal doesn't close badge display; they work independently.

## Sources

### Primary (HIGH confidence)

- **CLAUDE.md** - Project architecture: ExecutionLog model (started_at, status, error_event), Zustand store patterns, Tauri IPC handlers
- **src/components/TaskCard.tsx** - Current button loading states (isExecuting pattern), status badge implementation
- **src/components/ExecutionHistory.tsx** - Polling pattern (5s interval), error detection, toast triggering
- **src/store/boardStore.ts** - Zustand state management with Immer, executeTask method
- **src/styles/KanbanBoard.css** - CSS variable system, badge positioning patterns
- **src/App.css** - @keyframes spin animation (proven pattern for rotating spinners)
- **package.json** - Sonner ^1.5.0, React ^19.2.4, Zustand ^4.5.0 confirmed
- **src/components/ErrorToast.tsx** - Sonner configuration (visibleToasts: 3, position: bottom-right)
- **src-tauri/src/ipc/handlers.rs** - lease_worktree function (lines 683-760), spawn_agent_execution dispatch point
- **src-tauri/src/models/execution_log.rs** - ExecutionLog struct with ExecutionStatus enum (Running, Complete, Failed, Paused)

### Secondary (MEDIUM confidence)

- **Sonner documentation** - Toast stacking behavior, duration settings, accessibility features (verified against package.json version ^1.5.0)
- **React hooks patterns** - useEffect with interval cleanup (standard React pattern, well-documented)
- **CSS animation performance** - @keyframes better than JS animation (browser devtools verified, industry standard)

### Tertiary (Notes, not independent sources)

- Phase 4 RESEARCH.md - ExecutionLog model design and worktree integration patterns

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** - All libraries verified in package.json/Cargo.toml; Sonner already integrated Phase 2
- Architecture: **HIGH** - Patterns proven in TaskCard, ExecutionHistory, boardStore; lease_worktree function exists and documented
- Pitfalls: **MEDIUM** - Drawn from UI/animation best practices and codebase patterns; some assumptions about max retries and backoff strategy

**Research date:** 2026-02-08
**Valid until:** 2026-02-22 (14 days — stable tech stack, unlikely to change)
**Assumptions:**
- Sonner toast stacking will continue to work at visibleToasts: 3 limit
- ExecutionHistory polling every 5s is sufficient for failure detection latency
- Database execution_log.started_at is reliably set when task transitions to InProgress
