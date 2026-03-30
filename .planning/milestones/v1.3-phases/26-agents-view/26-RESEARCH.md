# Phase 26: Agents View - Research

**Researched:** 2026-03-29
**Domain:** React frontend wiring — TanStack Query, xterm.js lifecycle, Zustand navigation, Tauri IPC
**Confidence:** HIGH

## Summary

Phase 26 is pure frontend wiring with zero new Rust work. The IPC command `list_executions_with_task_info` is already registered and the TypeScript binding `ExecutionWithTask` is already in `bindings.ts`. The real xterm.js component (`TerminalComponent` in `Terminal.tsx`) is fully implemented with attach/detach/resize/input. All patterns needed (TanStack Query hooks, ToggleGroup filter bar, navigationStore deep-link) already exist in the codebase.

The work is: (1) add one `useQuery` hook to `execution.service.ts`, (2) rewrite `AgentMonitor.tsx` with a real sidebar + `DeadSessionTerminal`, and (3) rewire `AgentsView.tsx` to own the query and pass props down. No new libraries, no new IPC, no Rust changes.

**Primary recommendation:** Follow the existing `KanbanView` action-bar pattern exactly. Key the terminal pane by `task_id` to let React handle terminal instance lifecycle automatically. Use `DeadSessionTerminal` (new component) for non-Running executions — mirrors `TerminalComponent` structure but writes DB history instead of attaching.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Sidebar row layout:**
- Three-line rows: Line 1: status dot + task name (truncated). Line 2: status label + elapsed time. Line 3: branch name in monospace.
- Sidebar width: `w-72`
- Selected row: Left-border accent highlight (Linear-style), not background fill
- Elapsed time format: Duration only — `"Running · 3m 42s"` for active, `"Done · 3m 42s"` for finished. Consistent format regardless of session state.

**Filter toolbar:**
- Combined row below the sidebar header: search input on the left, status filter chips on the right — same action bar pattern as the KanbanView (`h-12 border-b border-border bg-muted/30`, `Input` + `ToggleGroup`/`ToggleGroupItem`)
- Filter chips: All / Running / Done / Failed — client-side filtering of the full `ExecutionWithTask[]` list
- Search: Filters by task name, client-side

**Dead session terminal handling:**
- Separate component: Render `DeadSessionTerminal` (new component) for non-Running executions. Keep `TerminalComponent` (xterm.js live) unchanged — no new props added to it.
- `DeadSessionTerminal` behavior: Mounts xterm.js, writes `terminal_output` (from `ExecutionWithTask`) on mount via `terminal.write()`, then disposes on unmount. Does NOT call `attachTerminal`.
- Session ended banner: A slim bar above the xterm div — `"Session ended · {completedAt} · {duration}"` for Done, `"Session failed · {completedAt}"` for Failed.
- Null `terminal_output`: Renders empty xterm + banner. No special case — consistent path.
- xterm.js lifecycle: Both `TerminalComponent` and `DeadSessionTerminal` call `terminal.dispose()` and cleanup on unmount. `TerminalComponent` also calls `detach_terminal` IPC on unmount.

**Empty / no-selection state:**
- Right pane (no selection): Centered muted text — `"Select an agent to view its terminal"` — no illustration, no CTA
- Sidebar no results: `"No agents match your filter"` in `text-xs text-muted-foreground`, centered within the list area

**Data and lifecycle:**
- `useExecutionsWithTaskInfoQuery(projectId)` added to `execution.service.ts` — 2-second refetch interval (REQ-16)
- `AgentsView.tsx` owns TanStack Query call, passes `ExecutionWithTask[]` as props to `AgentMonitor` — no direct IPC inside `AgentMonitor` (REQ-24)
- Terminal keyed by `task_id` — switching selection calls `detach_terminal` on previous and mounts new terminal (REQ-22)
- Deep link: `pendingAgentId` from `navigationStore` used for initial selection on mount; fallback to most-recent Running execution (REQ-23)

### Claude's Discretion
- Exact Tailwind classes for the status dot colors (Running/Done/Failed/Paused)
- Whether elapsed time for active sessions updates via `setInterval` in the row or is derived from the 2-second query refresh
- Error state when `listExecutionsWithTaskInfo` query fails

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-16 | `useExecutionsWithTaskInfoQuery(projectId)` hook in `execution.service.ts`; 2-second refetch; returns `ExecutionWithTask[]` | `useQuery` pattern verified in existing service; `api.listExecutionsWithTaskInfo` binding confirmed at line 423 of `bindings.ts` |
| REQ-17 | `AgentMonitor.tsx` rewritten with real sidebar from `ExecutionWithTask[]`; three-line rows; status dot, task name, status label + elapsed, branch | `ExecutionWithTask` type confirmed in `bindings.ts` line 991; existing placeholder AgentMonitor identified as full rewrite target |
| REQ-18 | Mixed list (active + history) sorted by `started_at` descending; no separate tabs | Sort is applied client-side to the `ExecutionWithTask[]` array; `started_at` field confirmed on type |
| REQ-19 | Status filter chips All/Running/Done/Failed + task name search, client-side | ToggleGroup + Input pattern confirmed in KanbanView lines 44-87; `ExecutionStatus` type confirms valid statuses |
| REQ-20 | Clicking row mounts `TerminalComponent` keyed by `task_id`; previous channel detached | `TerminalComponent` confirmed functional; key-by-task_id forces React remount on selection change |
| REQ-21 | Non-Running executions: skip `attach_terminal`; write `terminal_output` from DB via `terminal.write(history)`; show "Session ended" notice | `terminal_output` field confirmed nullable on `ExecutionWithTask`; `DeadSessionTerminal` mirrors `TerminalComponent` structure |
| REQ-22 | `useEffect` cleanup: always calls `terminal.dispose()`, `fitAddon` cleanup, `ResizeObserver.disconnect()`, `detach_terminal` IPC | `TerminalComponent` confirmed uses `terminal.dispose()` on unmount; needs `fitAddon` + `ResizeObserver` + `detach_terminal` additions |
| REQ-23 | `pendingAgentId` from `navigationStore` for initial selection; fallback to most-recent Running execution | `usePendingAgentId` + `clearPendingAgent` confirmed exported from `navigationStore.ts`; `pendingAgentId` is `string | null` so requires `Number()` conversion |
| REQ-24 | `AgentsView.tsx` owns TanStack Query call; passes data as props; no direct IPC in `AgentMonitor` | `AgentsView.tsx` currently accepts props-down pattern — rewrite to own query and pass down |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@xterm/xterm` | 6.0.0 | Real terminal emulator | Already installed; `Terminal.tsx` uses it fully |
| `@xterm/addon-fit` | 0.11.0 | Fit terminal to container | Already installed; used in `Terminal.tsx` |
| `@tanstack/react-query` | 5.95.2 | Server-state and refetch intervals | Already used project-wide; all data hooks follow this pattern |
| `zustand` | 4.5.7 | Client state (navigation, selection) | navigationStore drives tab routing and pendingAgentId |
| `date-fns` | 4.1.0 | Elapsed time formatting | Already installed; `formatDuration`, `intervalToDuration`, `differenceInSeconds` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@xterm/addon-attach` | 0.12.0 | WebSocket-based attach addon | Already installed but NOT used — Tauri IPC channel pattern replaces it |
| `lucide-react` | 1.7.0 | Status icons | Already project standard; use for any supplementary icons in sidebar |

**Installation:** No new installs required. All dependencies are present.

## Architecture Patterns

### Recommended Project Structure

No new directories needed. Files to create or modify:

```
src/
├── services/
│   └── execution.service.ts      # ADD: useExecutionsWithTaskInfoQuery hook
├── views/
│   └── AgentsView.tsx            # REWRITE: owns query, passes props
└── components/execution/
    ├── AgentMonitor.tsx           # REWRITE: real sidebar + terminal routing
    ├── Terminal.tsx               # READ-ONLY: use as-is for Running executions
    ├── DeadSessionTerminal.tsx    # NEW: xterm for completed/failed executions
    └── ExecutionTerminal.tsx      # DO NOT USE OR MODIFY (old pre-based modal)
```

### Pattern 1: TanStack Query Hook with Refetch Interval

**What:** `useQuery` wrapping `api.listExecutionsWithTaskInfo(projectId)` with 2-second polling.
**When to use:** All live-data sidebar queries that need auto-refresh.

```typescript
// Source: src/services/execution.service.ts (existing mutation pattern adapted to query)
export const executionQueryKeys = {
  all: ["executions"] as const,
  withTaskInfo: (projectId: number) =>
    [...executionQueryKeys.all, "withTaskInfo", projectId] as const,
};

export function useExecutionsWithTaskInfoQuery(projectId: number | undefined) {
  return useQuery({
    queryKey: executionQueryKeys.withTaskInfo(projectId ?? 0),
    queryFn: () => api.listExecutionsWithTaskInfo(projectId!),
    enabled: projectId != null,
    refetchInterval: 2000,
  });
}
```

### Pattern 2: AgentsView as Data Owner (Props-Down)

**What:** `AgentsView.tsx` calls the query, derives selected execution state, passes everything as props to `AgentMonitor`.
**When to use:** All view-level components follow this pattern — views fetch, components render.

```typescript
// Source: Pattern from KanbanView.tsx + BacklogView/BacklogTaskSheet pattern
export const AgentsView: React.FC<{ projectId?: number }> = ({ projectId }) => {
  const { data: executions = [] } = useExecutionsWithTaskInfoQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  // Deep-link: pendingAgentId overrides selection on first mount
  useEffect(() => {
    if (pendingAgentId) {
      const match = executions.find((e) => String(e.task_id) === pendingAgentId);
      if (match) {
        setSelectedTaskId(match.task_id);
        clearPendingAgent();
      }
    } else if (selectedTaskId == null) {
      // Fallback: auto-select most recent Running execution
      const running = executions.find((e) => e.status === "running");
      if (running) setSelectedTaskId(running.task_id);
    }
  }, [executions, pendingAgentId, clearPendingAgent, selectedTaskId]);

  return (
    <AgentMonitor
      executions={executions}
      selectedTaskId={selectedTaskId}
      onSelect={setSelectedTaskId}
    />
  );
};
```

### Pattern 3: Terminal Keyed by task_id

**What:** Render `TerminalComponent` (Running) or `DeadSessionTerminal` (Done/Failed) with `key={selectedTaskId}`. React's key mechanism forces a full unmount+remount on selection change, triggering cleanup in the previous terminal's `useEffect` return.
**When to use:** Any time you need to replace a live resource (terminal, connection) on item switch.

```typescript
// Source: React key pattern — verified approach
const selectedExecution = executions.find((e) => e.task_id === selectedTaskId);

// In JSX:
{selectedExecution?.status === "running" ? (
  <TerminalComponent key={selectedExecution.task_id} taskId={selectedExecution.task_id} />
) : selectedExecution ? (
  <DeadSessionTerminal
    key={selectedExecution.task_id}
    execution={selectedExecution}
  />
) : (
  <div className="...">Select an agent to view its terminal</div>
)}
```

### Pattern 4: DeadSessionTerminal — xterm.js Write-then-Dispose

**What:** Mirrors `TerminalComponent` structure exactly but skips `attachTerminal` and writes DB-stored `terminal_output` once on mount.
**Critical detail:** `terminal.write()` is async under the hood — it queues writes. The `dispose()` call must happen in the `useEffect` cleanup (on unmount), not immediately after `write()`. Both operations are safe because `write()` queues before dispose.

```typescript
// Source: @xterm/xterm Terminal API (verified behavior from Terminal.tsx usage)
export function DeadSessionTerminal({ execution }: { execution: ExecutionWithTask }) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!terminalRef.current) return;
    const terminal = new Terminal({ cursorBlink: false, fontSize: 14, scrollback: 5000 });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();

    if (execution.terminal_output) {
      terminal.write(execution.terminal_output);
    }

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(terminalRef.current);

    return () => {
      observer.disconnect();
      terminal.dispose();
    };
  }, [execution.id]); // keyed by execution.id — remounts if different execution shown

  // Render: slim banner above xterm div
  return (
    <div className="flex flex-col h-full">
      <SessionEndedBanner execution={execution} />
      <div ref={terminalRef} style={{ flex: 1, overflow: "hidden" }} />
    </div>
  );
}
```

### Pattern 5: Filter + Search (Client-Side)

**What:** Filter chips and search input both derive from the full `ExecutionWithTask[]` passed as props. No secondary state fetch — pure array filter.
**When to use:** All sidebar filter patterns in this app follow this approach.

```typescript
// Derived filtered list — no useEffect needed
const STATUS_FILTERS = ["All", "running", "complete", "failed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const filteredExecutions = executions
  .filter((e) =>
    statusFilter === "All" ? true : e.status === statusFilter
  )
  .filter((e) =>
    search.trim() === "" ? true : e.task_name.toLowerCase().includes(search.toLowerCase())
  );
```

### Pattern 6: Elapsed Time Display

**What:** Duration string derived from `started_at` and `completed_at` fields.
**Decision (Claude's discretion):** Derive from the 2-second query refresh rather than a `setInterval`. Running executions get a fresh `started_at` on each query tick, so the elapsed time updates automatically with the polling. This avoids a separate timer.

```typescript
// Source: date-fns already installed
import { formatDistanceStrict } from "date-fns";

function formatElapsed(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt);
  const end = completedAt ? new Date(completedAt) : new Date();
  return formatDistanceStrict(start, end); // e.g. "3 minutes"
}
// Usage: `"Running · 3 minutes"` or `"Done · 3 minutes"`
```

### Pattern 7: Left-Border Selected Row (Linear-Style)

**What:** Selected sidebar row uses `border-l-2 border-ring` accent, not background fill. All other rows use `border-l-2 border-transparent` to maintain consistent layout.
**When to use:** Any list where the selected state needs to communicate without a heavy background fill.

```typescript
// Tailwind classes for row selection state
const rowClass = (isSelected: boolean) =>
  cn(
    "pl-3 pr-3 py-3 cursor-pointer border-l-2 transition-colors",
    isSelected
      ? "border-ring bg-muted/20"   // subtle bg + accent border
      : "border-transparent hover:bg-muted/10"
  );
```

### Pattern 8: Status Dot Colors (Claude's Discretion)

Recommended Tailwind classes for status dots, aligned to existing `AgentMonitor.tsx` palette:

| Status | Dot Class |
|--------|-----------|
| `running` | `bg-warning animate-pulse` |
| `complete` | `bg-success` |
| `failed` | `bg-destructive` |
| `paused` | `bg-muted-foreground` |
| `cancelled` | `bg-muted` |

### Pattern 9: REQ-22 Full Cleanup in TerminalComponent

The existing `Terminal.tsx` `useEffect` cleanup **only calls `terminal.dispose()`**. It does NOT call `detach_terminal` IPC or disconnect a `ResizeObserver`. The rewrite of `TerminalComponent` for REQ-22 compliance must add:

1. `api.detachTerminal(taskId)` in the cleanup
2. `ResizeObserver.disconnect()` if a ResizeObserver is added for the fit behavior

The current Terminal.tsx comment says "Channel drop is implicit" — this is the channel GC path, but `detach_terminal` IPC must still be called explicitly per REQ-22.

### Anti-Patterns to Avoid

- **IPC inside AgentMonitor:** `AgentMonitor` must receive `ExecutionWithTask[]` as props. No `useQuery`, no `api.*` calls inside it (REQ-24).
- **Using `ExecutionTerminal.tsx`:** The old `<pre>`-based modal component. Context explicitly marks it as not to be used or modified. It uses `api` from `@/lib` but is pre-xterm.
- **Background fill for row selection:** User explicitly chose left-border accent (Linear-style). Do not use `bg-accent/10` background as the primary selection signal.
- **Calling `attach_terminal` for non-Running executions:** Dead sessions must not attempt to attach — the PTY session no longer exists and the call will error.
- **`setInterval` for elapsed time:** Derive from the 2-second query refresh instead (Claude's discretion decision above).
- **`ResizeObserver` leak:** Both `TerminalComponent` and `DeadSessionTerminal` must call `observer.disconnect()` in cleanup. Forgetting this is a common source of memory leaks when components remount frequently.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Elapsed time formatting | Custom duration formatter | `formatDistanceStrict` from `date-fns` | Handles all edge cases (pluralization, rounding); already installed |
| Filter + search state | Custom filter reducer | Plain array `.filter()` derived inline | Simplest approach; no external state needed; data is small |
| xterm.js terminal | Custom textarea + ANSI parser | `@xterm/xterm` `Terminal` + `FitAddon` | Already implemented in `Terminal.tsx`; ANSI codes require a real terminal emulator |
| TanStack Query polling | `setInterval` + `useState` | `useQuery` with `refetchInterval: 2000` | Handles cache, loading/error states, deduplication automatically |

## Common Pitfalls

### Pitfall 1: terminal.dispose() Called While Write is Queued
**What goes wrong:** Calling `terminal.dispose()` synchronously after `terminal.write(output)` in `DeadSessionTerminal` may cancel queued writes before they render.
**Why it happens:** `Terminal.write()` is asynchronous and queues data. `dispose()` cancels pending writes.
**How to avoid:** Call `dispose()` only in the `useEffect` cleanup function (on unmount), never inline after `write()`. The component will remain mounted long enough for the write to flush.
**Warning signs:** Blank terminal even when `terminal_output` is non-null.

### Pitfall 2: ResizeObserver Not Disconnected on Unmount
**What goes wrong:** `ResizeObserver` callbacks fire on a disposed terminal, causing `Cannot read properties of null` errors and memory leaks.
**Why it happens:** The observer is attached to the DOM node. If the component unmounts (e.g., user switches selections rapidly), the observer continues firing against a disposed terminal.
**How to avoid:** Always call `observer.disconnect()` in the `useEffect` return before `terminal.dispose()`.
**Warning signs:** Console errors about null xterm state after rapid sidebar row clicking.

### Pitfall 3: pendingAgentId Type Mismatch
**What goes wrong:** `pendingAgentId` from `navigationStore` is `string | null`. `ExecutionWithTask.task_id` is `number`. Direct comparison `e.task_id === pendingAgentId` will always be false.
**Why it happens:** `navigate({ agentId: "7" })` stores a string; bindings return numbers.
**How to avoid:** Always convert: `String(e.task_id) === pendingAgentId` or `e.task_id === Number(pendingAgentId)`.
**Warning signs:** Deep-link navigation to Agents view shows no selection despite matching execution in the list.

### Pitfall 4: Stale selectedTaskId After executions Refetch
**What goes wrong:** `selectedTaskId` remains set to a task that has since been deleted or whose execution no longer appears in the list. The terminal pane tries to render a non-existent execution.
**Why it happens:** 2-second refetch may return a shorter list as old executions age out (if pagination is ever added) or if the backend prunes records.
**How to avoid:** Derive `selectedExecution` as `executions.find(e => e.task_id === selectedTaskId)`. If the result is `undefined`, render the empty state instead of crashing.
**Warning signs:** `selectedExecution` is `undefined` despite `selectedTaskId` being non-null.

### Pitfall 5: FitAddon.fit() Called Before Terminal is Opened
**What goes wrong:** `fitAddon.fit()` throws or silently fails if called before `terminal.open(container)`.
**Why it happens:** Misordering of initialization steps.
**How to avoid:** Always: `terminal.open(ref)` → `fitAddon.fit()` → set up ResizeObserver. This order is established in the existing `Terminal.tsx` and must be replicated in `DeadSessionTerminal`.

### Pitfall 6: detach_terminal Called on Dead Sessions
**What goes wrong:** Calling `api.detachTerminal(taskId)` for a session where no PTY exists will return an error. This may pollute the console or trigger error toasts.
**Why it happens:** `TerminalComponent` cleanup calls `detach_terminal`. If `TerminalComponent` is ever accidentally rendered for a non-Running execution and then unmounts, the IPC call errors.
**How to avoid:** Only render `TerminalComponent` for `execution.status === "running"`. `DeadSessionTerminal` must NEVER call `detach_terminal`.

## Code Examples

Verified patterns from official sources:

### useExecutionsWithTaskInfoQuery Hook
```typescript
// Source: execution.service.ts (following existing useMutation pattern)
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib";

const executionQueryKeys = {
  all: ["executions"] as const,
  withTaskInfo: (projectId: number) =>
    [...executionQueryKeys.all, "withTaskInfo", projectId] as const,
};

export function useExecutionsWithTaskInfoQuery(projectId: number | undefined) {
  return useQuery({
    queryKey: executionQueryKeys.withTaskInfo(projectId ?? 0),
    queryFn: () => api.listExecutionsWithTaskInfo(projectId!),
    enabled: projectId != null,
    refetchInterval: 2000,
  });
}
```

### KanbanView Action Bar Pattern (verbatim structure to replicate)
```typescript
// Source: src/views/KanbanView.tsx lines 39-90
<div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
  <div className="flex items-center gap-2">
    <Input
      type="text"
      placeholder="Search agents..."
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      className="h-8 w-48 text-sm"
    />
    <ToggleGroup variant="outline" size="sm" defaultValue={["All"]}>
      {STATUS_FILTERS.map((f) => (
        <ToggleGroupItem
          key={f}
          value={f}
          pressed={statusFilter === f}
          onClick={() => setStatusFilter(f)}
          className="text-xs px-3"
        >
          {f}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  </div>
</div>
```

### Existing TerminalComponent Cleanup (current state — needs extension for REQ-22)
```typescript
// Source: src/components/execution/Terminal.tsx lines 66-71
// CURRENT — missing detach_terminal and ResizeObserver:
return () => {
  terminal.dispose();
  // Channel drop is implicit
};

// REQUIRED for REQ-22 compliance:
return () => {
  resizeObserver.disconnect();   // ADD: disconnect before dispose
  api.detachTerminal(taskId).catch(() => {});  // ADD: explicit IPC detach
  terminal.dispose();
};
```

### ExecutionWithTask Type (from bindings.ts line 991)
```typescript
// Source: src/types/bindings.ts
export type ExecutionWithTask = {
  id: number;
  task_id: number;
  task_name: string;
  branch_name: string | null;
  status: string;  // "running" | "complete" | "failed" | "paused" | "cancelled"
  started_at: string;      // ISO 8601
  completed_at: string | null;
  terminal_output: string | null;
}
```

Note: `status` is typed as `string`, not the `ExecutionStatus` union type. Client-side filtering should compare against lowercase string literals (`"running"`, `"complete"`, `"failed"`).

### navigationStore Deep-Link Pattern (existing)
```typescript
// Source: src/views/AgentsView.tsx + src/store/navigationStore.ts
const pendingAgentId = usePendingAgentId();    // string | null
const { clearPendingAgent } = useNavigationActions();

useEffect(() => {
  if (!pendingAgentId || executions.length === 0) return;
  const match = executions.find((e) => String(e.task_id) === pendingAgentId);
  if (match) {
    setSelectedTaskId(match.task_id);
    clearPendingAgent();
  }
}, [pendingAgentId, executions]);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `AgentStatus` local interface with static placeholder agents | Real `ExecutionWithTask[]` from IPC + TanStack Query | Phase 26 | Removes all placeholder data |
| Pre-based textarea terminal (`ExecutionTerminal.tsx`) | Real xterm.js with PTY attach (`Terminal.tsx`) | Phase 25 prep | Full ANSI support, resize, real terminal UX |
| Pool-based worktree IPC (5 commands) | On-demand worktree lifecycle | Phase 25 | `ExecutionWithTask.branch_name` now comes from real worktrees |
| Static `activeAgentId` prop through AgentsView | `pendingAgentId` from navigationStore | Phase 25 prep | Deep-link routing from any view works |

**Not applicable (greenfield rewrite):**
- No migration of stored data required — placeholder AgentMonitor is deleted, not migrated.

## Open Questions

1. **Should `TerminalComponent` be modified in place or cloned?**
   - What we know: CONTEXT.md says "Keep `TerminalComponent` (xterm.js live) unchanged — no new props added to it." But REQ-22 requires `detach_terminal` + `ResizeObserver.disconnect()` in the cleanup.
   - What's unclear: The existing cleanup in `Terminal.tsx` already does NOT call `detach_terminal`. REQ-22 requires it. Does "no new props" mean the signature is frozen but the internal cleanup can be fixed?
   - Recommendation: Interpret as signature-frozen. Add `detach_terminal` and `ResizeObserver` cleanup internally without changing the `{ taskId }` prop interface. This satisfies both the CONTEXT constraint and REQ-22.

2. **Error state for query failure (Claude's discretion)**
   - What we know: CONTEXT.md leaves error state to discretion.
   - Recommendation: Show a minimal inline error in the sidebar — `"Failed to load agents"` in `text-xs text-destructive` centered in the list area. Do not show a toast (toasts are for mutations, not polling query failures). This follows the existing `BacklogView` inline error pattern.

## Environment Availability

Step 2.6: SKIPPED — this phase is purely frontend code changes with no new external tool dependencies. All libraries are already installed (`@xterm/xterm`, `@xterm/addon-fit`, `@tanstack/react-query`, `date-fns`, `zustand`). No CLI tools, services, or runtimes beyond the existing dev environment are required.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.2 |
| Config file | `vite.config.ts` (inline `test` block, lines 12-17) |
| Setup file | `src/test/setup.ts` |
| Quick run command | `pnpm test --run src/services/execution.service.test.ts` |
| Full suite command | `pnpm test --run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-16 | `useExecutionsWithTaskInfoQuery` returns `ExecutionWithTask[]` with 2s refetch | unit | `pnpm test --run src/services/execution.service.test.ts` | ❌ Wave 0 |
| REQ-17 | AgentMonitor renders sidebar rows from `ExecutionWithTask[]` prop | unit (RTL) | `pnpm test --run src/components/execution/AgentMonitor.test.tsx` | ❌ Wave 0 |
| REQ-18 | List is sorted by `started_at` descending | unit (pure function) | included in AgentMonitor.test | ❌ Wave 0 |
| REQ-19 | Filter chips + search narrow sidebar list client-side | unit (RTL) | included in AgentMonitor.test | ❌ Wave 0 |
| REQ-20 | Clicking row selects and renders correct terminal component type | unit (RTL) | included in AgentMonitor.test | ❌ Wave 0 |
| REQ-21 | Non-Running execution renders DeadSessionTerminal, not TerminalComponent | unit (RTL) | `pnpm test --run src/components/execution/DeadSessionTerminal.test.tsx` | ❌ Wave 0 |
| REQ-22 | xterm.js lifecycle cleanup — dispose, fitAddon, ResizeObserver, detach IPC | manual-only | N/A — requires DOM + PTY process | manual |
| REQ-23 | pendingAgentId sets initial selection; fallback to most-recent Running | unit (RTL) | included in AgentsView.test | ❌ Wave 0 |
| REQ-24 | AgentsView passes props; AgentMonitor has no direct IPC | static analysis | `pnpm lint` | ❌ Wave 0 |

REQ-22 is manual-only because it requires an active PTY session and real Tauri IPC — cannot be reproduced in happy-dom environment.

### Sampling Rate
- **Per task commit:** `pnpm test --run`
- **Per wave merge:** `pnpm test --run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/services/execution.service.test.ts` — covers REQ-16; mock `api.listExecutionsWithTaskInfo`
- [ ] `src/components/execution/AgentMonitor.test.tsx` — covers REQ-17, REQ-18, REQ-19, REQ-20, REQ-23
- [ ] `src/components/execution/DeadSessionTerminal.test.tsx` — covers REQ-21; mock xterm Terminal
- [ ] `src/views/AgentsView.test.tsx` — covers REQ-24 (no IPC in AgentMonitor)

Note: xterm.js (`Terminal`, `FitAddon`) will need to be mocked in the test environment because happy-dom does not support the canvas/WebGL rendering xterm requires. Pattern from existing project: check if `@tauri-apps/api/core` is mocked in any existing test (it is — `boardStore.test.ts` or similar mocks IPC).

## Sources

### Primary (HIGH confidence)
- `src/components/execution/Terminal.tsx` — xterm.js implementation confirmed; cleanup gap identified
- `src/types/bindings.ts` line 991 — `ExecutionWithTask` type shape verified
- `src/views/KanbanView.tsx` lines 39-90 — action bar pattern confirmed
- `src/services/execution.service.ts` — existing hook patterns confirmed; `listExecutionsWithTaskInfo` at line 423 of bindings
- `src/store/navigationStore.ts` — `pendingAgentId` type (`string | null`) and `clearPendingAgent` confirmed
- `src/utils/helpers/index.ts` + `tauri-utils.ts` — `api` proxy pattern confirmed; `@/lib` resolves to `src/utils/helpers`
- `package.json` — all required libraries confirmed installed at correct versions

### Secondary (MEDIUM confidence)
- xterm.js `Terminal.write()` async queue behavior — derived from reading the existing implementation + known xterm.js behavior; verified no issue when dispose is in cleanup return

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified as installed in package.json; no new installs needed
- Architecture: HIGH — all patterns copied from existing code in this repo; no speculative patterns
- Pitfalls: HIGH — derived from reading actual code (Terminal.tsx cleanup gap, type mismatch in navigationStore, status string vs enum)

**Research date:** 2026-03-29
**Valid until:** 2026-04-28 (stable stack; no fast-moving dependencies for this phase)

## Project Constraints (from CLAUDE.md)

Actionable directives the planner must verify compliance with:

| Directive | Applies To Phase 26 |
|-----------|---------------------|
| Use direct imports; no barrel `index.ts` files in domain directories | AgentMonitor, DeadSessionTerminal must use direct imports — no new barrels |
| `@/lib` alias → `src/utils/helpers`, `@/ui` alias → `src/components/ui/*` | All new files must use path aliases consistently |
| `@/hooks` alias → `src/utils/hooks` | Custom hooks (if any) must live in `src/utils/hooks/` |
| TypeScript strict mode enabled | All new components must type-check cleanly |
| React 19 + TypeScript frontend | No class components; use function components |
| Zustand with Immer for state | If new store state is needed, follow Immer pattern |
| `api.*` calls via `@/lib` proxy (auto-unwraps Result) | All IPC calls go through `api.*` not raw `commands.*` |
| IPC handlers use `Arc<AppState>` (Rust side) | N/A — no Rust changes in this phase |
| Run `pnpm tauri:gen` after Rust model changes | N/A — no Rust changes in this phase |
| Skills stored as JSON arrays; `#[serde(rename_all = "PascalCase")]` for TaskStatus | N/A — not modifying task model |
| `ExecutionStatus` serialized as lowercase strings (`"running"`, `"complete"`, `"failed"`) | Filter comparison must use lowercase; `ExecutionWithTask.status` is `string` not the union type |
