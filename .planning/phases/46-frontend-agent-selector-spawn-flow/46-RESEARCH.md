# Phase 46: Frontend: Agent Selector + Spawn Flow — Research

**Researched:** 2026-04-21
**Domain:** React/TypeScript frontend — modal UI, TanStack Query, service layer
**Confidence:** HIGH

---

## Summary

Phase 46 adds three capabilities to the existing Agents view: (1) a searchable agent selector modal backed by the `fetch_agent_registry` IPC added in Phase 45, (2) a spawn flow that calls `spawn_acp_session` (Phase 44) when the user selects an agent and worktree, and (3) a session-type badge ("ACP" vs "Interactive") in the `AgentMonitor` sidebar.

All IPC commands needed by this phase are already wired and typed in `src/types/bindings.ts`. The TypeScript types `RegistryResponse`, `AgentInfo`, `AgentDistribution`, and `ExecutionWithTask.execution_mode` (string | null) are all present in the current `bindings.ts`. The `api` proxy wrapper in `tauri-utils.ts` auto-unwraps Result types, so new service hooks follow the same pattern as `useExecutionsWithTaskInfoQuery`.

The phase is entirely frontend work: no new Rust IPC commands, no schema changes, no TypeScript binding regeneration required.

**Primary recommendation:** Add an `AgentSelectorDialog` component, a `useSpawnAcpSessionMutation` service hook, a `useAgentRegistryQuery` service hook, and modify `AgentMonitor` to show session-type badges. Wire into `AgentsView` as a new spawn dialog path alongside the existing PTY spawn dialog.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Agent registry data fetch + caching | Backend (Rust AppState) | Frontend (TanStack Query) | CDN fetch + 5-min TTL cache already in AppState (Phase 45); frontend holds a short-lived React Query cache for display |
| Agent search/filter UI | Browser/Client | — | Pure client-side filter over the fetched agent list; no server involvement |
| Spawn ACP session | Backend (Rust IPC) | Frontend (TanStack Query mutation) | `spawn_acp_session` launches maestro-server subprocess; frontend calls via mutation hook |
| Session-type badge rendering | Browser/Client | — | `execution_mode` field on `ExecutionWithTask` drives badge; no new data fetch needed |
| Worktree selection for spawn | Frontend (query) | Backend (Rust IPC) | `useWorktreesQuery` already in use in `AgentsView`; reuse existing data |

---

## Standard Stack

### Core (already in project — no new installs needed)

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| React 19 | ^19.2.5 | Component tree | [VERIFIED: package.json] |
| TanStack Query | ^5.96.2 | Server state, query/mutation hooks | [VERIFIED: package.json] |
| Zustand | ^4.5.7 | Client state (stores) | [VERIFIED: package.json] |
| shadcn/ui (via `@base-ui/react`) | ^1.3.0 | Dialog, Select, Input, Badge, Command | [VERIFIED: package.json] |
| cmdk | ^1.1.1 | `CommandDialog` / `CommandInput` for fuzzy search | [VERIFIED: package.json] |
| lucide-react | ^1.7.0 | Icons | [VERIFIED: package.json] |
| sonner | ^1.7.4 | Toast notifications | [VERIFIED: package.json] |
| Vitest + happy-dom | project-level | Unit tests | [VERIFIED: vite.config.ts] |

**Installation:** No new packages required. All dependencies are already installed.

---

## Architecture Patterns

### System Architecture Diagram

```
AgentsView (view-level orchestrator)
    |
    +-- useWorktreesQuery()            <- existing, reuse for worktree select
    +-- useExecutionsWithTaskInfoQuery() <- existing, shows sessions in sidebar
    +-- useAgentRegistryQuery()         <- NEW hook in execution.service.ts
    +-- useSpawnAcpSessionMutation()    <- NEW hook in execution.service.ts
    |
    +--> AgentMonitor (pure display)
    |       +-- session list items -> execution_mode badge (NEW: "ACP" / "Interactive")
    |
    +--> [existing] PTY spawn Dialog  (unchanged -- spawnInteractiveExecution path)
    |
    +--> [NEW] AgentSelectorDialog
            +-- useAgentRegistryQuery() (fetched on modal open)
            +-- CommandDialog + CommandInput (search/filter agents)
            +-- AgentInfo list items (name, description)
            +-- worktree Select (reuse worktrees from parent)
            +-- session name Input
            +-- Spawn button -> useSpawnAcpSessionMutation.mutate()
```

### Recommended Project Structure

```
src/
+-- components/execution/
|   +-- AgentSelectorDialog.tsx   <- NEW: modal with agent search + worktree select
+-- services/
|   +-- execution.service.ts      <- ADD: useAgentRegistryQuery, useSpawnAcpSessionMutation
+-- views/
    +-- AgentsView.tsx             <- MODIFY: wire AgentSelectorDialog + badge trigger
```

AgentMonitor.tsx changes are minimal: add a badge render to each sidebar list item based on `execution.execution_mode === "acp"`.

### Pattern 1: Service Hook for Agent Registry

The `api` proxy in `tauri-utils.ts` auto-unwraps Result. New hooks follow the established pattern:

```typescript
// Source: src/services/execution.service.ts (existing pattern)
export const registryQueryKeys = {
  all: ["agentRegistry"] as const,
  fetch: () => [...registryQueryKeys.all, "fetch"] as const,
};

export function useAgentRegistryQuery(enabled: boolean) {
  return useQuery({
    queryKey: registryQueryKeys.fetch(),
    queryFn: () => api.fetchAgentRegistry(false),
    enabled,
    staleTime: 5 * 60 * 1000, // mirror backend 5-min TTL
    gcTime: 10 * 60 * 1000,
  });
}

export function useSpawnAcpSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      cwd,
      sessionName,
    }: {
      agentId: string;
      cwd: string;
      sessionName: string | null;
    }) => {
      return await api.spawnAcpSession(agentId, cwd, sessionName);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.all });
    },
    onError: (error) => {
      toast.error(`Failed to spawn ACP session: ${error}`);
    },
  });
}
```

[VERIFIED: pattern matches existing hooks in execution.service.ts]

### Pattern 2: AgentSelectorDialog Component Structure

The existing `AgentsView.tsx` spawn dialog uses `Dialog` + `Select` + `Input` from shadcn/ui. The new agent selector dialog adds a `CommandDialog` layer for search -- the `CommandDialog` component in `src/components/ui/command.tsx` is a Dialog wrapping `CommandPrimitive` from cmdk:

```typescript
// Source: src/components/ui/command.tsx (existing component)
// Use CommandDialog for the entire agent selector OR use
// Dialog + Command embedded inside DialogContent for two-step UX.

// Recommended: single Dialog with embedded Command for agent search
// Step 1: search agents (Command list)
// Step 2: after selecting agent, show worktree + session name fields inline
```

Two viable approaches:
1. **Single dialog, two-step**: Agent search at top (Command component inside DialogContent), worktree select and session name appear below after agent selection.
2. **CommandDialog wrapper**: Entire agent picker is a CommandDialog; pressing Enter confirms agent then transitions to a second dialog for worktree/name.

Approach 1 is simpler and consistent with the existing spawn dialog pattern in `AgentsView.tsx`. Approach 2 mirrors VS Code command palette UX but adds complexity.

**Recommendation:** Use Approach 1 -- single `Dialog` with `Command` embedded inside `DialogContent` for the search, plus existing `Select` and `Input` for worktree and session name below.

### Pattern 3: Conditional Fetch on Modal Open

The registry fetch should only fire when the dialog opens, not on AgentsView mount. Use the TanStack Query `enabled` flag tied to `showAgentSelectorDialog` state:

```typescript
// In AgentsView.tsx:
const [showAgentSelectorDialog, setShowAgentSelectorDialog] = useState(false);
const { data: registry } = useAgentRegistryQuery(showAgentSelectorDialog);
```

This fires the IPC only when the modal opens, and the 5-min `staleTime` prevents re-fetching on re-open within the TTL window.

[VERIFIED: TanStack Query `enabled` flag pattern -- used in useWorktreesQuery, useExecutionsWithTaskInfoQuery]

### Pattern 4: Session-Type Badge in AgentMonitor

`ExecutionWithTask` already has `execution_mode: string | null` [VERIFIED: bindings.ts line 1110]. In `AgentMonitor.tsx`, replace the existing "Interactive" badge logic:

```typescript
// Current code in AgentMonitor.tsx (line 114-118):
{!execution.task_name && (
  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium shrink-0">
    Interactive
  </span>
)}

// Replace with session-type badge:
<span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium shrink-0">
  {execution.execution_mode === "acp" ? "ACP" : "Interactive"}
</span>
```

Alternatively use the existing `Badge` component from `src/components/ui/badge.tsx`:
```typescript
import { Badge } from "@/ui/badge";
<Badge variant="outline" className="text-[10px]">
  {execution.execution_mode === "acp" ? "ACP" : "Interactive"}
</Badge>
```

[VERIFIED: Badge component exists at src/components/ui/badge.tsx with `outline` variant]

### Anti-Patterns to Avoid

- **Fetching registry on AgentsView mount**: The registry fetches from CDN. Fetching eagerly on mount adds latency and network load every project-open. Use `enabled: showAgentSelectorDialog`.
- **Storing selected agent in Zustand**: Agent selection is transient dialog state. Use local `useState` in `AgentsView`, not a store. Zustand stores are for persistent cross-view state.
- **Passing `worktrees` as a new IPC call in AgentSelectorDialog**: The parent `AgentsView` already fetches worktrees via `useWorktreesQuery`. Pass them as props to `AgentSelectorDialog` to avoid a duplicate fetch.
- **Using `execute_mode` string comparison without null guard**: `execution_mode` is `string | null`. Always guard: `execution.execution_mode === "acp"` safely handles null (evaluates false).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Searchable list with keyboard navigation | Custom filtered list + key handlers | `Command` / `CommandInput` / `CommandList` from `cmdk` | cmdk handles ARIA, keyboard navigation, fuzzy matching automatically |
| Result unwrapping for IPC calls | Manual `.status === "ok"` checks | `api` proxy from `tauri-utils.ts` | Already unwraps Result<T,E> across all commands |
| Agent registry caching | In-memory module variable | TanStack Query `staleTime` + backend TTL | Backend has 5-min TTL; frontend `staleTime: 5*60*1000` prevents redundant IPC calls |

---

## Common Pitfalls

### Pitfall 1: `cwd` Parameter for `spawn_acp_session`

**What goes wrong:** `spawn_acp_session` takes a `cwd: string` (working directory for the agent), not a `worktree_id`. The worktree path must be resolved from the selected `WorktreeWithStatus.path`.

**Why it happens:** The existing PTY spawn uses `worktree_id` as an optional parameter. The ACP spawn IPC uses `cwd` (absolute path string) directly.

**How to avoid:** Pass `selectedWorktree.path` as the `cwd` argument, not `selectedWorktree.id`.

**Warning signs:** Compilation error if passing `number` to `cwd: string` -- TypeScript catches this at build time.

### Pitfall 2: Stale Registry Data Shown Without Indication

**What goes wrong:** `RegistryResponse.stale: boolean` signals that CDN was unreachable and cached data is returned. If not surfaced, users may see outdated agent lists without knowing.

**Why it happens:** The backend returns `stale: true` silently when CDN is unreachable.

**How to avoid:** Check `registry?.stale` and show a muted notice ("Showing cached agents -- registry unavailable") in the dialog header.

### Pitfall 3: Dialog Open with Empty Worktree List

**What goes wrong:** If worktrees haven't loaded yet when the agent selector dialog opens, `selectedWorktree` defaults to `null` and the Spawn button stays disabled with no explanation.

**Why it happens:** `useWorktreesQuery` has a 5s poll interval -- it may not have the first result yet on cold project load.

**How to avoid:** Show a loading state or "No worktrees available" message when worktrees list is empty. Guard the Spawn button with a `!selectedWorktree` check and display the reason.

### Pitfall 4: "New Session" Button Ambiguity

**What goes wrong:** `AgentsView` currently has one "New Session" button that opens the PTY spawn dialog. Phase 46 adds an ACP spawn path. If both paths share the same button, the UX is confusing.

**Why it happens:** The existing button's `onSpawn` callback in `AgentMonitor` triggers the PTY dialog.

**How to avoid:** Keep the existing "New Session" button for PTY sessions. Add a separate "Spawn Agent" button (or a split-button / dropdown) that opens the `AgentSelectorDialog`. Alternatively rename and restructure the action bar in `AgentsView` to offer two distinct actions. The planner should decide the exact UX split -- this research flags it as an explicit decision point.

### Pitfall 5: `execution_mode` NULL for Pre-Existing Sessions

**What goes wrong:** PTY sessions created before Phase 44 may have `execution_mode = NULL` in the DB. The badge logic `execution_mode === "acp"` handles this correctly (null !== "acp"), but ensure the fallback label says "Interactive" not "PTY" or "Unknown".

**Why it happens:** Schema v11 added `execution_mode TEXT DEFAULT 'pty'` but existing rows retain NULL until updated.

**How to avoid:** Treat `execution_mode === "acp"` as the only affirmative check. Everything else (null, "pty", unknown) shows "Interactive".

---

## Code Examples

### AgentInfo type (from bindings.ts)

```typescript
// Source: src/types/bindings.ts (VERIFIED)
export type AgentInfo = {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  repository?: string | null;
  authors?: string[] | null;
  license?: string | null;
  icon?: string | null;
  website?: string | null;
  distribution: AgentDistribution;
}

export type RegistryResponse = {
  agents: AgentInfo[];
  cached: boolean;
  stale: boolean;
}
```

### Spawn ACP IPC (from bindings.ts)

```typescript
// Source: src/types/bindings.ts (VERIFIED)
async spawnAcpSession(
  agentId: string,
  cwd: string,
  sessionName: string | null
): Promise<Result<number, string>>
// Returns: log_id (i32) -- used as session key
```

### ExecutionWithTask session-type fields (from bindings.ts)

```typescript
// Source: src/types/bindings.ts (VERIFIED)
export type ExecutionWithTask = {
  id: number;
  task_id: number | null;
  task_name: string | null;
  session_name: string | null;
  branch_name: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  terminal_output: string | null;
  execution_mode: string | null;  // "acp" | "pty" | null
  agent_id: string | null;
}
```

### cmdk inside shadcn Dialog (existing components)

```typescript
// Source: src/components/ui/command.tsx (VERIFIED -- CommandDialog pattern)
// Use Command embedded in DialogContent for integrated agent search:
import {
  Command, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem
} from "@/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";

// Inside dialog:
<Command>
  <CommandInput placeholder="Search agents..." />
  <CommandList>
    <CommandEmpty>No agents found.</CommandEmpty>
    <CommandGroup>
      {agents.map((agent) => (
        <CommandItem
          key={agent.id}
          value={agent.name}
          onSelect={() => setSelectedAgent(agent)}
        >
          <div>
            <div className="font-medium">{agent.name}</div>
            {agent.description && (
              <div className="text-xs text-muted-foreground">{agent.description}</div>
            )}
          </div>
        </CommandItem>
      ))}
    </CommandGroup>
  </CommandList>
</Command>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct `invoke()` calls | `api` proxy + TanStack Query hooks | Phase 20 | All new service hooks must use `useQuery`/`useMutation` pattern |
| `commands` object direct use | `api` unwrapper via service layer | Phase 21 | No direct `commands.*` calls in components |
| Shared spawn dialog for all session types | Separate dialogs per session type | Phase 46 (this phase) | Keeps PTY and ACP spawn UX cleanly separated |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `AgentSelectorDialog` should be a separate component from the existing PTY spawn dialog | Architecture Patterns | If wrong, the planner may merge them -- acceptable alternative but adds conditional complexity |
| A2 | `WorktreeWithStatus.path` is the correct value for the `cwd` parameter in `spawn_acp_session` | Pitfall 1 | If wrong, agent spawns in wrong directory -- functional bug |

**Note on A2:** The `spawn_acp_session` IPC handler uses `cwd` as the working directory for the maestro-server subprocess. `WorktreeWithStatus.path` is the absolute path of the worktree on disk, which is the correct value. [VERIFIED: acp_handlers.rs passes `cwd` directly to `spawn_acp_process`]

---

## Open Questions (RESOLVED)

1. **Single "New Session" button or two separate buttons?**
   - What we know: `AgentsView` currently has one "New Session" button wired to PTY spawn. Phase 46 adds ACP spawn.
   - What's unclear: Should they be two buttons ("Terminal Session" + "Spawn Agent"), a dropdown from one button, or should the existing button be replaced by the ACP path entirely?
   - Recommendation: Planner should decide. Default suggestion: keep both as separate buttons in the action bar. PTY path stays as "Terminal Session", new "Spawn Agent" button opens `AgentSelectorDialog`.
   - RESOLVED: Two separate buttons. "Spawn Agent" in the AgentsView action bar opens AgentSelectorDialog for ACP sessions. "New Session" in the AgentMonitor sidebar continues to open the existing PTY dialog.

2. **Should `AgentSelectorDialog` live inside `AgentsView` or be a standalone file?**
   - What we know: Existing pattern places dialog state in the view (AgentsView.tsx) and the dialog JSX inline.
   - What's unclear: At ~100 lines the inline approach may get unwieldy if the agent selector has multi-step logic.
   - Recommendation: Extract `AgentSelectorDialog` as a separate component in `src/components/execution/AgentSelectorDialog.tsx`.
   - RESOLVED: Standalone file at `src/components/execution/AgentSelectorDialog.tsx`. The component manages its own registry query and spawn mutation internally; parent passes worktrees, open state, and onSpawned callback.

---

## Environment Availability

Step 2.6: SKIPPED -- this phase is purely frontend code/UI changes. No new external tools, services, CLIs, or runtimes beyond the existing project build chain. `pnpm build` and `pnpm test` are the only required commands; both are confirmed working from Phase 45 verification.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest + happy-dom |
| Config file | `vite.config.ts` (test section) |
| Quick run command | `pnpm test AgentSelector` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SPAWN-01 | Agent selector dialog shows agents from registry, filters by search | unit | `pnpm test AgentSelectorDialog` | Wave 0 |
| SPAWN-02 | Selecting agent + worktree + Spawn calls `spawnAcpSession` IPC | unit | `pnpm test AgentSelectorDialog` | Wave 0 |
| SPAWN-03 | ACP sessions show "ACP" badge; PTY/null sessions show "Interactive" | unit | `pnpm test AgentMonitor` | Wave 0 |

**Note:** SPAWN-02 requires mocking `@tauri-apps/api/core` (`invoke`) -- the existing test setup at `src/test/setup.ts` does not include a Tauri mock. The pattern for mocking Tauri IPC is established in Phase 40 tests (see `src/components/common/__tests__/DisconnectBackdrop.test.tsx`).

### Sampling Rate

- **Per task commit:** `pnpm test AgentSelectorDialog AgentMonitor`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src/components/execution/__tests__/AgentSelectorDialog.test.tsx` -- covers SPAWN-01, SPAWN-02
- [ ] `src/components/execution/__tests__/AgentMonitor.test.tsx` -- covers SPAWN-03
- [ ] Tauri IPC mock: `vi.mock("@tauri-apps/api/core")` -- needed by both test files

---

## Security Domain

No new security-relevant patterns introduced. This phase:
- Does not add network requests (registry CDN fetch already exists in Phase 45)
- Does not accept user-supplied file paths (cwd comes from `WorktreeWithStatus.path`, which is a DB-originated value from a git operation, not a user text field)
- Does not introduce new Tauri commands
- ASVS V5 Input Validation: The `agentId` passed to `spawn_acp_session` originates from the registry response (server-controlled, not free-form user input). No additional sanitization required on the frontend.

---

## Sources

### Primary (HIGH confidence)

- `src/types/bindings.ts` -- all IPC command signatures and types verified directly
- `src/views/AgentsView.tsx` -- existing spawn dialog pattern verified
- `src/components/execution/AgentMonitor.tsx` -- existing session list and badge rendering verified
- `src/services/execution.service.ts` -- TanStack Query hook patterns verified
- `src/services/worktree.service.ts` -- `useWorktreesQuery` pattern verified
- `src/components/ui/command.tsx` -- `CommandDialog`/`CommandInput` component verified
- `src/components/ui/badge.tsx` -- Badge variant options verified
- `src-tauri/src/ipc/acp_handlers.rs` -- `spawn_acp_session` signature and `cwd` semantics verified
- `.planning/phases/44-db-schema-acp-ipc-handlers/44-02-SUMMARY.md` -- ExecutionWithTask extensions confirmed
- `.planning/phases/45-agent-registry-fetch-caching/45-02-SUMMARY.md` -- registry types confirmed

### Secondary (MEDIUM confidence)

- `package.json` -- dependency versions verified
- `vite.config.ts` -- test configuration verified

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all dependencies already installed and verified in package.json
- Architecture: HIGH -- all IPC types and component patterns verified in codebase
- Pitfalls: HIGH -- derived from reading actual implementation of related phases (44, 45, existing AgentsView)
- Test patterns: HIGH -- Vitest setup and mock patterns visible in existing test files

**Research date:** 2026-04-21
**Valid until:** 2026-05-21 (stable frontend stack, no fast-moving deps)

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SPAWN-01 | User can browse and search available ACP agents by name and description in a modal | `useAgentRegistryQuery` fetches `RegistryResponse.agents: AgentInfo[]`; `CommandInput` + `CommandList` from cmdk handles search/filter |
| SPAWN-02 | User can spawn an ACP session by selecting an agent, choosing a worktree/branch, and clicking Spawn | `useSpawnAcpSessionMutation` calls `api.spawnAcpSession(agentId, cwd, sessionName)`; `cwd` = selected `WorktreeWithStatus.path`; on success, select returned `log_id` |
| SPAWN-03 | ACP sessions displayed with "ACP" badge in execution sidebar alongside PTY ("Interactive") sessions | `ExecutionWithTask.execution_mode: string \| null`; check `=== "acp"` for badge label; already propagated by Phase 44 DB extension |
</phase_requirements>
