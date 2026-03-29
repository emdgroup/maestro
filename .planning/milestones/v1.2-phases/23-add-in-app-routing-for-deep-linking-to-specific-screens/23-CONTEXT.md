# Phase 23: Add in-app routing for deep linking to specific screens - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a programmatic navigation API (internal only — no OS protocol handler) that lets any component navigate to a specific view or open a specific entity without prop-drilling. The primary motivation is clean cross-component navigation: e.g., a toast can navigate to the affected task, or the Agents view can link directly to an associated task.

No browser history / back-forward stack needed. No OS-level deep link protocol (maestro://).

</domain>

<decisions>
## Implementation Decisions

### Scope — what "deep linking" means
- Internal navigation only — no OS protocol registration, no URL bar
- Primary use case: programmatic navigation from within components (no prop-drilling, no event buses)
- No history stack — navigate() is fire-and-forget, no back/forward needed

### Navigate API contract
The exported function signature is a discriminated union:

```typescript
type NavigationTarget =
  | { taskId: string }
  | { agentId: string }
  | { worktreeId: string }
  | { view: "backlog" | "board" | "archive" | "agents" | "worktree" | "settings" }
```

Usage: `navigate({ taskId: "123" })` / `navigate({ view: "board" })`

Rules for each target:
- `{ taskId }` → switch to kanban tab (board sub-view) + open TaskDetail sheet for that task ID
- `{ agentId }` → switch to agents tab + focus/highlight that agent
- `{ worktreeId }` → switch to worktrees tab + highlight that worktree
- `{ view: "backlog" | "board" | "archive" }` → switch to kanban tab + set sub-view accordingly
- `{ view: "agents" }` → switch to agents tab
- `{ view: "worktree" }` → switch to worktrees tab
- `{ view: "settings" }` → switch to settings tab

### Routing mechanism
- Extend/replace current `usePageRouting` hook with a **Zustand store** (`navigationStore`)
- Components access navigation via a `useNavigate()` hook (consistent with existing `useBoardStore()`, `useProjectStore()` patterns)
- The store holds: `activeTab: ViewType`, `activeSubView: SubView | null`, `pendingTaskId: string | null`, `pendingAgentId: string | null`, `pendingWorktreeId: string | null`
- App.tsx reads from the store instead of local state; KanbanView reads `activeSubView` from store instead of internal `useState`

### Entity presentation when navigating
- `taskId` → open TaskDetail sheet (same behavior as clicking a task card). The pending entity ID in the store triggers the sheet to open once the view renders.
- `agentId` / `worktreeId` → highlight/focus the entity in the respective view (exact highlight UX is Claude's discretion)

### Sub-view routing
- `backlog`, `board`, `archive` are already implemented as KanbanView sub-views (SubView type in KanbanView.tsx)
- Navigation store replaces KanbanView's internal `activeSubView` useState — the store owns sub-view state so external navigation can set it

### Claude's Discretion
- Exact highlight/focus UX for agentId and worktreeId navigation (scroll into view, border highlight, etc.)
- Transition animation behavior when navigating programmatically vs tab-click (can reuse existing slideVariants)
- Whether to clear pending entity IDs after they are consumed (likely yes, to avoid re-triggering on re-render)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing routing / navigation code
- `src/utils/hooks/usePageRouting.ts` — Current page routing hook to be replaced/extended
- `src/App.tsx` — Entry point that owns top-level view switching; will read from navigationStore
- `src/views/KanbanView.tsx` — Owns sub-view state (backlog/board/archive) that moves to store

### Existing store patterns (replicate these)
- `src/store/boardStore.ts` — Reference for Zustand + Immer store pattern used in project
- `src/store/projectStore.ts` — Reference for store with selector hooks pattern

### Entity components that will consume navigate()
- `src/components/task/TaskDetail.tsx` — TaskDetail sheet opened on taskId navigation
- `src/views/AgentsView.tsx` — Agents view that must handle agentId navigation
- `src/views/WorktreesView.tsx` — Worktrees view that must handle worktreeId navigation

No external specs — requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `usePageRouting` hook: simple `useState`-based tab switcher — replace with store-backed version
- `slideVariants` + `AnimatePresence` in App.tsx: existing animation system for view transitions — reuse for programmatic navigation
- `ViewType = "kanban" | "agents" | "worktrees" | "settings"`: existing top-level tab type — extend/align with new NavigationTarget view values

### Established Patterns
- Zustand + Immer: all global state uses this pattern (`boardStore`, `projectStore`, `configStore`) — navigationStore must follow the same shape
- Selector hooks: stores export specific selector hooks (e.g., `useSelectedProject()`) rather than exposing raw store — do the same for navigation (e.g., `useActiveTab()`, `useNavigate()`)
- Direct imports: no barrel index.ts — import from specific files

### Integration Points
- `App.tsx:62` — `usePageRouting("kanban")` call to replace with `useNavigationStore`
- `App.tsx` — `selectedTask` local state for TaskDetail controls the sheet; needs to read `pendingTaskId` from navigation store
- `KanbanView.tsx:12` — `activeSubView` local state moves to navigationStore
- `AppHeader.tsx` — `onViewChange` prop wires to `handlePageChange`; update to call `navigate()` from store

</code_context>

<specifics>
## Specific Ideas

- User specified the exact discriminated union API: `navigate({taskId:string}|{agentId:string}|{worktreeId:string}|{view:"backlog"|"board"|"archive"|"agents"|"worktree"|"settings"})`
- Views use singular "worktree" (not "worktrees") in the navigation API — align the store's ViewType mapping accordingly

</specifics>

<deferred>
## Deferred Ideas

- OS-level protocol handler (maestro:// deep links from outside the app) — not in this phase
- Navigation history / back-forward stack — explicitly out of scope for Phase 23
- Startup state restoration (remember last view across app restarts) — separate concern, defer

</deferred>

---

*Phase: 23-add-in-app-routing-for-deep-linking-to-specific-screens*
*Context gathered: 2026-03-28*
