---
phase: 47-frontend-agentactivitypanel
verified: 2026-04-23T09:00:00Z
status: human_needed
score: 13/13 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 12/13
  gaps_closed:
    - "ACTIVITY-02 documentation drift — REQUIREMENTS.md updated to reflect toggle-panel design and marked [x]; ROADMAP.md SC#2 confirmed correct; commit 977f4e5"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Launch a live ACP session from the Agents view. While the agent runs, observe the activity panel."
    expected: "Message chunks appear with blinking cursor; cursor disappears when message turn ends and text re-renders as markdown. Tool call cards appear as tool calls are made, show Running badge while active, auto-collapse to Done/Failed when complete."
    why_human: "Requires a live ACP agent running and producing output. Cannot verify streaming behavior programmatically."
  - test: "Run an ACP session that emits a plan event. Observe the sticky plan panel."
    expected: "Plan checklist appears pinned to the top of the activity area. Items update status (pending/in_progress/completed) as the agent progresses."
    why_human: "Requires a live ACP session that emits plan events. Cannot verify sticky positioning or dynamic updates programmatically."
  - test: "During a live ACP session, click the Terminal button in the header bar."
    expected: "Terminal panel slides in from below the activity area (VS Code-style). Click again collapses it. Terminal shows raw bytes from the agent process."
    why_human: "Requires a live session for the terminal to receive events. Animation behavior requires visual verification."
  - test: "Select a completed ACP session from the sidebar. Observe the activity panel."
    expected: "Session renders identically to how it would have appeared live — same messages, same tool call cards, same plan checklist. No live terminal toggle button shown."
    why_human: "Requires a populated structured_output DB row from a real completed session."
---

# Phase 47: Frontend AgentActivityPanel — Verification Report

**Phase Goal:** Build the AgentActivityPanel — a live/replay activity viewer for ACP sessions rendered inside AgentMonitor.
**Verified:** 2026-04-23T09:00:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (Plan 03 closed ACTIVITY-02 documentation drift)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | get_structured_output IPC command returns structured output JSON array for a given log_id | VERIFIED | `pub async fn get_structured_output` at acp_handlers.rs:163; queries `SELECT structured_output FROM execution_logs WHERE id = ?1`; registered in lib.rs collect_commands! |
| 2 | useStructuredOutputQuery hook fetches structured output from DB for dead sessions | VERIFIED | execution.service.ts:300 — `useQuery` with `api.getStructuredOutput(logId!)`, `staleTime: Infinity`, enabled guard |
| 3 | useAcpActivity hook subscribes to acp://session-update events and accumulates state | VERIFIED | useAcpActivity.ts:114 — listens to `acp://session-update/${logId}` and `acp://session-ended/${logId}` with cleanup via `unlisteners.then(...)` |
| 4 | SessionUpdate TypeScript types discriminate on sessionUpdate field | VERIFIED | types.ts — full discriminated union: AgentMessageChunk, ToolCallCreated, ToolCallUpdate, PlanUpdate; SessionUpdatePayload union exported |
| 5 | activityReducer is exported so AgentActivityPanel can use load_from_db for dead session replay | VERIFIED | useAcpActivity.ts:20 — `export function activityReducer`; AgentActivityPanel imports and uses `useReducer(activityReducer, INITIAL_ACTIVITY_STATE)` + `deadDispatch({ type: "load_from_db", payloads })` |
| 6 | User sees streaming agent messages with blinking cursor rendered as markdown | VERIFIED | ActivityMessageItem.tsx — streaming: raw text + `animate-pulse` block; complete: `react-markdown` with custom component overrides |
| 7 | User sees tool calls as collapsible cards with status badges (running/done/failed) | VERIFIED | ActivityToolCallCard.tsx — Collapsible component, STATUS_BADGE_VARIANT map, auto-collapses on completed/error via useEffect |
| 8 | User sees a sticky plan checklist at the top of the activity area when a plan event arrives | VERIFIED | AgentActivityPanel.tsx:134-137 — `sticky top-0 z-10` div with ActivityPlanPanel when `state.plan` is non-null |
| 9 | User can toggle a terminal bottom panel to see raw ACP terminal output | VERIFIED | AgentActivityPanel.tsx — AnimatePresence + motion.div slide-in; AcpTerminalPanel subscribes to `acp://terminal-output/${logId}`; toggle via isTerminalOpen state |
| 10 | Selecting a completed ACP session renders structured output from DB identically to live view | VERIFIED | AgentActivityPanel.tsx — useStructuredOutputQuery + `deadDispatch({ type: "load_from_db" })` uses same activityReducer as live path |
| 11 | AgentMonitor routes ACP sessions to AgentActivityPanel and PTY sessions to TerminalComponent | VERIFIED | AgentMonitor.tsx:196-210 — `execution_mode === "acp"` branch renders AgentActivityPanel with isDead prop; PTY paths unchanged |
| 12 | Initializing ACP session shows spinner with Starting agent... text until first event | VERIFIED | AgentActivityPanel.tsx — renders Loader2 + "Starting agent..." when `state.isInitializing && !isDead` |
| 13 | ACTIVITY-02 documentation aligned with toggle-panel design (gap closure) | VERIFIED | REQUIREMENTS.md: `[x] **ACTIVITY-02**` with AcpTerminalPanel description; traceability table `Complete`; ROADMAP.md SC#2 contains "toggleable bottom panel (AcpTerminalPanel)"; no "split pane" language remains; commit 977f4e5 |

**Score:** 13/13 truths verified

### Gap Closure Verification (Plan 03 — Re-verification Focus)

| Must-Have | Status | Evidence |
|-----------|--------|----------|
| ACTIVITY-02 in REQUIREMENTS.md is marked [x] | VERIFIED | `grep "[x] **ACTIVITY-02**"` — match at line 60 |
| ACTIVITY-02 description matches toggle-panel design from CONTEXT.md | VERIFIED | Description reads "User can toggle a terminal bottom panel to see raw ACP terminal output alongside the structured activity view (AcpTerminalPanel, slide-in from bottom)" — no split-pane language |
| ACTIVITY-02 Traceability table shows Complete | VERIFIED | `grep "| ACTIVITY-02 | Phase 47 | Complete |"` — match at line 128 |
| ROADMAP.md Phase 47 SC#2 describes toggleable AcpTerminalPanel design | VERIFIED | Line 186: "Raw terminal output from the agent is accessible via a toggleable bottom panel (AcpTerminalPanel) that slides in when the user clicks the Terminal button" |

### Regression Check (Previously Passing Items)

All 12 previously-verified items were quick-checked for regression:

| Check | Result |
|-------|--------|
| `pub async fn get_structured_output` in acp_handlers.rs | Present (line 163) |
| `getStructuredOutput` in bindings.ts | Present (line 1100) |
| `export function activityReducer` in useAcpActivity.ts | Present (line 20) |
| `export type ActivityAction` in useAcpActivity.ts | Present (line 12) |
| `export function useAcpActivity` in useAcpActivity.ts | Present (line 114) |
| `execution_mode === "acp"` in AgentMonitor.tsx | Present (line 196) |
| `AgentActivityPanel` imported in AgentMonitor.tsx | Present (line 9) |

No regressions detected.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/ipc/acp_handlers.rs` | get_structured_output IPC command | VERIFIED | `pub async fn get_structured_output` at line 163 with real DB query |
| `src/types/bindings.ts` | Auto-generated TS binding for getStructuredOutput | VERIFIED | `getStructuredOutput` at line 1100 |
| `src/services/execution.service.ts` | useStructuredOutputQuery TanStack hook | VERIFIED | Hook with `staleTime: Infinity`, enabled guard |
| `src/components/execution/activity/types.ts` | SessionUpdate discriminated union types | VERIFIED | All 4 payload types + SessionUpdatePayload union + ActivityState |
| `src/components/execution/activity/useAcpActivity.ts` | Live event hook with exported reducer | VERIFIED | activityReducer, ActivityAction, useAcpActivity all exported |
| `src/components/execution/activity/ActivityMessageItem.tsx` | Streaming prose block with markdown | VERIFIED | animate-pulse cursor + react-markdown rendering |
| `src/components/execution/activity/ActivityToolCallCard.tsx` | Collapsible tool call card | VERIFIED | Collapsible, STATUS_BADGE_VARIANT, auto-collapse on completion |
| `src/components/execution/activity/ActivityPlanPanel.tsx` | Sticky plan checklist | VERIFIED | STATUS_ICON map, progress counter, completed items with line-through |
| `src/components/execution/activity/AcpTerminalPanel.tsx` | xterm terminal fed by Tauri events | VERIFIED | listen(acp://terminal-output), new Uint8Array, disableStdin: true |
| `src/components/execution/AgentActivityPanel.tsx` | Main activity panel (live + dead) | VERIFIED | All sub-components rendered, dual mode via isDead prop |
| `src/components/execution/AgentMonitor.tsx` | ACP branch in content area | VERIFIED | AgentActivityPanel rendered when execution_mode === "acp" |
| `.planning/REQUIREMENTS.md` | Accurate ACTIVITY-02 status | VERIFIED | [x] checkbox, AcpTerminalPanel description, Complete in traceability table |
| `.planning/ROADMAP.md` | Accurate Phase 47 SC#2 | VERIFIED | Toggle-panel language confirmed, no split-pane remnants |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| execution.service.ts | bindings.ts | api.getStructuredOutput | WIRED | `api.getStructuredOutput(logId!)` at service line 303 |
| useAcpActivity.ts | @tauri-apps/api/event | listen() for acp://session-update | WIRED | `listen<unknown>('acp://session-update/${logId}')` at line 121 |
| useAcpActivity.ts | AgentActivityPanel.tsx | exported activityReducer + ActivityAction | WIRED | AgentActivityPanel.tsx:8 imports activityReducer; useReducer call at line 35 |
| AgentMonitor.tsx | AgentActivityPanel.tsx | conditional render on execution_mode | WIRED | `execution_mode === "acp"` at AgentMonitor.tsx:196 |
| AgentActivityPanel.tsx | useAcpActivity.ts | hook call for live sessions | WIRED | `useAcpActivity(isDead ? null : execution.id)` |
| AgentActivityPanel.tsx | execution.service.ts | useStructuredOutputQuery for dead sessions | WIRED | `useStructuredOutputQuery(isDead ? execution.id : null)` |
| AgentActivityPanel.tsx | @tanstack/react-query | invalidateQueries on session end | WIRED | `queryClient.invalidateQueries({ queryKey: executionQueryKeys.withTaskInfo(projectId) })` |
| AcpTerminalPanel.tsx | @tauri-apps/api/event | listen() for acp://terminal-output | WIRED | `listen<number[]>('acp://terminal-output/${logId}')` |
| CONTEXT.md toggle-panel design | REQUIREMENTS.md ACTIVITY-02 | documentation alignment | WIRED | Description updated; commit 977f4e5 |
| REQUIREMENTS.md ACTIVITY-02 status | Traceability table row | consistent status field | WIRED | Both show Complete |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| AgentActivityPanel.tsx | liveState (live mode) | useAcpActivity → listen(acp://session-update) → acp/manager.rs emits real events | Yes — backend emits `&upd.payload` from live ACP session | FLOWING |
| AgentActivityPanel.tsx | storedPayloads (dead mode) | useStructuredOutputQuery → api.getStructuredOutput → SELECT structured_output FROM execution_logs | Yes — real DB query with actual column | FLOWING |
| AcpTerminalPanel.tsx | terminal bytes | listen(acp://terminal-output) → acp/manager.rs emits `&out.bytes` | Yes — backend emits real terminal bytes from agent process | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| activityReducer exported | grep in useAcpActivity.ts | `export function activityReducer` at line 20 | PASS |
| AgentMonitor routes ACP sessions | grep in AgentMonitor.tsx | `execution_mode === "acp"` at line 196 | PASS |
| get_structured_output queries real DB | grep in acp_handlers.rs | `SELECT structured_output FROM execution_logs WHERE id = ?1` | PASS |
| ACTIVITY-02 checkbox in REQUIREMENTS.md | grep | `[x] **ACTIVITY-02**` at line 60 | PASS |
| ACTIVITY-02 Complete in traceability | grep | `| ACTIVITY-02 | Phase 47 | Complete |` at line 128 | PASS |
| ROADMAP SC#2 toggle-panel language | grep | "toggleable bottom panel (AcpTerminalPanel)" at line 186 | PASS |
| No split-pane language in either doc | grep -c | 0 matches in both REQUIREMENTS.md and ROADMAP.md | PASS |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| ACTIVITY-01 | 47-01, 47-02 | User sees structured ACP agent output in real-time via Tauri event subscription | SATISFIED | useAcpActivity subscribes to acp://session-update events; ActivityMessageItem, ActivityToolCallCard, ActivityPlanPanel render all output types |
| ACTIVITY-02 | 47-01, 47-02, 47-03 | User can toggle a terminal bottom panel to see raw ACP terminal output (AcpTerminalPanel) | SATISFIED | Implementation uses AcpTerminalPanel with toggleable bottom panel; REQUIREMENTS.md updated and marked [x]; ROADMAP SC#2 updated; commit 977f4e5 |
| ACTIVITY-03 | 47-01, 47-02 | Completed ACP sessions replay structured output loaded from DB | SATISFIED | get_structured_output IPC reads structured_output from DB; AgentActivityPanel replays through shared activityReducer via load_from_db dispatch |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/components/execution/activity/ActivityToolCallCard.tsx | 55 | `"No content yet"` italic text when tool call content is empty | INFO | Legitimate UI state message for pending tool calls — content is populated by real ToolCallUpdate events |

No blockers found.

### Human Verification Required

#### 1. Real-Time Structured Output Rendering

**Test:** Launch a live ACP session from the Agents view. While the agent runs, observe the activity panel.
**Expected:** Message chunks appear with blinking cursor; cursor disappears when message turn ends and text re-renders as markdown. Tool call cards appear as tool calls are made, show Running badge while active, auto-collapse to Done/Failed when complete.
**Why human:** Requires a live ACP agent running and producing output. Cannot verify streaming behavior programmatically.

#### 2. Plan Checklist Behavior

**Test:** Run an ACP session that emits a plan event. Observe the sticky plan panel.
**Expected:** Plan checklist appears pinned to the top of the activity area. Items update status (pending/in_progress/completed) as the agent progresses.
**Why human:** Requires a live ACP session that emits plan events. Cannot verify sticky positioning or dynamic updates programmatically.

#### 3. Terminal Toggle

**Test:** During a live ACP session, click the Terminal button in the header bar.
**Expected:** Terminal panel slides in from below the activity area (VS Code-style). Click again collapses it. Terminal shows raw bytes from the agent process.
**Why human:** Requires a live session for the terminal to receive events. Animation behavior requires visual verification.

#### 4. Dead Session Replay

**Test:** Select a completed ACP session from the sidebar. Observe the activity panel.
**Expected:** Session renders identically to how it would have appeared live — same messages, same tool call cards, same plan checklist. No live terminal toggle button shown.
**Why human:** Requires a populated structured_output DB row from a real completed session.

### Gaps Summary

No gaps remaining. The single gap from initial verification (ACTIVITY-02 documentation drift) was resolved by Plan 03 (commit 977f4e5):

- REQUIREMENTS.md ACTIVITY-02 updated: `[x]`, description reflects AcpTerminalPanel toggle-panel design
- REQUIREMENTS.md traceability table updated: `| ACTIVITY-02 | Phase 47 | Complete |`
- ROADMAP.md Phase 47 SC#2 confirmed: already contained correct toggle-panel language from commit 1fd40d0

Phase goal achieved. All 13 must-haves verified. Human testing required before considering the phase fully closed.

---

_Verified: 2026-04-23T09:00:00Z_
_Verifier: Claude (gsd-verifier)_
