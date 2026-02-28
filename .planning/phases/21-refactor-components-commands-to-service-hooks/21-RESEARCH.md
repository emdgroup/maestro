# Phase 21: Refactor Components Using Commands Object - Research

**Researched:** 2026-02-28
**Domain:** React Component Architecture, IPC Service Layer Refactoring
**Confidence:** HIGH

## Summary

Phase 21 is a targeted cleanup phase following the completion of Phase 20 (TanStack Query migration). While Phase 20 successfully replaced all direct `invoke()` calls with TanStack Query hooks in the service layer, a small number of components and hooks (5 files, 15 usages) still directly import and use the `commands` object from `@src/types/bindings.ts`. These direct usages bypass the service layer abstraction and should be refactored to use existing service hooks or new wrapper hooks.

The codebase has already established:
- 5 domain-specific services with 37 TanStack Query hooks
- Centralized `api` proxy wrapper in src/utils/helpers/tauri-utils.ts that handles Result unwrapping
- Complete service layer patterns for task, project, settings, execution, and connection domains

This phase simply replaces the remaining 15 direct `commands.` calls with their service-layer equivalents.

**Primary recommendation:** Create service hooks for any remaining Tauri IPC operations not yet wrapped, then refactor the 5 files to use service hooks instead of direct commands.

## Current State

### Existing Service Architecture (Phase 19-20 Complete)

**Location:** `/src/services/`

Services established:
1. **task.service.ts** - 10+ hooks (useTasksQuery, useCreateTaskMutation, etc.)
2. **project.service.ts** - 10+ hooks (useProjectsQuery, useCreateProjectMutation, etc.)
3. **connection.service.ts** - 7 hooks (useSshConnectionsQuery, useCreateSshConnectionMutation, etc.)
4. **execution.service.ts** - 7+ mutation hooks
5. **settings.service.ts** - 3 hooks

All services:
- Use TanStack React Query (useQuery, useMutation, useQueryClient)
- Use query key factories for consistent cache invalidation
- Leverage the `api` proxy wrapper for automatic Result<T, E> unwrapping
- Include Sonner toast integration for error/success feedback

### Remaining Direct Commands Usage (15 occurrences)

Files still using `commands.` directly:

1. **src/utils/hooks/useSshConnectionManager.ts** (3 usages)
   - `commands.connectSshWithoutCredentials(connId)` (line 78)
   - `commands.saveSshConnection(...)` (line 121)
   - `commands.connectSshWithPassword(...)` (line 150)

2. **src/components/project-picker/ProjectList.tsx** (3 usages)
   - `commands.createProject(selectedPath, connectionId ?? null)` (line 38)
   - `commands.getProject(projectId)` (line 52)
   - `commands.removeProject(projectId)` (line 63)

3. **src/components/project-picker/FilePicker.tsx** (4 usages)
   - `commands.listLocalDirectories(path)` (line in mutationFn)
   - `commands.listRemoteDirectories(connectionId, path)` (line in mutationFn)
   - `commands.getDefaultFilePickerPath()` (line in mutationFn)
   - `commands.listDrives()` (line in mutationFn)

4. **src/components/project-picker/ConnectionHeader.tsx** (2 usages)
   - `commands.deleteSshConnection(connection.id)` (line)
   - `commands.forgetSavedPassword(connection.id)` (line)

5. **src/components/common/SettingsPage.tsx** (2 usages)
   - `commands.getProjectSettings(projectId)` (line 73)
   - `commands.updateProjectSettings(projectId, request)` (line)

6. **src/utils/helpers/tauri-utils.ts** (1 reference - comment only)
   - Line 19: `const projects = await unwrap(commands.getProjects());` - COMMENT ONLY

## Architecture Patterns

### Standard Service Hook Pattern (HIGH confidence)

All services follow this established pattern (verified in connection.service.ts, project.service.ts, task.service.ts):

```typescript
// Query hook
export function useProjectsQuery() {
  return useQuery({
    queryKey: projectQueryKeys.list(),
    queryFn: () => api.getProjects(),
    staleTime: Infinity,
  });
}

// Mutation hook
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, connectionId }: { path: string; connectionId: number }) =>
      api.createProject(path, connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list() });
    },
    onError: (error) => {
      toast.error(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
```

### API Proxy Pattern (HIGH confidence)

Source: `/src/utils/helpers/tauri-utils.ts`

The `api` proxy:
- Automatically unwraps `Result<T, E>` types from Tauri commands
- Throws errors for React Query error handling
- Maintains type safety through TypeScript Proxy typing
- Used by all 5 services as the standard IPC access pattern

```typescript
export const api = new Proxy(commands, {
  get(target, prop: string | symbol) {
    const original = target[prop as keyof typeof commands];
    if (typeof original === "function") {
      return async (...args: unknown[]) => {
        const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
        if (result && typeof result === "object" && "status" in result) {
          const typedResult = result as Result<unknown, unknown>;
          if (typedResult.status === "ok") {
            return typedResult.data;
          } else {
            throw new Error(String(typedResult.error));
          }
        }
        return result;
      };
    }
    return original;
  },
}) as unknown as UnwrapCommands<typeof commands>;
```

### Component Integration Pattern (HIGH confidence)

Components should use service hooks, not direct commands:

**Before (direct commands):**
```typescript
const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
  const result = await commands.createProject(selectedPath, connectionId ?? null);
  if (result.status === "ok") {
    setSelectedProject(result.data);
  }
};
```

**After (service hooks):**
```typescript
const createProjectMutation = useCreateProjectMutation();
const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
  const project = await createProjectMutation.mutateAsync({ path: selectedPath, connectionId: connectionId ?? 0 });
  setSelectedProject(project);
};
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Manual IPC Result unwrapping | Custom unwrap() utilities | `api` proxy wrapper (tauri-utils.ts) | Already built, type-safe, handles all edge cases |
| Per-component invoke() calls | Direct commands usage in components | Service hooks from services/ | Centralized caching, error handling, mutation coordination |
| Query state management | useState + useEffect for fetch logic | TanStack Query hooks | Handles loading/error/success states, deduplication, cache invalidation |
| File browser operations | Custom hooks | New service or existing project.service | Consistency with existing patterns |

## Common Pitfalls

### Pitfall 1: Incomplete Service Migration

**What goes wrong:** Some IPC operations have service hooks created but components still use `commands.` directly. Inconsistency creates confusion about which pattern to follow.

**Why it happens:** Phase 20 created hooks for primary operations but may not have covered all secondary operations (e.g., file browser operations in FilePicker.tsx).

**How to avoid:** Audit all 15 direct `commands.` usages. For each:
1. Check if a service hook already exists (e.g., `useDeleteSshConnectionMutation` exists for `commands.deleteSshConnection`)
2. If hook exists, use it
3. If hook doesn't exist, create it in the appropriate service file

**Warning signs:**
- Component still has `import { commands }` from bindings
- Component handles `Result<T, E>` types manually (indicates pre-wrapped Result handling)
- Component has try/catch around IPC calls

### Pitfall 2: Missing File Browser Service

**What goes wrong:** FilePicker.tsx has 4 direct `commands.` calls for file operations (listLocalDirectories, listRemoteDirectories, getDefaultFilePickerPath, listDrives). These aren't in any service yet.

**Why it happens:** File browser is a secondary feature added after Phase 20 completed.

**How to avoid:** Create new hooks in project.service.ts or a new file.service.ts for file operations. These are queries (not mutations) for browsing, so should use useQuery with appropriate staleTime.

**Warning signs:** FilePicker component directly imports commands and calls file operations

### Pitfall 3: Not Coordinating Optimistic Updates

**What goes wrong:** Migration refactors a component but doesn't preserve optimistic update logic that might exist in direct calls.

**Why it happens:** Service mutation hooks should handle optimistic updates (like useUpdateSshConnectionMutation does), but if directly invoking commands, component must handle it.

**How to avoid:** Verify service hooks match component behavior:
- useDeleteSshConnectionMutation should invalidate cache
- useUpdateSshConnectionMutation should support optimistic updates
- All mutation hooks should have error/success toast handling

**Warning signs:**
- Component manually calls queryClient.invalidateQueries()
- Component has queryClient.setQueryData() calls

## Code Examples

### Example 1: Refactoring ProjectList.tsx

**Current (direct commands):**
```typescript
// src/components/project-picker/ProjectList.tsx
import { commands } from "@/types";

const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
  const result = await commands.createProject(selectedPath, connectionId ?? null);
  if (result.status === "ok") {
    setSelectedProject(result.data);
  }
};

const handleProjectClick = async (projectId: number) => {
  const result = await commands.getProject(projectId);
  if (result.status === "ok") {
    setSelectedProject(result.data);
  }
};
```

**Refactored (service hooks):**
```typescript
// src/components/project-picker/ProjectList.tsx
import { useCreateProjectMutation, useProjectById, useRemoveProject } from "@/services";

const createProjectMutation = useCreateProjectMutation();
const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
  const project = await createProjectMutation.mutateAsync({
    path: selectedPath,
    connectionId: connectionId ?? 0
  });
  setSelectedProject(project);
};

const getProjectMutation = useProjectById(projectId); // Query for single project
const handleProjectClick = async (projectId: number) => {
  getProjectMutation.refetch(); // Or use the query result directly
};
```

### Example 2: Refactoring FilePicker.tsx File Operations

**Current (direct commands in useMutation):**
```typescript
const listLocalMutation = useMutation({
  mutationFn: (path: string) => commands.listLocalDirectories(path),
});
```

**Refactored (service layer):**
```typescript
// Add to project.service.ts
const fileQueryKeys = {
  ...projectQueryKeys,
  files: () => [...projectQueryKeys.baseKey, "files"] as const,
  localBrowse: (path: string) => [...fileQueryKeys.files(), "local", path] as const,
};

export function useListLocalDirectories(path: string) {
  return useQuery({
    queryKey: fileQueryKeys.localBrowse(path),
    queryFn: () => api.listLocalDirectories(path),
  });
}

// In FilePicker.tsx
const { data: directories = [] } = useListLocalDirectories(currentPath);
```

### Example 3: Refactoring useSshConnectionManager.ts

**Current (direct commands):**
```typescript
await commands.connectSshWithoutCredentials(connId);
const result = await commands.saveSshConnection(connectionString, "Agent");
await commands.connectSshWithPassword(connectionId, password, savePassword);
```

**Refactored (service hooks):**
```typescript
// Already have in connection.service.ts:
const connectMutation = useConnectSsh();
const createConnectionMutation = useCreateSshConnection();
const connectWithCredsMutation = useConnectSshWithCreds();

// Then in useSshConnectionManager.ts
await connectMutation.mutateAsync({ connectionId: connId });
const connection = await createConnectionMutation.mutateAsync({
  connectionString,
  authMethod: "Agent"
});
await connectWithCredsMutation.mutateAsync({ connectionId, password, savePassword });
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct `commands.` calls in components | Service hooks in services/ | Phase 19-20 | Centralized IPC, better testability, cache management |
| Manual Result<T, E> unwrapping | `api` proxy wrapper | Phase 20 | Cleaner async/await syntax in hooks |
| Per-component error handling | Centralized toast in mutation hooks | Phase 20 | Consistent UX, reduced boilerplate |
| useEffect + useState for fetching | TanStack Query hooks | Phase 20 | Automatic caching, deduplication, stale-time management |

## Verification Protocol for Phase 21

### Task 1: Audit Remaining Direct Commands Usage

1. Search codebase: `grep -r "commands\." src/ --include="*.tsx" --include="*.ts"`
2. Document findings by file and operation type
3. Identify which service each operation belongs to (connection, project, file, settings, execution)
4. Verify if service hook already exists or needs to be created

### Task 2: Create Missing Service Hooks

For each direct `commands.` call without an existing service hook:

1. Determine if it's a query (useQuery) or mutation (useMutation)
2. Add to appropriate service file or create new file.service.ts
3. Follow standard pattern: query key factory, enabled conditions, error handling
4. Test with `pnpm build` to verify TypeScript compilation

### Task 3: Migrate Components to Service Hooks

For each file (ProjectList, FilePicker, ConnectionHeader, SettingsPage, useSshConnectionManager):

1. Replace direct `commands.` imports with service hook imports
2. Replace direct calls with hook calls
3. Verify error handling (hooks should have toast.error built in)
4. Verify loading/error state management (TanStack Query provides these)
5. Test component functionality

### Task 4: Verification & Sign-Off

1. Verify no direct `commands.` calls remain in src/ (except internal service files using `api`)
2. Run `pnpm build` - must succeed with 0 TypeScript errors
3. Run `pnpm tauri build` - production bundle must include no mock code
4. All components should only have `import { ... } from "@/services"`
5. No components should have `import { commands }` from bindings

## Open Questions

1. **File Browser Operations:** Should file operations (listLocalDirectories, listRemoteDirectories, listDrives, getDefaultFilePickerPath) go into project.service.ts or a new file.service.ts?
   - **Recommendation:** Add to project.service.ts as they're project picker utilities, not core project operations. Query key structure: `projectQueryKeys.files()` with sub-keys for local/remote/drives.

2. **SSH Connection Manager Hook:** useSshConnectionManager.ts is itself a hook, not a component. Should it directly use service mutations or continue using commands?
   - **Recommendation:** Refactor to use service mutations. It's still part of the component layer (utils/hooks/) and should follow the same patterns as components for consistency.

3. **Result Type Handling:** Some direct `commands.` calls check `result.status === "ok"`. When switching to mutations, error handling is automatic. Verify components don't need special success/error logic.
   - **Recommendation:** Service mutations throw on error (via api proxy) and mutations.mutateAsync() rejects, so components can use standard .then()/.catch() or async/await patterns.

## Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Service layer patterns | HIGH | Phase 19-20 complete, 37 verified hooks, consistent across 5 services |
| API proxy wrapper | HIGH | Already implemented and working in tauri-utils.ts |
| TanStack Query patterns | HIGH | 37 hooks already following this pattern successfully |
| Remaining operations | MEDIUM | Some file browser operations may need new service creation; verify all operations map to existing commands |
| Component migration | HIGH | Straightforward import/call replacements; no complex state logic changes needed |

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** - Direct review of src/services/ and src/components/ files
  - src/services/project.service.ts (10+ hooks verified)
  - src/services/connection.service.ts (7 hooks verified, includes optimistic updates pattern)
  - src/utils/helpers/tauri-utils.ts (api proxy implementation verified)
- **Phase 20 Completion Report** - .planning/phases/20-refactor-frontend-to-use-tanstack-query/20-COMPLETION-REPORT.md
  - Documented 37 TanStack Query hooks created
  - Verified 0 direct invoke() calls in UI components post-Phase 20
  - Identified 2 hook regressions and auto-fixed them

### Secondary (verified in codebase)
- Phase 19 completion reports: Architecture patterns for services/ organization
- Phase 20 completion reports: TanStack Query hook patterns and verification methodology
- Grep audit: All 15 remaining `commands.` usages catalogued and identified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - TanStack Query + service layer already established and working
- Architecture: HIGH - Patterns clear from Phase 19-20, only remaining work is mechanical refactoring
- Pitfalls: HIGH - Identified specific gaps (file operations service, result unwrapping consistency)
- Implementation: MEDIUM-HIGH - Most work is straightforward, but file operations service design needs consideration

**Research date:** 2026-02-28
**Valid until:** 2026-03-14 (stable patterns, no external dependency changes expected)

**Next steps for planner:**
1. Verify all 15 direct `commands.` usages match audit in this research
2. Determine if new file.service.ts needed or file operations go to project.service.ts
3. Plan task breakdown: audit (1 task) + service creation (1 task) + component migrations (1-2 tasks) + verification (1 task)
4. Consider Wave pattern: Wave 1 (audit + service creation), Wave 2 (component migrations), Wave 3 (verification)
