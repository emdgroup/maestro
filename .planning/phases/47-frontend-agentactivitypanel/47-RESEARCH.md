# Phase 47: Frontend: AgentActivityPanel - Research

**Researched:** 2026-04-22
**Domain:** React UI — real-time ACP event display, Tauri event subscription, structured output replay
**Confidence:** HIGH

## Summary

Phase 47 is a pure frontend rendering phase. The backend plumbing is entirely in place from Phase 46: Tauri emits `acp://session-update/{log_id}` events carrying `SessionUpdate.payload` (a `serde_json::Value`), flushes the full payload array to `execution_logs.structured_output`, and emits `acp://session-ended/{log_id}` on teardown. The `acp://terminal-output/{log_id}` event carries raw bytes for the existing `TerminalComponent` to consume.

This phase adds:
1. A new `AgentActivityPanel` component (live view, dead session view)
2. Conditional render in `AgentMonitor.tsx` — branch on `execution_mode === 'acp'`
3. A `get_structured_output` Rust IPC command for dead session replay
4. A `useStructuredOutputQuery(logId)` TanStack Query hook in `execution.service.ts`
5. TypeScript bindings regeneration after adding the Rust command

The ACP `SessionUpdate.payload` is the `serde_json::to_value(&SessionNotification)` from the ACP Rust SDK. The `SessionNotification` discriminates on `sessionUpdate` field: `"agent_message_chunk"`, `"tool_call"`, `"tool_call_update"`, `"plan"`. These are defined only in the frontend as a discriminated union — no Rust binding needed.

**Primary recommendation:** Implement all frontend work in-tree without new npm dependencies. React-markdown is not installed; use a lightweight inline markdown renderer (bold/code/lists via regex transforms) or install `react-markdown@10` if the user approves. The `react-resizable-panels` package is already installed and shadcn-wrapped in `src/components/ui/resizable.tsx` but is NOT needed here — the context decision is a toggle button (no persistent split), which is pure CSS height animation.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Split Pane Layout**
- Activity panel fills the content area for ACP sessions — terminal is secondary, toggled via a button
- "Terminal" button in the activity panel header bar; click slides a terminal panel in from the bottom (VS Code-style bottom panel)
- Click again collapses the terminal panel
- No persistent split: terminal only visible when user requests it

**Activity Item Rendering — Messages**
- Streaming prose block: one continuous text block per message turn
- New `agent_message_chunk` events append text in-place with a blinking cursor while streaming
- Rendered as markdown (bold, inline code, fenced code blocks, lists) once complete
- Clean Claude.ai-style output — not chat bubbles, not monospace lines

**Activity Item Rendering — Tool Calls**
- Collapsible card: header always visible (tool icon + tool name + status badge), args/result expandable on click
- Open by default while running; collapses after completion
- Status badges: running / done / failed (matches existing STATUS_DOT colors in AgentMonitor.tsx)

**Activity Item Rendering — Plans**
- Sticky plan panel pinned to the top of the activity area
- Renders as a compact checklist that updates in place as agent progresses
- Panel collapses / hides when no plan has been received yet

**ACP vs PTY Session Routing**
- Routing logic lives inside AgentMonitor — conditional render based on `execution_mode`
- If `execution_mode === 'acp'`: render `AgentActivityPanel` in the content area
- Otherwise: render existing `TerminalComponent` / `DeadSessionTerminal` as today
- No new top-level component; clean branch in AgentMonitor's content area

**Loading / Initializing State**
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

### Deferred Ideas (OUT OF SCOPE)

- None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ACTIVITY-01 | User sees structured ACP agent output (messages, tool calls with args/results, file diffs, plans) in real-time via Tauri event subscription | `listen('acp://session-update/{log_id}', ...)` pattern verified; payload shape fully documented |
| ACTIVITY-02 | User sees raw terminal output alongside structured output in a split pane using existing TerminalComponent | `TerminalComponent` reuse pattern verified; toggle via CSS transition (no new library needed) |
| ACTIVITY-03 | Completed ACP sessions replay structured output loaded from DB (dead session view) | `execution_logs.structured_output` column confirmed present; IPC command to be added |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Live event subscription (`acp://session-update`) | Browser/Client | — | `listen()` from `@tauri-apps/api/event` is a frontend operation; backend already emits |
| Structured output rendering (messages, tools, plans) | Browser/Client | — | Pure React rendering; all data arrives via Tauri events |
| Terminal toggle panel | Browser/Client | — | CSS animation + TerminalComponent reuse; no backend involvement |
| Dead session replay load | API/Backend | Browser/Client | New `get_structured_output` IPC command reads `structured_output` column; frontend calls it |
| `get_structured_output` IPC | API/Backend | — | Reads from `execution_logs.structured_output`; returns parsed JSON array |
| TypeScript bindings regen | Build (local) | — | `pnpm tauri:gen` after adding Rust command |

---

## Standard Stack

### Core (all already installed) [VERIFIED: package.json]
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `react` | 19.2.5 | Component framework | Project standard |
| `@tauri-apps/api` | 2.10.1 | `listen()` for events, `invoke()` for IPC | Project standard |
| `@tanstack/react-query` | 5.96.2 | `useStructuredOutputQuery` hook | Project pattern for all IPC queries |
| `zustand` + `immer` | 4.5.7 / 10.2.0 | Local UI state (terminal toggle, streaming state) | Project pattern |
| shadcn `Badge`, `Button`, `Card`, `Collapsible` | — | Tool call cards, plan checklist items | Already in `src/components/ui/` |
| `lucide-react` | 1.7.0 | Tool type icons (wrench, file, terminal) | Project standard for icons |
| `framer-motion` | 12.38.0 | Bottom panel slide animation (already installed) | Smooth height transitions; already a dep |

### Markdown Rendering (Claude's Discretion) [VERIFIED: package.json scan]
| Option | Status | Tradeoff |
|--------|--------|----------|
| `react-markdown@10` | NOT installed — needs `npm install` | Full CommonMark compliance; adds ~100KB gzipped |
| Inline regex renderer | Zero new dep | Handles bold/inline-code/fenced-code/lists sufficient for ACP output; misses edge cases |

**Recommendation:** Install `react-markdown@10` for correctness. ACP agent messages frequently contain code fences and mixed formatting that regex approaches miss. `react-markdown` is the standard solution. [VERIFIED: npm registry shows latest stable 10.1.0]

**Installation (if approved):**
```bash
npm install react-markdown
```

---

## ACP Payload Schema

[VERIFIED: Context7 /agentclientprotocol/agent-client-protocol, prompt-turn.mdx and schema.mdx]

The `SessionUpdate.payload` (a `serde_json::Value`) is the JSON-serialized `SessionNotification` from the ACP SDK. The discriminator field is `sessionUpdate`:

### `agent_message_chunk`
```typescript
{
  sessionUpdate: "agent_message_chunk";
  content: {
    type: "text";
    text: string;   // delta text — append to current message buffer
  };
}
```

### `tool_call` (new tool call created)
```typescript
{
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;        // human-readable label e.g. "Reading config.json"
  kind: string;         // "read_file" | "write_file" | "run_terminal" | "search" | "other"
  status: "pending";
}
```

### `tool_call_update` (status change or content added)
```typescript
{
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: "pending" | "in_progress" | "completed" | "error";
  content?: ToolCallContent;  // optional new content block
}
```

Where `ToolCallContent` is a union:
```typescript
type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
```

### `plan`
```typescript
{
  sessionUpdate: "plan";
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

**Critical:** `agent_message_chunk` events are deltas — each carries a text fragment. The frontend must accumulate them into a message buffer keyed by turn. There is no explicit "message start" / "message end" event; a new message turn begins when an `agent_message_chunk` arrives after a non-chunk event (or at start).

---

## Architecture Patterns

### System Architecture Diagram

```
User selects ACP execution in sidebar
        │
        ▼
AgentMonitor.tsx
  ├─ execution_mode === 'acp' AND status === 'running'
  │         └─► AgentActivityPanel (live view)
  │                   ├─ useEffect: listen('acp://session-update/{logId}')
  │                   │     └─► dispatch to activity item state
  │                   ├─ useEffect: listen('acp://terminal-output/{logId}')
  │                   │     └─► buffer for TerminalComponent
  │                   ├─ useEffect: listen('acp://session-ended/{logId}')
  │                   │     └─► mark session ended, refresh executions query
  │                   └─ Terminal toggle button
  │                         └─► collapsible TerminalComponent at bottom
  │
  ├─ execution_mode === 'acp' AND status !== 'running'
  │         └─► AgentActivityPanel (dead view)
  │                   └─ useStructuredOutputQuery(logId)
  │                         └─► invoke('get_structured_output', {logId})
  │                               └─► execution_logs.structured_output (JSON array)
  │
  └─ execution_mode !== 'acp'  (existing PTY path — UNCHANGED)
            └─► TerminalComponent / DeadSessionTerminal (as today)
```

### Recommended Project Structure
```
src/components/execution/
├── AgentMonitor.tsx          # Modified: add ACP branch in content area
├── AgentActivityPanel.tsx    # New: live + dead session ACP view
├── activity/                 # New subfolder for activity sub-components
│   ├── ActivityMessageItem.tsx      # Streaming prose message block
│   ├── ActivityToolCallCard.tsx     # Collapsible tool call card
│   ├── ActivityPlanPanel.tsx        # Sticky plan checklist
│   └── ActivitySessionEndedBanner.tsx  # Completed/failed banner
├── Terminal.tsx              # Unchanged
└── DeadSessionTerminal.tsx   # Unchanged
```

### Pattern 1: Tauri Event Subscription in React (verified project pattern)
```typescript
// Source: src/utils/hooks/useConnectionHealth.ts
import { listen } from "@tauri-apps/api/event";

useEffect(() => {
  // listen() returns Promise<UnlistenFn>
  const unlisten = listen<SessionUpdatePayload>(
    `acp://session-update/${logId}`,
    (event) => {
      dispatch(event.payload);
    }
  );

  return () => {
    unlisten.then((fn) => fn());
  };
}, [logId]);
```

**Key detail:** `listen()` returns `Promise<UnlistenFn>`. The cleanup in `useEffect` must call the returned function to unsubscribe. Cleanup cannot be synchronous — store the promise and call `.then(fn => fn())`.

### Pattern 2: TanStack Query for Dead Session Load (project pattern)
```typescript
// Source: src/services/execution.service.ts pattern
export function useStructuredOutputQuery(logId: number | null) {
  return useQuery({
    queryKey: ["structuredOutput", logId],
    queryFn: () => api.getStructuredOutput(logId!),
    enabled: logId != null,
    staleTime: Infinity,  // dead sessions never change
  });
}
```

### Pattern 3: Rust IPC for `get_structured_output` (Claude's discretion)
```rust
// Recommended shape — returns Vec<serde_json::Value> (the accumulated payload array)
#[tauri::command]
#[specta::specta]
pub async fn get_structured_output(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let json: Option<String> = conn.query_row(
        "SELECT structured_output FROM execution_logs WHERE id = ?1",
        rusqlite::params![log_id],
        |row| row.get(0),
    ).map_err(|e| format!("DB query failed: {}", e))?;

    match json {
        None => Ok(vec![]),
        Some(s) => serde_json::from_str::<Vec<serde_json::Value>>(&s)
            .map_err(|e| format!("Failed to parse structured_output: {}", e)),
    }
}
```

After adding: register in `lib.rs` `collect_commands!`, run `pnpm tauri:gen`.

The TS binding returns `Result<JsonValue[], string>` — `JsonValue` is already defined in `bindings.ts`.

### Pattern 4: Activity State Accumulation (frontend state model)
```typescript
// Define in src/components/execution/activity/types.ts (not via Rust bindings)
type SessionUpdatePayload =
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; kind: string; status: string }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status?: string; content?: ToolCallContent }
  | { sessionUpdate: "plan"; entries: PlanEntry[] };

type ActivityState = {
  messages: MessageItem[];       // accumulated message turns
  toolCalls: Map<string, ToolCallItem>;  // keyed by toolCallId
  plan: PlanEntry[] | null;
  isInitializing: boolean;       // true until first event
  sessionEnded: boolean;
};
```

**Accumulation rule for messages:** On `agent_message_chunk`, if the last message item is in-progress, append text to it. Otherwise create a new message item. Set `isInitializing = false` on first event of any type.

### Pattern 5: Terminal Bottom Panel (toggle via CSS)
```typescript
// framer-motion (already installed) for smooth height animation
import { AnimatePresence, motion } from "framer-motion";

{isTerminalOpen && (
  <motion.div
    initial={{ height: 0 }}
    animate={{ height: 280 }}
    exit={{ height: 0 }}
    className="border-t border-border overflow-hidden shrink-0"
  >
    <TerminalComponent key={logId} taskId={logId} />
  </motion.div>
)}
```

Fixed height of 280px is sufficient for the bottom panel; user-resizable is deferred.

### Anti-Patterns to Avoid
- **Calling `unlisten()` synchronously in useEffect cleanup:** `listen()` returns a Promise, not the function directly. Always `.then(fn => fn())`.
- **Storing `logId` in component state instead of prop:** The `logId` comes from `selectedExecution.id` — it changes when the user selects a different session. Pass as prop; use `key={logId}` to force full remount on switch.
- **Merging live events into a Zustand store shared across sessions:** Keep all streaming state local to `AgentActivityPanel` using `useReducer` or `useState`. Cross-session state leads to stale data when switching sessions.
- **Rendering raw `serde_json::Value` without discriminating on `sessionUpdate`:** Always narrow the type first; unknown variants should be silently ignored, not thrown.
- **Calling `TerminalComponent` for ACP terminal-output without an attached PTY session:** The ACP terminal bottom panel receives output via Tauri events (`acp://terminal-output/{logId}`), not via `attachTerminal` IPC. A separate buffer-forwarding approach is needed (see Open Questions).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown rendering | Custom regex parser | `react-markdown@10` | Handles nested formatting, fenced code with syntax hints, link detection — edge cases are numerous |
| File diff display | Custom diff viewer | Reuse `DiffViewer.tsx` with synthetic `DiffFile` | Already in codebase; handles syntax highlighting via shiki |
| Collapsible sections | Custom accordion | shadcn `Collapsible` | Already imported in project; handles keyboard/accessibility |
| Bottom panel animation | Custom CSS keyframe | `framer-motion` (already installed) | Consistent with project's existing animation approach |
| Status badge colors | Custom CSS | Reuse `STATUS_DOT` + `STATUS_LABEL` from `AgentMonitor.tsx` | Already defined; DRY |

---

## Common Pitfalls

### Pitfall 1: Message Turn Boundary Detection
**What goes wrong:** `agent_message_chunk` events are deltas with no explicit start/end markers. Naively appending all chunks to a single string produces one merged blob that ignores turn boundaries.
**Why it happens:** The ACP protocol sends chunks continuously — there is no "message start" event.
**How to avoid:** Track whether the previous event was also an `agent_message_chunk`. When a non-chunk event arrives (tool_call, plan, tool_call_update) after chunks, consider the current message turn complete and mark it as rendered. A new chunk after a non-chunk starts a new turn.
**Warning signs:** All agent text appears as a single paragraph with no visual separation between turns.

### Pitfall 2: useEffect cleanup for Tauri listen()
**What goes wrong:** `listen()` returns `Promise<UnlistenFn>`, not the function itself. If cleanup calls `unlisten()` synchronously, it calls the Promise object, which silently does nothing. The listener leaks and fires for subsequent sessions.
**Why it happens:** Tauri's `listen()` is async unlike browser `addEventListener`.
**How to avoid:** Store the promise and call it in cleanup: `const p = listen(...); return () => { p.then(fn => fn()); };`
**Warning signs:** Selecting a second ACP session shows events from both sessions; console shows duplicate dispatch.

### Pitfall 3: TerminalComponent for ACP sessions
**What goes wrong:** `TerminalComponent` calls `api.attachTerminal(taskId, channel, null)` which expects a PTY session. ACP sessions have no PTY entry in `pty_sessions`; the call returns an error.
**Why it happens:** The terminal bottom panel is for ACP's `acp://terminal-output/{logId}` stream, not a PTY session.
**How to avoid:** The ACP terminal panel needs a wrapper that subscribes to `acp://terminal-output/{logId}` and writes bytes directly to an xterm instance — similar to `TerminalComponent` but using `listen()` instead of `attachTerminal`. This is a new small component (`AcpTerminalPanel.tsx`), not a direct reuse of `TerminalComponent`.
**Warning signs:** "No PTY session for log_id" error in console when terminal panel is opened on an ACP session.

### Pitfall 4: Dead Session Query Fires for Live Sessions
**What goes wrong:** `useStructuredOutputQuery` fetches from DB on mount. If called for a live session, it returns a partial/stale snapshot — events since the last 10-second flush are missing.
**Why it happens:** The backend flushes every 10 seconds; the DB snapshot lags live state.
**How to avoid:** Only use `useStructuredOutputQuery` when `execution.status !== 'running'`. For live sessions, use the Tauri event subscription path exclusively.
**Warning signs:** Live session shows stale output from DB instead of real-time events.

### Pitfall 5: Forgetting to add `get_structured_output` to `collect_commands!`
**What goes wrong:** `pnpm tauri:gen` succeeds (the test only runs `generate_typescript_bindings` which calls `create_builder()`), but the IPC command is not registered in production — `invoke('get_structured_output')` returns "Command not found".
**Why it happens:** `create_builder()` in `lib.rs` must include every command; the test validates the builder but the builder only validates if the command is registered.
**How to avoid:** Add to `collect_commands![..., crate::ipc::get_structured_output]` in `lib.rs` before running `pnpm tauri:gen`.

---

## Code Examples

### Tauri Event Listen Cleanup (verified pattern)
```typescript
// Source: src/utils/hooks/useConnectionHealth.ts
useEffect(() => {
  const unlisteners = Promise.all([
    listen<SessionUpdatePayload>(`acp://session-update/${logId}`, (e) => {
      handleUpdate(e.payload);
    }),
    listen<null>(`acp://session-ended/${logId}`, () => {
      setSessionEnded(true);
    }),
  ]);

  return () => {
    unlisteners.then(([u1, u2]) => { u1(); u2(); });
  };
}, [logId]);
```

### AgentMonitor ACP Branch (content area modification)
```typescript
// Source: src/components/execution/AgentMonitor.tsx (modification target)
// Replace the "Terminal pane" content section:
{selectedExecution?.execution_mode === "acp" ? (
  selectedExecution.status === "running" ? (
    <AgentActivityPanel key={selectedExecution.id} execution={selectedExecution} />
  ) : (
    <AgentActivityPanel key={selectedExecution.id} execution={selectedExecution} isDead />
  )
) : selectedExecution?.status === "running" && terminalSessionId != null ? (
  <TerminalComponent key={terminalSessionId} taskId={terminalSessionId} />
) : selectedExecution ? (
  <DeadSessionTerminal key={selectedExecution.id} execution={selectedExecution} />
) : (
  <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
    Select an agent to view its terminal
  </div>
)}
```

### Sticky Plan Panel Layout
```typescript
// CSS approach: sticky within a scrollable container
// The activity area is the scroll container; plan panel sticks to top
<div className="flex-1 flex flex-col overflow-y-auto relative">
  {plan && (
    <div className="sticky top-0 z-10 bg-card border-b border-border">
      <ActivityPlanPanel entries={plan} />
    </div>
  )}
  <div className="flex-1 p-3 space-y-2">
    {activityItems.map(item => <ActivityItem key={item.id} item={item} />)}
  </div>
</div>
```

### Blinking Cursor During Streaming
```typescript
// CSS class on a small block appended to the streaming message
// In globals.css or inline: @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
<span className="inline-block w-2 h-4 bg-foreground ml-0.5 animate-pulse" />
```

`animate-pulse` is a Tailwind built-in class (opacity oscillation), matches the CONTEXT.md spec exactly. [VERIFIED: Tailwind docs; `animate-pulse` applies `animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite`]

---

## Runtime State Inventory

Not applicable — this is a greenfield frontend phase with no rename/migration.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ACP payload as opaque `serde_json::Value` in backend | Pass-through to frontend; parse on frontend with TS discriminated union | Phase 43 design | Frontend owns payload interpretation — no Rust type generation needed |
| Terminal output via `attachTerminal` Channel | ACP terminal output via `listen('acp://terminal-output/{logId}')` | Phase 46 | Different subscription pattern needed for ACP terminal panel |
| Dead session view from `terminal_output` column | Dead ACP session view from `structured_output` column (JSON array) | Phase 44 | New IPC command + query hook needed |

**Deprecated patterns (do not use):**
- `api.attachTerminal()` for ACP sessions — no PTY session exists; use `listen('acp://terminal-output/{logId}')` directly.
- Reading `execution.terminal_output` for ACP sessions — ACP uses `structured_output` column instead.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `SessionNotification` serializes with `sessionUpdate` as discriminator field | ACP Payload Schema | If Rust SDK uses different field name, frontend discriminated union must change. Low risk — verified from ACP protocol docs and integration test in maestro-protocol. |
| A2 | `acp://terminal-output/{logId}` payload is `Vec<u8>` serialized as JSON array of numbers | Pitfall 3 / TerminalComponent | If payload is base64 string, decode step is needed. Check manager.rs: `app_handle.emit(..., &out.bytes)` — Tauri serializes `Vec<u8>` as JSON number array. |
| A3 | `framer-motion` (installed) can animate height from 0 to fixed value without layout thrash | Pattern 5 | If project's CSS setup causes issues, CSS transition on `max-height` is the fallback. |

---

## Open Questions (RESOLVED)

1. **ACP terminal-output byte encoding to xterm**
   - What we know: The backend emits `acp://terminal-output/{log_id}` with `&out.bytes` (a `Vec<u8>`). Tauri serializes `Vec<u8>` as a JSON array of integers (e.g., `[27, 91, 50, 74]`).
   - What's unclear: `TerminalComponent` uses a `Channel<string>` and calls `terminal.write(output: string)` directly. For ACP, the listen payload is `number[]`, not a string. xterm's `write()` accepts `string | Uint8Array`.
   - RESOLVED: In `AcpTerminalPanel`, convert the number array to `Uint8Array` and call `terminal.write(new Uint8Array(payload))`. This needs a dedicated wrapper component, not raw `TerminalComponent`.

2. **Message turn detection for agent_message_chunk**
   - What we know: The protocol has no explicit "message started" / "message ended" events. Chunks arrive continuously.
   - What's unclear: Does a real Claude ACP agent always interleave chunks with tool_calls cleanly, or can multiple back-to-back "turns" arrive as unbroken chunk streams?
   - RESOLVED: Treat any non-chunk event as a turn boundary. Keep current approach. If visual separation is wrong in practice, the user can report and we adjust.

3. **ACP terminal output during dead session replay**
   - What we know: `terminal_output` column in `execution_logs` stores PTY bytes. ACP terminal output is emitted as events but NOT persisted to `terminal_output` (that column is for PTY sessions). The structured_output only has `SessionNotification` payloads, not raw terminal bytes.
   - What's unclear: Should the dead session ACP terminal panel show anything?
   - RESOLVED: For dead ACP sessions, hide the terminal panel entirely (terminal toggle button is disabled/hidden). Only live ACP sessions show terminal. This is the cleanest behavior given the current persistence model.

---

## Environment Availability

Step 2.6: Skipped — this phase is frontend-only. The only new external action is `pnpm tauri:gen` after the Rust IPC addition, which requires the existing Tauri toolchain (already confirmed working in Phase 46).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.3 (configured in `vite.config.ts` `test:` block) |
| Config file | `vite.config.ts` (inline test config) |
| Quick run command | `pnpm test AgentActivityPanel` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ACTIVITY-01 | Live event subscription accumulates agent_message_chunk into message items | unit | `pnpm test AgentActivityPanel` | ❌ Wave 0 |
| ACTIVITY-01 | Tool call events render collapsible card with status badge | unit | `pnpm test ActivityToolCallCard` | ❌ Wave 0 |
| ACTIVITY-01 | Plan events render sticky checklist | unit | `pnpm test ActivityPlanPanel` | ❌ Wave 0 |
| ACTIVITY-01 | Initializing state shows spinner until first event | unit | `pnpm test AgentActivityPanel` | ❌ Wave 0 |
| ACTIVITY-02 | Terminal toggle shows/hides AcpTerminalPanel | unit | `pnpm test AgentActivityPanel` | ❌ Wave 0 |
| ACTIVITY-03 | Dead session: useStructuredOutputQuery called when status !== 'running' | unit | `pnpm test AgentActivityPanel` | ❌ Wave 0 |
| ACTIVITY-03 | Dead session: structured output items render identically to live view | unit | `pnpm test AgentActivityPanel` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test AgentActivityPanel`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/components/execution/__tests__/AgentActivityPanel.test.tsx` — covers ACTIVITY-01, ACTIVITY-02, ACTIVITY-03
- [ ] `src/components/execution/__tests__/ActivityToolCallCard.test.tsx` — covers ACTIVITY-01 tool calls
- [ ] `src/components/execution/__tests__/ActivityPlanPanel.test.tsx` — covers ACTIVITY-01 plans

Mock pattern for Tauri events (from `useConnectionHealth.test.ts`):
```typescript
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, _handler: (e: { payload: unknown }) => void) => {
    return Promise.resolve(() => {});  // returns Promise<UnlistenFn>
  }),
}));
```

---

## Security Domain

This phase is a frontend rendering phase with no new auth, session, or data-handling surface. The only new backend code is `get_structured_output`, which:
- Reads from `execution_logs` by `log_id` — an integer, no SQL injection risk via parameter binding [VERIFIED: existing rusqlite `params!` pattern]
- Returns data already stored in the DB (written by the backend, never raw user input)
- No new attack surface beyond what exists in other `execution_log` reads

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | No | `log_id` is an i32 IPC parameter — Tauri enforces type before handler |
| V4 Access Control | No | ACP session data is project-local; no cross-user access in desktop app |
| V6 Cryptography | No | No new crypto operations |

---

## Project Constraints (from CLAUDE.md)

- No `println!`/`eprintln!`/logging in Rust — Rust IPC command returns `Result<T, String>` for errors
- Import style: direct imports, no barrel `index.ts` — new components use direct imports
- Component files: PascalCase in `src/components/execution/`
- State: Zustand+Immer for cross-component state; `useReducer`/`useState` for local component state
- Type generation: `pnpm tauri:gen` after any Rust model change
- Schema version: currently v11 — no schema change needed (structured_output column exists)
- No animation without existing dep — `framer-motion` is already installed

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/src/acp/manager.rs` — confirmed event names, flush logic, structured_output accumulation
- `maestro-protocol/src/lib.rs` — confirmed SessionUpdate wire type, payload as `serde_json::Value`
- `src/components/execution/AgentMonitor.tsx` — confirmed integration point and execution_mode field
- `src/components/execution/Terminal.tsx` — confirmed TerminalComponent API (taskId prop, Channel<string>)
- `src/services/execution.service.ts` — confirmed TanStack Query patterns, existing hooks
- `src/types/bindings.ts` — confirmed ExecutionWithTask shape; `execution_mode`, `agent_id` present
- Context7 `/agentclientprotocol/agent-client-protocol` — ACP SessionNotification payload schema (prompt-turn.mdx, schema.mdx)
- `package.json` — confirmed installed packages; `framer-motion`, `react-resizable-panels` present; `react-markdown` absent

### Secondary (MEDIUM confidence)
- Context7 `/agentclientprotocol/rust-sdk` — SessionNotification Rust type structure (migration_v0.11.x.md)
- `src/utils/hooks/useConnectionHealth.ts` — Tauri `listen()` cleanup pattern (verified working in production)
- `src/components/execution/__tests__/AgentMonitor.test.tsx` — test structure for new tests

---

## Metadata

**Confidence breakdown:**
- ACP payload schema: HIGH — verified via Context7 protocol docs, cross-checked with maestro-server client.rs serialization
- Frontend patterns: HIGH — all patterns extracted from working production code in this repo
- `get_structured_output` IPC design: HIGH — analogous to existing `list_executions_with_task_info` pattern
- Markdown library choice: MEDIUM — `react-markdown@10` is the ecosystem standard but not yet installed; needs user approval or Claude discretion
- ACP terminal byte encoding: MEDIUM — inferred from Tauri serialization behavior for `Vec<u8>`; needs verification at integration time

**Research date:** 2026-04-22
**Valid until:** 2026-05-22 (stable tech stack; ACP SDK version is pinned in Cargo.lock)
