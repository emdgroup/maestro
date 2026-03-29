# Phase 23: Add In-App Routing for Deep Linking - Research

**Researched:** 2026-03-28
**Domain:** React state management / in-app navigation (Zustand, Framer Motion)
**Confidence:** HIGH

## Summary

This phase replaces the local-state-based `usePageRouting` hook with a Zustand `navigationStore` that owns all navigation state globally. The store exposes a `navigate()` function accepting a discriminated union of navigation targets. Components subscribe directly via selector hooks — no prop-drilling.

The implementation is purely frontend TypeScript/React. There are no new dependencies to install. All required libraries (Zustand 4.5, Immer 10, Framer Motion 12) are already present. The main work is: (1) create the store, (2) rewire `App.tsx` to read from it, (3) lift KanbanView's `activeSubView` into the store, (4) wire entity views to consume `pendingXxxId` fields and clear them after consumption.

**Primary recommendation:** Create `src/store/navigationStore.ts` following the `configStore.ts` (Zustand + Immer) pattern, with `PAGE_ORDER` logic migrated from `usePageRouting` for slide direction calculation.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Scope — what "deep linking" means**
- Internal navigation only — no OS protocol registration, no URL bar
- Primary use case: programmatic navigation from within components (no prop-drilling, no event buses)
- No history stack — navigate() is fire-and-forget, no back/forward needed

**Navigate API contract**
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

**Routing mechanism**
- Extend/replace current `usePageRouting` hook with a **Zustand store** (`navigationStore`)
- Components access navigation via a `useNavigate()` hook
- The store holds: `activeTab: ViewType`, `activeSubView: SubView | null`, `pendingTaskId: string | null`, `pendingAgentId: string | null`, `pendingWorktreeId: string | null`
- App.tsx reads from the store instead of local state; KanbanView reads `activeSubView` from store instead of internal `useState`

**Entity presentation when navigating**
- `taskId` → open TaskDetail sheet (same behavior as clicking a task card). The pending entity ID in the store triggers the sheet to open once the view renders.
- `agentId` / `worktreeId` → highlight/focus the entity in the respective view (exact highlight UX is Claude's discretion)

**Sub-view routing**
- `backlog`, `board`, `archive` are already implemented as KanbanView sub-views
- Navigation store replaces KanbanView's internal `activeSubView` useState — the store owns sub-view state so external navigation can set it

### Claude's Discretion
- Exact highlight/focus UX for agentId and worktreeId navigation (scroll into view, border highlight, etc.)
- Transition animation behavior when navigating programmatically vs tab-click (can reuse existing slideVariants)
- Whether to clear pending entity IDs after they are consumed (likely yes, to avoid re-triggering on re-render)

### Deferred Ideas (OUT OF SCOPE)
- OS-level protocol handler (maestro:// deep links from outside the app) — not in this phase
- Navigation history / back-forward stack — explicitly out of scope for Phase 23
- Startup state restoration (remember last view across app restarts) — separate concern, defer
</user_constraints>

---

## Standard Stack

### Core (already installed — no new installs needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zustand | ^4.5.7 | Global navigation store | Already the project-wide state management solution |
| immer | ^10.2.0 | Immutable state updates in store | Used by all existing stores (boardStore, configStore) |
| framer-motion | ^12.38.0 | Slide direction animation on tab switch | Already powers all view transitions in App.tsx |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Zustand store | React Context | Context re-renders the entire subtree; Zustand allows granular selectors |
| Zustand store | TanStack Router / React Router | Overkill for internal-only navigation with no URL or history requirement |
| Zustand store | Event emitter / mitt | Harder to subscribe selectively; not idiomatic in this codebase |

**Installation:** None required. All dependencies are already present.

---

## Architecture Patterns

### Recommended File

```
src/store/navigationStore.ts   # New file — follows configStore.ts / projectStore.ts pattern
src/utils/hooks/usePageRouting.ts  # Keep file, re-export from navigationStore for backwards compat OR delete and update App.tsx import
```

### Pattern 1: Zustand + Immer Store with Selector Hooks

**What:** A single store file that holds state and exports named selector hooks. No barrel re-export needed.

**When to use:** All global UI state in this project follows this exact pattern.

**Example (from projectStore.ts — the simpler store pattern):**
```typescript
// src/store/projectStore.ts — reference shape (no Immer, simple create)
const useStore = create<ProjectStore>((set) => ({ ... }));
export const useSelectedProject = () => useStore((state) => state.selectedProject);
export const useSelectedProjectActions = () => useStore((state) => state.actions);
```

**Example (from configStore.ts / boardStore.ts — Immer pattern):**
```typescript
// Immer pattern used when state mutations are complex
export const useConfigStore = create<ConfigState>()(
  immer((set) => ({
    // state + actions co-located
  }))
);
```

**NavigationStore shape (to implement):**
```typescript
type ViewType = "kanban" | "agents" | "worktrees" | "settings";
type SubView = "backlog" | "board" | "archive";

interface NavigationState {
  activeTab: ViewType;
  slideDirection: number;           // 1 = forward, -1 = back — for framer-motion custom prop
  activeSubView: SubView;           // lifted from KanbanView.tsx local state
  pendingTaskId: string | null;
  pendingAgentId: string | null;
  pendingWorktreeId: string | null;
  // Actions
  navigate: (target: NavigationTarget) => void;
  clearPendingTask: () => void;
  clearPendingAgent: () => void;
  clearPendingWorktree: () => void;
  setActiveTab: (tab: ViewType) => void;      // for AppHeader tab clicks
  setActiveSubView: (sub: SubView) => void;   // for KanbanView sub-view toggler clicks
}
```

### Pattern 2: PAGE_ORDER for Slide Direction

**What:** `usePageRouting.ts` computes `slideDirection` by comparing old/new page index from a `PAGE_ORDER` record. This logic MUST move into `navigationStore.navigate()`.

**Current implementation (from `usePageRouting.ts`):**
```typescript
const PAGE_ORDER: Record<ViewType, number> = {
  kanban: 0,
  agents: 1,
  worktrees: 2,
  settings: 3,
};
// Direction: 1 = moving right (forward), -1 = moving left (back)
const direction = newIndex > currentIndex ? 1 : -1;
```

The `navigate()` action in the store calls this same logic before updating `activeTab`.

### Pattern 3: Pending Entity ID — Consume-and-Clear

**What:** When a component mounts (or when `pendingXxxId` changes), it reads the pending ID, acts on it (opens sheet, scrolls to entity), then calls `clearPendingXxx()` to prevent re-triggering on subsequent re-renders.

**When to use:** All three entity targets (taskId, agentId, worktreeId).

**Recommended implementation in consuming component:**
```typescript
// In App.tsx (for taskId → TaskDetail sheet):
const pendingTaskId = useNavigationStore(s => s.pendingTaskId);
const clearPendingTask = useNavigationStore(s => s.clearPendingTask);

useEffect(() => {
  if (pendingTaskId) {
    // look up task from boardStore.tasks, set selectedTask
    const task = tasks.find(t => String(t.id) === pendingTaskId) ?? null;
    setSelectedTask(task);
    clearPendingTask();
  }
}, [pendingTaskId]);
```

### Pattern 4: NavigationTarget Discriminated Union Dispatch

**What:** `navigate()` inspects which key is present in the target object and branches accordingly.

```typescript
navigate: (target: NavigationTarget) =>
  set((state) => {
    if ('taskId' in target) {
      state.activeTab = "kanban";
      state.activeSubView = "board";
      state.pendingTaskId = target.taskId;
      // compute slideDirection from current activeTab...
    } else if ('agentId' in target) {
      state.activeTab = "agents";
      state.pendingAgentId = target.agentId;
    } else if ('worktreeId' in target) {
      state.activeTab = "worktrees";
      state.pendingWorktreeId = target.worktreeId;
    } else if ('view' in target) {
      // map view string to ViewType + SubView
    }
  })
```

Note: the NavigationTarget `{ view: "worktree" }` (singular) maps to `activeTab = "worktrees"` (plural) — the store's `ViewType` uses the plural form already used by `usePageRouting`.

### Anti-Patterns to Avoid

- **Storing Task objects in navigation state:** Store only the ID. The task object lives in `boardStore`. App.tsx looks it up when consuming `pendingTaskId`.
- **Not clearing pending IDs:** A stale `pendingTaskId` causes the TaskDetail sheet to re-open on unrelated re-renders.
- **Putting `slideDirection` computation outside the store:** The direction depends on `state.activeTab` (before the update), so it must be computed inside the `set()` call where both old and new values are available.
- **Removing `usePageRouting` without updating the AppHeader path:** `AppHeader` currently calls `onViewChange` prop which goes to `handlePageChange` (from `usePageRouting`). After this phase, `onViewChange` must call `setActiveTab()` or `navigate({ view: ... })` from the store.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-component navigation | Event emitter, Context + callback prop-drilling | `useNavigationStore()` selector hook | Store gives subscriptions with fine-grained re-render control |
| Animation direction | Manual direction tracking | `slideDirection` field in store + existing `slideVariants` | Already implemented in `src/utils/constants/animations.ts` |
| View type mapping | Custom string comparison | Existing `ViewType` from `usePageRouting.ts` | Already defined and used across `AppHeader`, `App.tsx` |

---

## Integration Points (Exhaustive)

These are every place in the codebase that must change:

| File | Current State | Required Change |
|------|--------------|-----------------|
| `src/utils/hooks/usePageRouting.ts` | Local useState hook | Replace body to re-export from `navigationStore`, OR keep as compatibility shim, OR delete and update importers |
| `src/App.tsx:60` | `const { activePage, slideDirection, handlePageChange } = usePageRouting("kanban")` | Replace with store selectors: `useActiveTab()`, `useSlideDirection()`, `useNavigate()` |
| `src/App.tsx:48` | `const [selectedTask, setSelectedTask] = useState<Task | null>(null)` | Add `useEffect` that watches `pendingTaskId` and converts to `setSelectedTask` call |
| `src/App.tsx:99` | `activeView={activePage}` on `<AppHeader>` | Change to `activeView={activeTab}` from store |
| `src/App.tsx:102` | `onViewChange={handlePageChange}` on `<AppHeader>` | Change to call `setActiveTab()` from store |
| `src/views/KanbanView.tsx:28` | `const [activeSubView, setActiveSubView] = useState<SubView>("board")` | Replace with `useActiveSubView()` + `useSetActiveSubView()` from store |
| `src/views/AgentsView.tsx` | Stateless, receives `activeAgentId` as prop | Read `pendingAgentId` from store, implement highlight, call `clearPendingAgent()` |
| `src/views/WorktreesView.tsx` | Stateless, receives prop | Read `pendingWorktreeId` from store, implement highlight, call `clearPendingWorktree()` |
| `src/utils/hooks/index.ts` | Exports `usePageRouting` | Update if the hook is deleted or renamed |

---

## Common Pitfalls

### Pitfall 1: ViewType Mismatch — "worktree" vs "worktrees"

**What goes wrong:** The NavigationTarget API uses `{ view: "worktree" }` (singular) but `ViewType` and `AppHeader` use `"worktrees"` (plural). Passing the raw view string directly to `activeTab` will break tab highlighting.

**Why it happens:** The CONTEXT.md explicitly calls out that the API uses singular `"worktree"` to align with UX naming, while the internal store/component type uses plural.

**How to avoid:** Inside `navigate()`, map `"worktree"` → `"worktrees"` before setting `activeTab`. The `NavigationTarget` union uses `"worktree"` for the public API; `ViewType` remains `"worktrees"` internally.

### Pitfall 2: Slide Direction Computed Outside the Mutation

**What goes wrong:** If `slideDirection` is computed before calling `set()`, the current `activeTab` may already be stale in concurrent mode, or direction will be wrong for rapid navigation calls.

**How to avoid:** Compute direction inside the `set()` callback where `state.activeTab` is the pre-mutation value.

### Pitfall 3: Stale Pending Entity IDs

**What goes wrong:** `pendingTaskId` is set to "42". User navigates to board — TaskDetail opens. User closes it. Later, KanbanView re-renders for an unrelated reason. `useEffect` fires again, reopens TaskDetail for task 42.

**How to avoid:** Always call `clearPendingTask()` immediately after consuming the ID (in the same effect that opens the sheet). The `clearPendingTask` action sets the field to `null` so the effect does not re-run.

### Pitfall 4: App.tsx selectedTask vs pendingTaskId Mismatch

**What goes wrong:** `TaskDetail` currently takes a `Task | null` object (not an ID string). The `pendingTaskId` in the store is a string ID. The consuming code in App.tsx must look up the full task from `boardStore.tasks`.

**Why it happens:** The store does not hold Task objects — it holds minimal navigation state. The task object is owned by `boardStore`.

**How to avoid:** In App.tsx, the `useEffect` that watches `pendingTaskId` must call `useBoardStore.getState().getTasks()` or subscribe to `tasks` via `useBoardStore` to find the task object, then call `setSelectedTask(task)`.

### Pitfall 5: KanbanView Loses Its Search/Filter Local State

**What goes wrong:** `activeSubView` is the only state lifted to the store. The search strings and filter states (`archiveSearch`, `backlogSearch`, etc.) should remain as local `useState` in `KanbanView`. Only the sub-view switcher changes.

**How to avoid:** Do not over-lift. Only `activeSubView` moves to the store; all other KanbanView state stays local.

---

## Code Examples

### Creating the Store

```typescript
// src/store/navigationStore.ts
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ViewType } from "@/utils/hooks/usePageRouting";

type SubView = "backlog" | "board" | "archive";

export type NavigationTarget =
  | { taskId: string }
  | { agentId: string }
  | { worktreeId: string }
  | { view: "backlog" | "board" | "archive" | "agents" | "worktree" | "settings" };

const PAGE_ORDER: Record<ViewType, number> = {
  kanban: 0,
  agents: 1,
  worktrees: 2,
  settings: 3,
};

// Map NavigationTarget view strings to internal ViewType
function targetViewToTab(view: string): ViewType {
  if (view === "worktree") return "worktrees";
  if (view === "backlog" || view === "board" || view === "archive") return "kanban";
  return view as ViewType;
}

interface NavigationState {
  activeTab: ViewType;
  slideDirection: number;
  activeSubView: SubView;
  pendingTaskId: string | null;
  pendingAgentId: string | null;
  pendingWorktreeId: string | null;
  navigate: (target: NavigationTarget) => void;
  setActiveTab: (tab: ViewType) => void;
  setActiveSubView: (sub: SubView) => void;
  clearPendingTask: () => void;
  clearPendingAgent: () => void;
  clearPendingWorktree: () => void;
}

export const useNavigationStore = create<NavigationState>()(
  immer((set) => ({
    activeTab: "kanban",
    slideDirection: 1,
    activeSubView: "board",
    pendingTaskId: null,
    pendingAgentId: null,
    pendingWorktreeId: null,

    navigate: (target) =>
      set((state) => {
        if ("taskId" in target) {
          const newTab: ViewType = "kanban";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.activeSubView = "board";
          state.pendingTaskId = target.taskId;
        } else if ("agentId" in target) {
          const newTab: ViewType = "agents";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.pendingAgentId = target.agentId;
        } else if ("worktreeId" in target) {
          const newTab: ViewType = "worktrees";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.pendingWorktreeId = target.worktreeId;
        } else if ("view" in target) {
          const newTab = targetViewToTab(target.view);
          if (newTab !== state.activeTab) {
            state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          }
          state.activeTab = newTab;
          if (target.view === "backlog" || target.view === "board" || target.view === "archive") {
            state.activeSubView = target.view;
          }
        }
      }),

    setActiveTab: (tab) =>
      set((state) => {
        if (tab !== state.activeTab) {
          state.slideDirection = PAGE_ORDER[tab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
        }
        state.activeTab = tab;
      }),

    setActiveSubView: (sub) =>
      set((state) => {
        state.activeSubView = sub;
      }),

    clearPendingTask: () => set((state) => { state.pendingTaskId = null; }),
    clearPendingAgent: () => set((state) => { state.pendingAgentId = null; }),
    clearPendingWorktree: () => set((state) => { state.pendingWorktreeId = null; }),
  }))
);

// Selector hooks — consistent with useSelectedProject(), useSelectedProjectActions() pattern
export const useActiveTab = () => useNavigationStore((s) => s.activeTab);
export const useSlideDirection = () => useNavigationStore((s) => s.slideDirection);
export const useActiveSubView = () => useNavigationStore((s) => s.activeSubView);
export const usePendingTaskId = () => useNavigationStore((s) => s.pendingTaskId);
export const usePendingAgentId = () => useNavigationStore((s) => s.pendingAgentId);
export const usePendingWorktreeId = () => useNavigationStore((s) => s.pendingWorktreeId);
export const useNavigate = () => useNavigationStore((s) => s.navigate);
export const useNavigationActions = () =>
  useNavigationStore((s) => ({
    setActiveTab: s.setActiveTab,
    setActiveSubView: s.setActiveSubView,
    clearPendingTask: s.clearPendingTask,
    clearPendingAgent: s.clearPendingAgent,
    clearPendingWorktree: s.clearPendingWorktree,
  }));
```

### Consuming pendingTaskId in App.tsx

```typescript
// Inside App() component, after store replaces usePageRouting:
const pendingTaskId = usePendingTaskId();
const { clearPendingTask } = useNavigationActions();
const tasks = useBoardStore((s) => s.tasks);

useEffect(() => {
  if (pendingTaskId) {
    const task = tasks.find((t) => String(t.id) === pendingTaskId) ?? null;
    setSelectedTask(task);
    clearPendingTask();
  }
}, [pendingTaskId, tasks, clearPendingTask]);
```

### KanbanView — lifted sub-view state

```typescript
// Replace local useState in KanbanView.tsx:
// BEFORE: const [activeSubView, setActiveSubView] = useState<SubView>("board");
// AFTER:
const activeSubView = useActiveSubView();
const { setActiveSubView } = useNavigationActions();
```

### useNavigate hook usage from any component

```typescript
// Any component can navigate without props:
import { useNavigate } from "@/store/navigationStore";
const navigate = useNavigate();

// In a toast action callback:
navigate({ taskId: String(task.id) });
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Local useState in usePageRouting | Zustand store (navigationStore) | Phase 23 | Any component can navigate without prop drilling |
| KanbanView owns activeSubView locally | navigationStore owns activeSubView | Phase 23 | External callers can set sub-view |
| TaskDetail opened only via onTaskClick prop in KanbanProvider | TaskDetail opened via pendingTaskId from store | Phase 23 | Toasts, agents view, etc. can open task detail |

---

## Open Questions

1. **AgentId type — string or number?**
   - What we know: The NavigationTarget API specifies `{ agentId: string }`. But `AgentsViewProps` has `activeAgentId: number | null`. The CONTEXT.md uses `string` throughout the navigate API.
   - What's unclear: Whether `agentId` in the store should be `string | null` and converted at consumption, or whether the API should align to `number`.
   - Recommendation: Keep `string` in the store (matches the declared API). AgentsView converts with `parseInt(pendingAgentId, 10)` when consuming. Be consistent: the store is the source of the API shape.

2. **worktreeId type — same question**
   - Same situation as agentId. `WorktreesViewProps` uses `number` ids, but NavigationTarget uses `string`.
   - Recommendation: Same pattern — store holds `string | null`, view converts on consumption.

3. **No-op direction when already on same tab**
   - The current `usePageRouting` guard: `if (page === activePage) return;` prevents animation re-trigger.
   - Recommendation: Keep the same guard inside `setActiveTab()` — if `tab === state.activeTab`, skip direction recalculation and state update for the tab (sub-view can still update).

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — purely frontend code changes, all libraries already installed).

---

## Validation Architecture

`workflow.nyquist_validation` is not set in `.planning/config.json` (key absent) — treated as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `vite.config.ts` (Vitest co-located) |
| Quick run command | `pnpm test --run` |
| Full suite command | `pnpm test --run` |

### Phase Requirements → Test Map

No formal requirement IDs were provided for this phase. Behavioral coverage recommended:

| Behavior | Test Type | Automated Command | File Exists? |
|----------|-----------|-------------------|-------------|
| `navigate({ view: "board" })` sets `activeTab = "kanban"` and `activeSubView = "board"` | unit | `pnpm test --run navigationStore` | No — Wave 0 |
| `navigate({ taskId: "42" })` sets `activeTab = "kanban"`, `activeSubView = "board"`, `pendingTaskId = "42"` | unit | `pnpm test --run navigationStore` | No — Wave 0 |
| `navigate({ view: "worktree" })` maps to `activeTab = "worktrees"` | unit | `pnpm test --run navigationStore` | No — Wave 0 |
| `clearPendingTask()` nulls `pendingTaskId` | unit | `pnpm test --run navigationStore` | No — Wave 0 |
| Slide direction correct when navigating forward/backward | unit | `pnpm test --run navigationStore` | No — Wave 0 |

### Wave 0 Gaps

- [ ] `src/store/navigationStore.test.ts` — unit tests for store logic (navigate dispatch, pending IDs, slide direction, view name mapping)

---

## Sources

### Primary (HIGH confidence)

- Direct code inspection of `src/utils/hooks/usePageRouting.ts` — current hook to replace
- Direct code inspection of `src/App.tsx` — integration points for activeTab, slideDirection, selectedTask
- Direct code inspection of `src/views/KanbanView.tsx` — activeSubView local state to lift
- Direct code inspection of `src/store/boardStore.ts`, `src/store/projectStore.ts`, `src/store/configStore.ts` — store patterns to replicate
- Direct code inspection of `src/utils/constants/animations.ts` — slideVariants and PAGE_TRANSITION constants
- Direct code inspection of `src/components/common/AppHeader.tsx` — onViewChange wiring
- Direct code inspection of `src/views/AgentsView.tsx`, `src/views/WorktreesView.tsx` — entity view integration points
- Direct code inspection of `src/components/task/TaskDetail.tsx` — Task object consumption pattern

### Secondary (MEDIUM confidence)

- package.json: zustand@^4.5.7, immer@^10.2.0, framer-motion@^12.38.0 — version confirmation from registry entry

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries confirmed present from package.json, existing stores verified by code inspection
- Architecture: HIGH — patterns are directly observable from 4 existing Zustand stores in the codebase
- Integration points: HIGH — all 8 affected files read and integration points confirmed with line numbers from CONTEXT.md
- Pitfalls: HIGH — derived from direct reading of code (ViewType naming, direction logic, selectedTask vs pendingTaskId mismatch)

**Research date:** 2026-03-28
**Valid until:** 2026-04-28 (stable codebase — no moving dependencies)
