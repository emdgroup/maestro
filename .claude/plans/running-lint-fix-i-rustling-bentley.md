# Fix 2 oxlint exhaustive-deps warnings

## Context

`pnpm lint:fix` produces 2 warnings — both `react-hooks/exhaustive-deps` from oxlint. No errors, just warnings. Both involve unstable references in useEffect deps.

## Fixes

### 1. `src/utils/hooks/useSshConnectionManager.ts:54-65`

**Problem**: `buildConnection` is a plain function declared in component body → new ref each render → useEffect fires every render.

**Fix**: Inline the mapping directly in the useEffect body. `buildConnection` is only used in that one place, no reason for it to be a named function outside.

```tsx
useEffect(() => {
  setConnections([
    local.current,
    ...sshConnections.map((sshConn) => ({
      type: "ssh" as const,
      id: sshConn.id,
      displayName: sshConn.display_name || sshConn.connection_string,
      subtitle: sshConn.display_name ? sshConn.connection_string : undefined,
      metadata: `Last used: ${new Date(sshConn.last_used_at).toLocaleDateString()}`,
      sshConnection: sshConn,
    })),
  ]);
}, [sshConnections]);
```

Remove the standalone `buildConnection` function.

### 2. `src/App.tsx:105-113`

**Problem**: `cleanupZombiesMutation` (from react-query `useMutation`) is an unstable ref. Existing biome-ignore comment doesn't suppress oxlint.

**Fix**: Replace biome-ignore with eslint-disable-next-line (which oxlint respects):

```tsx
useEffect(() => {
  if (currentProject) {
    cleanupZombiesMutation.mutate({
      projectId: currentProject.id,
      repoPath: currentProject.path,
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [currentProject?.id]);
```

This is intentional — mutation runs once per project switch. Mutation object shouldn't be a dep.

## Verification

```bash
pnpm lint:fix  # Should show 0 warnings, 0 errors
```
