# Phase 26: Agents View - Context

**Gathered:** 2026-03-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the placeholder `AgentMonitor` with a real, live-updating execution list (sidebar) + a functional xterm.js terminal pane. Data comes from `list_executions_with_task_info` (IPC added in Phase 25). No new IPC commands, no new Rust work — this phase is pure frontend wiring.

</domain>

<decisions>
## Implementation Decisions

### Sidebar row layout
- **Three-line rows:** Line 1: status dot + task name (truncated). Line 2: status label + elapsed time. Line 3: branch name in monospace.
- **Sidebar width:** `w-72`
- **Selected row:** Left-border accent highlight (Linear-style), not background fill
- **Elapsed time format:** Duration only — `"Running · 3m 42s"` for active, `"Done · 3m 42s"` for finished. Consistent format regardless of session state.

### Filter toolbar
- **Combined row** below the sidebar header: search input on the left, status filter chips on the right — same action bar pattern as the KanbanView (`h-12 border-b border-border bg-muted/30`, `Input` + `ToggleGroup`/`ToggleGroupItem`)
- **Filter chips:** All / Running / Done / Failed — client-side filtering of the full `ExecutionWithTask[]` list
- **Search:** Filters by task name, client-side

### Dead session terminal handling
- **Separate component:** Render `DeadSessionTerminal` (new component) for non-Running executions. Keep `TerminalComponent` (xterm.js live) unchanged — no new props added to it.
- **DeadSessionTerminal behavior:** Mounts xterm.js, writes `terminal_output` (from `ExecutionWithTask`) on mount via `terminal.write()`, then disposes on unmount. Does NOT call `attachTerminal`.
- **Session ended banner:** A slim bar above the xterm div — `"Session ended · {completedAt} · {duration}"` for Done, `"Session failed · {completedAt}"` for Failed.
- **Null terminal_output:** Renders empty xterm + banner. No special case — consistent path.
- **xterm.js lifecycle:** Both `TerminalComponent` and `DeadSessionTerminal` call `terminal.dispose()` and cleanup on unmount. `TerminalComponent` also calls `detach_terminal` IPC on unmount.

### Empty / no-selection state
- **Right pane (no selection):** Centered muted text — `"Select an agent to view its terminal"` — no illustration, no CTA
- **Sidebar no results:** `"No agents match your filter"` in `text-xs text-muted-foreground`, centered within the list area

### Data and lifecycle
- `useExecutionsWithTaskInfoQuery(projectId)` added to `execution.service.ts` — 2-second refetch interval (REQ-16)
- `AgentsView.tsx` owns TanStack Query call, passes `ExecutionWithTask[]` as props to `AgentMonitor` — no direct IPC inside `AgentMonitor` (REQ-24)
- Terminal keyed by `task_id` — switching selection calls `detach_terminal` on previous and mounts new terminal (REQ-22)
- Deep link: `pendingAgentId` from `navigationStore` used for initial selection on mount; fallback to most-recent Running execution (REQ-23)

### Claude's Discretion
- Exact Tailwind classes for the status dot colors (Running/Done/Failed/Paused)
- Whether elapsed time for active sessions updates via `setInterval` in the row or is derived from the 2-second query refresh
- Error state when `listExecutionsWithTaskInfo` query fails

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §Agents View (Phase 26) — REQ-16 through REQ-24; complete specification for all deliverables

### Existing components to wire (do not replace xterm internals)
- `src/components/execution/Terminal.tsx` — The real xterm.js component (`TerminalComponent`). Used for Running executions. Has full attach/detach/resize/input handling.
- `src/components/execution/AgentMonitor.tsx` — Current placeholder to rewrite. Contains the sidebar + terminal layout shell.
- `src/views/AgentsView.tsx` — Page-level orchestrator to rewrite. Currently uses placeholder `AgentStatus` types.

### Components NOT to use for this phase
- `src/components/execution/ExecutionTerminal.tsx` — Old pre-based modal component. Not xterm.js. Do not use or modify.

### Patterns to follow
- `src/views/KanbanView.tsx` — Action bar pattern (lines 38-90): `h-12 border-b border-border bg-muted/30`, `Input` + `ToggleGroup`/`ToggleGroupItem` from shadcn/ui
- `src/services/execution.service.ts` — Add `useExecutionsWithTaskInfoQuery` following existing hook patterns

### Type bindings
- `src/types/bindings.ts` — `ExecutionWithTask` type: `{ id, task_id, task_name, branch_name, status, started_at, completed_at, terminal_output }`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Terminal.tsx` (`TerminalComponent`): Full xterm.js implementation — channel setup, PTY attach, input handler, resize handler, FitAddon. Use directly for Running executions. New `DeadSessionTerminal` mirrors its structure without `attachTerminal`.
- `KanbanView.tsx` action bar: Copy the `h-12 border-b bg-muted/30` div pattern with `Input` + `ToggleGroup`/`ToggleGroupItem` for the sidebar toolbar.
- `navigationStore` (`usePendingAgentId`, `useNavigationActions`): Already consumed by current `AgentsView.tsx`. Keep wiring — just update types.

### Established Patterns
- TanStack Query: `useQuery` with `queryFn` calling `api.X()`, `refetchInterval: 2000` for live data. See `execution.service.ts` for mutation patterns; follow same structure for the new query hook.
- Props-down: `AgentsView` fetches, `AgentMonitor` renders. No direct IPC inside `AgentMonitor`.
- Status dots: `bg-warning animate-pulse` for Running, `bg-muted` for Idle/Done, `bg-error` for Error/Failed — existing pattern in current AgentMonitor placeholder.

### Integration Points
- `api.listExecutionsWithTaskInfo(projectId)` in `src/lib/index.ts` (line 423) — already wired from Phase 25. Wrap it in the new TanStack Query hook.
- `api.attachTerminal(taskId, channel, null)` / `api.detachTerminal(taskId)` — used by `TerminalComponent`; same IPC used for DeadSessionTerminal teardown.

</code_context>

<specifics>
## Specific Ideas

- Filter toolbar: use the **same action bar as KanbanView's backlog** — `Input` component on left, `ToggleGroup` with `ToggleGroupItem` on right, all in `h-12 border-b border-border bg-muted/30` container. The user explicitly asked for this pattern.
- Left-border accent for selected rows (Linear-style), not background fill.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 26-agents-view*
*Context gathered: 2026-03-29*
