# Phase 20: Refactor Frontend to use TanStack Query - Research

**Researched:** 2026-02-26
**Domain:** Frontend data fetching architecture, TanStack Query patterns, Tauri IPC integration
**Confidence:** HIGH

## Summary

This phase modernizes the frontend data layer by systematically replacing all direct Tauri IPC `invoke()` calls with TanStack Query hooks. The codebase already has TanStack Query installed (v5.90.21), a QueryProvider configured, and one exemplar pattern established in `useSshConnectionsQuery.ts`. The work involves:

1. Creating standardized query and mutation hooks in service files (not separate hooks folder)
2. Migrating 50+ direct `invoke()` calls across 14 components to use TanStack Query
3. Implementing consistent cache invalidation and refetching strategies
4. Achieving automatic caching, optimistic updates, and window-focus refetching across all data operations

The existing service layer (Phase 19) provides a solid foundation—all IPC calls are already centralized in `src/services/*.service.ts`. This phase wraps those services with TanStack Query hooks, replacing components' direct service calls with query hooks.

**Primary recommendation:** Create TanStack Query wrapper hooks in each service file (e.g., `src/services/task.service.ts` exports both `taskService` object AND `useTasksQuery`, `useCreateTaskMutation` hooks). Keep all data fetching logic together with service implementations.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TanStack Query | v5.90.21 | Server state management, caching, synchronization | Industry standard for React data fetching; reduces boilerplate; automatic refetching; optimistic updates |
| Tauri API | v2.10.1 | IPC communication with Rust backend | Already used; provides `invoke()` for command calls |
| React | v19.2.4 | UI framework | Already in use; TanStack Query integrates seamlessly |
| Zustand | v4.5.7 | Client state management (sidebar, UI state, board state) | Already in use; complements TanStack Query (server vs client state) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Immer | v10.2.0 | Immutable state updates | Already integrated with Zustand; used for client state mutations |
| React Hook Form | v7.71.2 | Form state management | Already used; orthogonal to data fetching |
| Sonner | v1.7.4 | Toast notifications | Already used; display errors/success messages from mutations |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| TanStack Query | Manual fetch + useState | Less boilerplate initially but no caching, refetching, deduplication, optimistic updates—escalates complexity with real features |
| TanStack Query | SWR | Lighter weight but less feature-rich; TanStack Query 5 is more mature for complex scenarios |
| Zustand for server state | Redux | Over-engineered for this app's needs; Zustand + TanStack Query separation is cleaner |

**Installation:**
```bash
# Already installed
pnpm ls @tanstack/react-query
# → @tanstack/react-query@5.90.21
```

## Architecture Patterns

### Recommended Project Structure

Current state (post-Phase 19):
```
src/
├── services/          # Centralized IPC wrappers (Phase 19)
│   ├── ipc.ts         # Low-level invoke wrapper
│   ├── task.service.ts    # Task operations + query hooks (to add)
│   ├── project.service.ts # Project operations + query hooks (to add)
│   ├── execution.service.ts
│   ├── settings.service.ts
│   ├── connection.service.ts
│   └── index.ts
├── store/
│   ├── boardStore.ts  # Zustand: client-side task UI state (board view, terminal, retry tracking)
│   └── projectStore.ts
├── utils/
│   ├── hooks/         # Client-side hooks (useRecentProjects, useSshConnectionManager)
│   └── helpers/
└── components/        # React UI components (use query hooks via services)
```

### Pattern 1: Query Hooks in Service Files

**What:** Co-locate TanStack Query hooks with their corresponding service methods. Hooks wrap service methods and manage caching/refetching.

**When to use:** Always. For every service method that fetches data, create a `useXyzQuery` hook in the same service file.

**Example:**
```typescript
// src/services/task.service.ts

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc";
import type { Task, CreateTaskRequest } from "@/types/bindings";

// Export query key factory for consistency and cache invalidation
export const taskQueryKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskQueryKeys.all, "list"] as const,
  list: (projectId: number) => [...taskQueryKeys.lists(), { projectId }] as const,
  details: () => [...taskQueryKeys.all, "detail"] as const,
  detail: (taskId: number) => [...taskQueryKeys.details(), taskId] as const,
  logs: () => [...taskQueryKeys.all, "logs"] as const,
  logsByTask: (taskId: number) => [...taskQueryKeys.logs(), { taskId }] as const,
};

// Service object (Phase 19 pattern—unchanged)
export const taskService = {
  async getTasks(projectId: number): Promise<Task[]> {
    return ipc.invoke<Task[]>("get_tasks", { projectId });
  },
  async createTask(request: CreateTaskRequest): Promise<Task> {
    return ipc.invoke<Task>("create_task", { request });
  },
  // ... other methods
};

// Query hook: fetch all tasks for a project
export function useTasksQuery(projectId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(projectId!),
    queryFn: () => taskService.getTasks(projectId!),
    enabled: projectId !== null, // Prevent query if projectId not ready
    staleTime: 30000, // 30 seconds—tasks don't change frequently
    refetchOnWindowFocus: true, // Refetch when user returns to tab
  });
}

// Query hook: fetch a single task by ID
export function useTaskQuery(taskId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.detail(taskId!),
    queryFn: () => taskService.getTaskDetails(taskId!),
    enabled: taskId !== null,
    staleTime: 60000, // 1 minute
  });
}

// Mutation hook: create a new task
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateTaskRequest) => taskService.createTask(request),
    onSuccess: () => {
      // Invalidate list so it refetches with new task
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}

// Mutation hook: update task status (with optimistic update)
export function useUpdateTaskStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, status }: { taskId: number; status: string }) =>
      taskService.updateTaskStatus(taskId, status),
    onMutate: async ({ taskId, status }) => {
      // Cancel outgoing queries so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: taskQueryKeys.detail(taskId) });

      // Snapshot previous value for rollback
      const previousTask = queryClient.getQueryData(taskQueryKeys.detail(taskId));

      // Optimistically update the cache
      queryClient.setQueryData(taskQueryKeys.detail(taskId), (old: Task | undefined) => {
        if (!old) return old;
        return { ...old, status };
      });

      return { previousTask };
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousTask) {
        queryClient.setQueryData(taskQueryKeys.detail(variables.taskId), context.previousTask);
      }
    },
    onSettled: (data, error, variables) => {
      // Always refetch detail and invalidate list
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(variables.taskId) });
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}
```

**Why this pattern:**
- Keeps query keys and hooks centralized with business logic
- Eliminates repetition across components
- Makes cache invalidation strategies explicit
- Service file becomes single source of truth for data operations

### Pattern 2: Using Query Hooks in Components

**What:** Components import and call query hooks instead of directly calling service methods or invoking commands.

**Example (before):**
```typescript
// BEFORE: Direct service call with manual state
const [tasks, setTasks] = useState<Task[]>([]);
const [isLoading, setIsLoading] = useState(true);

useEffect(() => {
  const load = async () => {
    try {
      const data = await taskService.getTasks(projectId);
      setTasks(data);
    } catch (err) {
      console.error("Failed to load tasks", err);
    } finally {
      setIsLoading(false);
    }
  };
  load();
}, [projectId]);
```

**After:**
```typescript
// AFTER: Query hook handles all state
const { data: tasks = [], isLoading, error } = useTasksQuery(projectId);

if (error) {
  toast.error("Failed to load tasks");
}
```

### Pattern 3: Mutation with Error/Success Feedback

**What:** Mutations integrate with Sonner toast for user feedback; optimistic updates for instant UI response.

**Example:**
```typescript
function TaskCard({ task }: { task: Task }) {
  const { mutate: updateStatus } = useUpdateTaskStatusMutation();

  const handleStatusChange = (newStatus: TaskStatus) => {
    updateStatus(
      { taskId: task.id, status: newStatus },
      {
        onSuccess: () => {
          toast.success(`Task moved to ${newStatus}`);
        },
        onError: (error) => {
          toast.error(`Failed to update task: ${error.message}`);
        },
      }
    );
  };

  return (
    <Card>
      <p>{task.title}</p>
      <Button onClick={() => handleStatusChange("Done")}>Mark Done</Button>
    </Card>
  );
}
```

### Anti-Patterns to Avoid

- **Direct invoke() calls in components:** Use query hooks instead
  - Bad: `const result = await invoke('get_tasks', { projectId })`
  - Good: `const { data } = useTasksQuery(projectId)`

- **Multiple query keys for same data:** Creates cache fragmentation
  - Bad: Using `['tasks']`, `['task-list']`, `['all-tasks']` interchangeably
  - Good: Use centralized `taskQueryKeys` factory in service file

- **Manual refetching when cache invalidation would work:** Defeats TanStack Query's purpose
  - Bad: `refetch()` after every mutation
  - Good: Invalidate query keys; TanStack Query handles refetch automatically

- **Storing server state in Zustand:** Duplicates cache, causes sync issues
  - Bad: Setting `useBoardStore.loadTasks(tasks)` when query hook is better
  - Good: Use TanStack Query for server state; Zustand only for UI state (terminal open/close, sidebar collapsed, etc.)

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| "I'll just fetch data in useEffect and useState" | Manual fetch + state management | TanStack Query | Manual approach breaks with: refetching on window focus, deduplication of identical requests, automatic retry on failure, cache management, stale-while-revalidate pattern |
| "I'll invalidate cache manually by calling refetch()" | Custom refetch logic | `queryClient.invalidateQueries()` | TanStack Query handles timing, request deduplication, and background refetching automatically |
| "I need optimistic updates—I'll update state before calling service" | Manual optimistic updates | `useMutation.onMutate()` | TanStack Query provides built-in rollback, snapshotting, and error recovery |
| "I'll call the same endpoint twice for data consistency" | Duplicate calls | Single query hook + cache sharing | Automatic deduplication; all components see same cached data |

**Key insight:** TanStack Query eliminates the entire class of "data consistency" bugs that arise from manual state management. The cost of NOT using it grows with app complexity.

## Common Pitfalls

### Pitfall 1: Query Key Mismatches Between Mutation Invalidation and Query Definition

**What goes wrong:** Mutation invalidates `['tasks']` but component queries `['tasks', { projectId }]`. Cache invalidation misses, component doesn't refetch.

**Why it happens:** Query key structure not centralized; inconsistent between query definition and invalidation.

**How to avoid:** Export query key factory from service file (e.g., `taskQueryKeys`). Both queries and mutations use the factory.

```typescript
// WRONG
useQuery({ queryKey: ['tasks', projectId], ... })
// Later in mutation
queryClient.invalidateQueries({ queryKey: ['tasks'] }) // Misses!

// RIGHT
const queryKeys = { list: (pid) => ['tasks', pid] };
useQuery({ queryKey: queryKeys.list(projectId), ... })
queryClient.invalidateQueries({ queryKey: queryKeys.list(projectId) })
```

**Warning signs:** After mutation succeeds, UI doesn't update or shows stale data.

### Pitfall 2: Forgetting to Set `enabled: false` on Dependent Queries

**What goes wrong:** Query runs with undefined/null params, throws error, retries indefinitely.

**Why it happens:** Component hasn't loaded required data (e.g., projectId) yet, but query runs anyway.

**How to avoid:** Always check dependencies: `enabled: projectId !== null`.

```typescript
// WRONG
useTasksQuery(projectId) // projectId could be null

// RIGHT
useTasksQuery(projectId) inside useQuery with `enabled: projectId !== null`
```

**Warning signs:** Errors in console on mount; redundant API calls before data is ready.

### Pitfall 3: Query State vs Mutation State Confusion

**What goes wrong:** Component accesses `data` from query hook for mutation results, causing stale data display.

**Why it happens:** Misunderstanding that `useQuery` returns cached data, not mutation response.

**How to avoid:** Query hooks return cache; mutations are for writes. Use appropriate hook for each operation.

```typescript
// WRONG - using query data after mutation
const { data: tasks } = useTasksQuery(projectId);
const { mutate: createTask } = useCreateTaskMutation();
// After mutation, 'tasks' still shows old list until refetch

// RIGHT - mutation triggers cache invalidation
useCreateTaskMutation() on success invalidates query, TanStack Query refetches automatically
```

**Warning signs:** UI doesn't update after create/update/delete operations.

### Pitfall 4: Aggressive Caching Settings Breaking Real-Time Expectations

**What goes wrong:** Task status set to `staleTime: 5 * 60 * 1000` (5 min), user edits task, returns to board, sees old status for 5 minutes.

**Why it happens:** Cache freshness misconfigured for data volatility.

**How to avoid:** Choose `staleTime` based on expected data change frequency:
- **Project list** (rarely changes): 5-10 minutes
- **Task status** (changes often): 30 seconds
- **Execution logs** (real-time): 5-10 seconds or refetch on specific events
- **Settings** (rarely changes): 10+ minutes

```typescript
// Task status changes frequently, so keep cache fresh
staleTime: 30000, // 30 seconds

// But don't refetch too aggressively
refetchInterval: false, // Don't poll; use explicit invalidation instead
```

**Warning signs:** Users see stale data; complaints about status not updating.

### Pitfall 5: Refetching More Than Necessary

**What goes wrong:** Every blur/focus event triggers full app refetch; hundreds of queries firing; app freezes.

**Why it happens:** Turning on all refetching options globally without considering impact.

**How to avoid:** Opt-in to refetching per query based on data volatility:
- `refetchOnWindowFocus: true` for data that changes externally (board status)
- `refetchOnWindowFocus: false` for data that only changes through this app (local settings)

```typescript
// WRONG - refetch everything aggressively
new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      refetchInterval: 5000, // Every 5 seconds!
    }
  }
})

// RIGHT - conservative defaults, opt-in per query
new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchInterval: false,
    }
  }
})
// Then per query:
useTasksQuery({ refetchOnWindowFocus: true }) // Only tasks, not everything
```

**Warning signs:** High CPU/network during idle time; janky UI.

## Code Examples

Verified patterns from official TanStack Query documentation (HIGH confidence).

### Creating a Service with Query and Mutation Hooks

```typescript
// Source: https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
// Source: https://github.com/tanstack/query/blob/main/docs/framework/react/guides/query-keys.md

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc";
import type { Project } from "@/types/bindings";

// Query key factory - single source of truth
export const projectQueryKeys = {
  all: ["projects"] as const,
  lists: () => [...projectQueryKeys.all, "list"] as const,
  list: () => [...projectQueryKeys.lists()] as const,
  details: () => [...projectQueryKeys.all, "detail"] as const,
  detail: (id: number) => [...projectQueryKeys.details(), id] as const,
};

// Service methods (from Phase 19)
export const projectService = {
  async getProjects(): Promise<Project[]> {
    return ipc.invoke<Project[]>("get_projects");
  },
  async getProject(projectId: number): Promise<Project> {
    return ipc.invoke<Project>("get_project", { projectId });
  },
  async createProject(name: string, path: string, description?: string): Promise<Project> {
    return ipc.invoke<Project>("create_project", { name, path, description });
  },
};

// Query hooks
export function useProjectsQuery() {
  return useQuery({
    queryKey: projectQueryKeys.list(),
    queryFn: () => projectService.getProjects(),
    staleTime: 5 * 60 * 1000, // 5 minutes - projects don't change often
    refetchOnWindowFocus: true, // Refetch if user switches windows
  });
}

export function useProjectQuery(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.detail(projectId!),
    queryFn: () => projectService.getProject(projectId!),
    enabled: projectId !== null, // Don't run if no projectId
    staleTime: 5 * 60 * 1000,
  });
}

// Mutation hooks
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ name, path, description }: { name: string; path: string; description?: string }) =>
      projectService.createProject(name, path, description),
    onSuccess: () => {
      // After creating project, invalidate project list so it refetches
      queryClient.invalidateQueries({ queryKey: projectQueryKeys.lists() });
    },
  });
}
```

### Using Query Hooks in Components

```typescript
// Source: https://tanstack.com/query/latest/docs/framework/react/guides/queries

import { useProjectsQuery, useCreateProjectMutation } from "@/services/project.service";
import { toast } from "sonner";

function ProjectList() {
  const { data: projects = [], isLoading, error } = useProjectsQuery();
  const { mutate: createProject, isPending } = useCreateProjectMutation();

  if (isLoading) return <div>Loading projects...</div>;
  if (error) {
    toast.error("Failed to load projects");
    return <div>Error loading projects</div>;
  }

  const handleCreate = async () => {
    createProject(
      { name: "New Project", path: "/path/to/project" },
      {
        onSuccess: () => {
          toast.success("Project created");
        },
        onError: (error) => {
          toast.error(`Failed to create project: ${error.message}`);
        },
      }
    );
  };

  return (
    <div>
      <button onClick={handleCreate} disabled={isPending}>
        Create Project
      </button>
      <ul>
        {projects.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Optimistic Updates with Rollback

```typescript
// Source: https://github.com/tanstack/react-query/blob/main/docs/guides/optimistic-updates.md

export function useUpdateTaskStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, status }: { taskId: number; status: string }) =>
      taskService.updateTaskStatus(taskId, status),

    // Step 1: Optimistic update (before server response)
    onMutate: async ({ taskId, status }) => {
      // Cancel any pending refetches to prevent overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: taskQueryKeys.detail(taskId) });

      // Save previous value for rollback
      const previousTask = queryClient.getQueryData(taskQueryKeys.detail(taskId));

      // Update cache optimistically
      queryClient.setQueryData(taskQueryKeys.detail(taskId), (old: Task | undefined) => {
        if (!old) return old;
        return { ...old, status };
      });

      return { previousTask, taskId };
    },

    // Step 2: If server fails, rollback
    onError: (err, variables, context) => {
      if (context?.previousTask) {
        queryClient.setQueryData(taskQueryKeys.detail(context.taskId), context.previousTask);
      }
      toast.error(`Failed to update task: ${err.message}`);
    },

    // Step 3: Always sync with server
    onSettled: (data, error, variables) => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(variables.taskId) });
    },
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual fetch + useState in each component | TanStack Query hooks in service files | ~2022-present | Eliminated entire class of data consistency bugs; automatic caching/deduplication; optional UI improvements (optimistic updates) |
| Zustand for all state (server + UI) | Zustand for UI state + TanStack Query for server state | Industry best practice (2023+) | Clear separation of concerns; Zustand for UI (sidebar collapsed, modal open); TanStack Query for server state (tasks, projects) |
| Global refetch() calls on mutation | Cache invalidation via queryClient.invalidateQueries() | TanStack Query v4+ standard | Automatic refetch on appropriate queries; background updates; stale-while-revalidate pattern |

**Deprecated/outdated:**
- React Query (v3): Renamed to TanStack Query in v4; current version is v5. Code patterns compatible but use v5 API.
- Class-based component data fetching: Hooks + TanStack Query is modern standard.

## Open Questions

1. **Should mutations always invalidate entire query list, or target specific items?**
   - What we know: TanStack Query supports both strategies
   - What's unclear: Trade-off between precision (update one item) vs simplicity (invalidate list)
   - Recommendation: Start with list invalidation for simplicity; optimize to item updates if performance becomes issue. Example: `createTask` mutation invalidates `taskQueryKeys.lists()` to refetch entire list, not individual items.

2. **How should real-time execution logs be handled—polling vs WebSocket vs interval refetch?**
   - What we know: Current code uses polling; TanStack Query supports `refetchInterval`
   - What's unclear: Optimal interval for execution logs (very frequent changes); whether WebSocket is needed later
   - Recommendation: Phase 20 uses `refetchInterval: 5000` (5 sec) for execution logs. Phase 21+ can evaluate WebSocket for real-time streaming.

3. **Should terminal operations (send input, resize) use mutations, or remain service calls?**
   - What we know: Terminal operations don't fetch data; they're side-effects
   - What's unclear: Whether `useMutation` is appropriate for non-data operations
   - Recommendation: Terminal operations (send_terminal_input, resize_terminal, attach_terminal) can remain as service calls. Only wrap in `useMutation` if we need optimistic UI feedback; currently not needed.

4. **How to handle dependent queries (e.g., fetch task only after projectId loads)?**
   - What we know: TanStack Query supports `enabled` option
   - What's unclear: Best practice for deeply nested dependencies
   - Recommendation: Use `enabled: projectId !== null` pattern. If 3+ levels deep, consider refactoring component or using data fetching at higher level.

## Sources

### Primary (HIGH confidence)
- /tanstack/query (v5.90.21) - Official TanStack Query documentation, 1212 code snippets
  - Queried: useQuery hook configuration, useMutation patterns, cache invalidation, query keys, optimistic updates
- /tauri-apps/tauri-docs (v2) - Official Tauri documentation
  - Queried: invoke command API, IPC communication from frontend

### Secondary (HIGH confidence - verified with official docs)
- Existing code patterns:
  - `src/utils/hooks/useSshConnectionsQuery.ts` - Exemplar TanStack Query hook with optimistic updates (already in codebase)
  - `src/services/*.service.ts` - Existing service layer from Phase 19 (all IPC calls centralized)
  - `src/providers/QueryProvider.tsx` - Existing QueryClient configuration

### Implementation Reference
- Phase 19 established service layer with centralized IPC wrapper (`src/services/ipc.ts`)
- 31 IPC calls already migrated from components to service layer (Phase 19-04)
- QueryProvider already configured in App.tsx (phase 14+)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - TanStack Query v5 is industry standard; installation and APIs verified with official docs
- Architecture: HIGH - Existing exemplar pattern (useSshConnectionsQuery.ts) demonstrates exact approach; service layer foundation established
- Pitfalls: HIGH - Common mistakes documented in official TanStack Query guides; tested patterns available
- Implementation scope: HIGH - 14 files with direct invoke() imports identified; service layer already exists; clear migration path

**Research date:** 2026-02-26
**Valid until:** 2026-04-02 (stable library, ~5 weeks before potential patch)

## Current Architecture Summary

**Phase 19 Established:**
- Service layer: `src/services/{task,project,execution,settings,connection}.service.ts` + IPC wrapper
- QueryProvider: Configured with defaults (retry: 1, staleTime: 0 by default)
- Example pattern: `useSshConnectionsQuery.ts` with query + mutation hooks + optimistic updates

**Direct invoke() Calls to Migrate (14 files):**
1. `src/App.tsx` - loads settings
2. `src/components/common/ApprovalForm.tsx` - review operations
3. `src/components/common/ReviewModal.tsx` - review operations
4. `src/components/common/SyncButton.tsx` - sync github/jira issues
5. `src/components/execution/ExecutionTerminal.tsx` - terminal operations
6. `src/components/execution/Terminal.tsx` - terminal operations
7. `src/components/project-picker/FilePicker.tsx` - file operations
8. `src/components/task/ImportSettings.tsx` - import configuration
9. `src/components/kanban/TaskCard.tsx` - task operations
10. `src/components/kanban/TaskModal.tsx` - task operations
11. `src/utils/hooks/useRecentProjects.ts` - settings operations
12. `src/utils/hooks/useSshConnectionManager.ts` - SSH operations (partially—already using invoke)
13. `src/utils/hooks/useSshConnectionsQuery.ts` - SSH queries (EXEMPLAR—already proper pattern)
14. `src/services/ipc.ts` - Low-level wrapper (keep as-is)

**Data Operations Requiring Query/Mutation Hooks:**
- Tasks: get, create, update status, update settings, get logs, retry execution, cancel execution
- Projects: get all, get one, create, remove, get settings, update settings, save import config
- Execution: spawn execution, pause, resume, attach terminal, send input, resize, detach
- Settings: get, save, get system accent color
- Connections: SSH operations, file browsing operations
- Reviews: get diff, approve/reject task

**Total estimated hooks to create:** ~40-50 hooks (queries + mutations across 6 services)
