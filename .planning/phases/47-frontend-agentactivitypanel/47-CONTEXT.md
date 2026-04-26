# Phase 47: Frontend: AgentActivityPanel - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Users see a structured, real-time view of ACP agent output — messages, tool calls with args/results, file diffs, and plans — alongside the raw terminal, with completed sessions replaying from the database.

PTY sessions are unaffected: this phase only adds a new rendering path for `execution_mode = 'acp'` sessions. Creating/spawning ACP sessions is Phase 46 (done).

Out of scope: PermissionDialog (Phase 48), dual-mode dispatch (Phase 49), remote ACP improvements.

</domain>

<decisions>
## Implementation Decisions

### Split Pane Layout

- Activity panel fills the content area for ACP sessions — terminal is **secondary**, toggled via a button
- "Terminal" button in the activity panel header bar; click slides a terminal panel in from the bottom (VS Code-style bottom panel)
- Click again collapses the terminal panel
- No persistent split: terminal only visible when user requests it

### Activity Item Rendering — Messages

- Streaming prose block: one continuous text block per message turn
- New `agent_message_chunk` events append text in-place with a blinking cursor while streaming
- Rendered as markdown (bold, inline code, fenced code blocks, lists) once complete
- Clean Claude.ai-style output — not chat bubbles, not monospace lines

### Activity Item Rendering — Tool Calls

- Collapsible card: header always visible (tool icon + tool name + status badge), args/result expandable on click
- Open by default while running; collapses after completion
- Status badges: running / done / failed (matches existing STATUS_DOT colors in AgentMonitor.tsx)

### Activity Item Rendering — Plans

- Sticky plan panel pinned to the top of the activity area
- Renders as a compact checklist that updates in place as agent progresses
- Panel collapses / hides when no plan has been received yet

### ACP vs PTY Session Routing

- Routing logic lives **inside AgentMonitor** — conditional render based on `execution_mode`
- If `execution_mode === 'acp'`: render `AgentActivityPanel` in the content area
- Otherwise: render existing `TerminalComponent` / `DeadSessionTerminal` as today
- No new top-level component; clean branch in AgentMonitor's content area

### Loading / Initializing State

- While ACP session is initializing (running but no events received yet): show subtle spinner + "Starting agent..." text centered in the activity area
- Disappears when first event arrives
- No skeleton UI

### Claude's Discretion

- Exact markdown rendering library choice (react-markdown vs custom)
- File diff rendering within tool_call_update events (can reuse existing DiffViewer or render inline code block)
- TS discriminated union definition for SessionUpdate payload variants (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`) — define in frontend, not via Rust bindings
- Exact bottom-panel resize handle behavior (fixed height vs user-resizable)
- Session-ended state rendering (completed/failed banner)
- `get_structured_output` IPC command design (needed for dead session replay — Claude decides shape)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ACP Protocol & Event Schema
- `.planning/research/acp-integration-study.md` — ACP session/update event types: `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`; SessionUpdate.payload structure; what structured output contains
- `maestro-protocol/src/lib.rs` — Wire types: `SessionUpdate { session_id, payload: serde_json::Value }`, `TerminalOutput`, Tauri event names (`acp://session-update/{log_id}`, `acp://terminal-output/{log_id}`, `acp://session-ended/{log_id}`)

### Existing Execution UI (read before modifying)
- `src/components/execution/AgentMonitor.tsx` — Existing monitor component; content area branch for ACP goes here; `execution_mode` available via `ExecutionWithTask`
- `src/components/execution/Terminal.tsx` — `TerminalComponent`; reused for the toggleable terminal bottom panel in ACP sessions
- `src/components/execution/DeadSessionTerminal.tsx` — Dead session terminal replay; ACP dead sessions need a parallel path using `structured_output` from DB
- `src/types/bindings.ts` — `ExecutionWithTask` includes `execution_mode: string | null` and `agent_id: string | null`; Tauri IPC wrappers for `spawn_acp_session`, `cancel_acp_session`

### Backend — Structured Output Persistence
- `src-tauri/src/acp/manager.rs` — Emits `acp://session-update/{log_id}` events; flushes `structured_output` to DB on session end
- `src-tauri/src/ipc/acp_handlers.rs` — ACP IPC surface; `get_structured_output` command (to be added in this phase) reads `structured_output` column for dead session replay

### Design System
- `CLAUDE.md` §Key Patterns — Compact design system (text-xs, h-7, p-3 patterns), shadcn/ui components, Zustand + Immer for state, TanStack Query for server state

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AgentMonitor.tsx` — sidebar + content area shell; add ACP branch inside content area; no structural changes to sidebar
- `TerminalComponent` (`Terminal.tsx`) — PTY session terminal; reuse for the toggled bottom terminal panel in ACP sessions
- `DeadSessionTerminal` — replay terminal for dead PTY sessions; ACP dead session path needs its own analog using `structured_output`
- `STATUS_DOT` / `STATUS_LABEL` maps in `AgentMonitor.tsx` — existing status badge colors; reuse for tool call status badges
- `Badge`, `Button`, `Card`, `Collapsible` from shadcn/ui — building blocks for tool call cards and plan checklist
- `DiffViewer.tsx` — existing file diff viewer; candidate for reuse inside tool_call_update rendering

### Established Patterns
- `execution_mode: string | null` in `ExecutionWithTask` — use this for ACP vs PTY branching (not agent_id)
- Tauri event subscription: `listen('acp://session-update/{log_id}', handler)` pattern — existing in acp_handlers test context; use `@tauri-apps/api/event` `listen()` in React (useEffect cleanup on unsubscribe)
- TanStack Query for DB-backed data (`useExecutionsWithTaskInfoQuery`); new `useStructuredOutputQuery(logId)` follows same pattern
- IPC commands return `Result<T, String>` — error as string; frontend unwraps via service layer

### Integration Points
- `AgentMonitor.tsx` content area — branch on `execution_mode === 'acp'` to render `AgentActivityPanel`
- `src/services/execution.service.ts` — add `useStructuredOutputQuery(logId)` for dead session load
- `src-tauri/src/ipc/acp_handlers.rs` — add `get_structured_output(log_id: i32)` IPC command
- `src-tauri/src/lib.rs` `collect_commands!` — register new IPC command
- `src/types/bindings.ts` — regenerate after adding `get_structured_output` IPC

</code_context>

<specifics>
## Specific Ideas

- Activity panel header bar contains: session name / agent id on left, "Terminal" toggle button on right
- Terminal bottom panel behaves like VS Code terminal — fixed height, slides in/out, does not replace activity content
- Blinking cursor during streaming: standard CSS `animate-pulse` on a small block element appended to message text
- Sticky plan panel: `position: sticky; top: 0` within the scrollable activity area; `z-index` above activity items

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope

</deferred>

---

*Phase: 47-frontend-agentactivitypanel*
*Context gathered: 2026-04-22*
