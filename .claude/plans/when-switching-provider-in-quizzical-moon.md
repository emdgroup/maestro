# Fix: Issue list not refreshing after provider switch

## Context

When user switches issue tracking provider in project settings (e.g., from Jira to GitHub), the Create Task Modal continues showing stale issues from the old provider. The remote issues query is cached with 60s staleTime and never invalidated on provider change.

## Root Cause

In `src/services/integration.service.ts:97-100`, `useSaveProjectIssueTrackingConfig`'s `onSuccess` only invalidates the config query key (`["integrations", "issue_tracking", projectId]`), but not the remote issues query key (`["issue_tracking", "remote-issues", projectId]`).

## Fix

**File:** `src/services/integration.service.ts`

1. Import `issueTrackingQueryKeys` from `@/services/task.service`
2. Add second invalidation in `onSuccess`:

```typescript
onSuccess: (_data, { projectId }) => {
  void queryClient.invalidateQueries({
    queryKey: integrationQueryKeys.projectIssueTracking(projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: issueTrackingQueryKeys.remoteIssues(projectId),
  });
},
```

## Files to modify

- `src/services/integration.service.ts` — add import + invalidation call

## Verification

1. `pnpm build` — type check passes
2. `pnpm test` — no regressions
3. Manual: open settings → configure provider A → open create modal (see A's issues) → switch to provider B in settings → reopen create modal → should show B's issues
