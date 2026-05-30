# Fix: Sessions from previous project leaking into Agents view

## Context

When switching projects, the Agents view shows sessions belonging to the previous project. Root cause: `get_active_sessions` returns ALL sessions globally without project filtering, and the frontend has no way to filter because `ActiveSessionInfo` doesn't include `project_id`.

## Approach: Add `project_id` to response + filter server-side

Cleanest fix: add `project_id` parameter to the command and filter in Rust. This keeps the frontend simple and avoids shipping unnecessary data.

## Changes

### 1. Add `project_id` to `ActiveSessionInfo` struct

**File:** `src-tauri/src/models/worktree.rs` (line 66-79)

Add field:
```rust
pub project_id: Option<i32>,
```

### 2. Add `project_id` param to `get_active_sessions` + filter

**File:** `src-tauri/src/ipc/acp_handlers.rs` (line 1275)

- Add `project_id: Option<i32>` parameter
- Filter ACP sessions: skip entries where `proc.project_id != project_id` (when param is Some)
- Filter PTY sessions: need to add `project_id` to `PtySessionMeta` first, then filter same way
- Populate new `project_id` field in `ActiveSessionInfo`

### 3. Add `project_id` to `PtySessionMeta`

**File:** `src-tauri/src/models/worktree.rs` (line 92-99)

Add field:
```rust
pub project_id: Option<i32>,
```

Then find where `PtySessionMeta` is constructed (likely in execution handlers) and pass project_id through.

### 4. Regenerate TypeScript bindings

Run `pnpm tauri:gen` to update `src/types/bindings.ts`.

### 5. Update frontend query to pass `projectId`

**File:** `src/services/execution.service.ts`

- Change query key: `activeSessions: (projectId?: number) => ["activeSessions", projectId] as const`
- Update `useActiveSessionsQuery` to accept `projectId` param and pass to `api.getActiveSessions(projectId)`

### 6. Pass `projectId` from AgentsView to query

**File:** `src/views/AgentsView.tsx` (line 36)

```typescript
const { data: sessions = [] } = useActiveSessionsQuery(projectId);
```

### 7. Update App.tsx agent count badge

**File:** `src/App.tsx` (lines 83-84)

Pass current project ID to `useActiveSessionsQuery` so badge only counts current project's sessions.

## Verification

1. Open project A, spawn agent session
2. Switch to project B — Agents view should be empty (no sessions from A)
3. Switch back to A — session still visible
4. Badge count in header should reflect current project only
5. Run `pnpm build` (type check) + `cargo check`
