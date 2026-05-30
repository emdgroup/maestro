# Plan: Replace PTY Task Execution with ACP Sessions

## Context

When a user clicks "Execute" on a task, the current flow spawns a PTY terminal session in the task's worktree. The `task_description` parameter is passed through but **never used** (underscore-prefixed in Rust). This needs to be replaced with ACP session flow: create worktree → spawn ACP session → set model → send initial prompt with title/description/attachments → mark InProgress.

The ACP infrastructure already exists and works (used for manual session spawning from Agents tab). This change wires it into the task execution path.

## Files to Modify

| File | Change |
|------|--------|
| `src/contexts/KanbanContext.tsx` | Add `connectionId`, `wslConnectionId` to context |
| `src/App.tsx` | Pass connection IDs to `<KanbanProvider>` |
| `src/utils/hooks/useExecuteTask.ts` | **Rewrite** — replace PTY flow with ACP orchestration |
| `src-tauri/src/ipc/acp_handlers.rs` | Add `task_id` + `task_name` params to `spawn_acp_session` |
| `src/services/execution.service.ts` | Update `useSpawnAcpSessionMutation` params |
| `src/components/kanban/TaskCard.tsx` | Add "Join Session" button for InProgress tasks with active ACP sessions |

## Implementation Steps

### 1. Add connection IDs to KanbanContext

**`src/contexts/KanbanContext.tsx`**:
- Add `connectionId: number | null` and `wslConnectionId: number | null` to `KanbanContextValue` interface and provider props
- Pass through in provider value

**`src/App.tsx`** (line 219-225):
- Add `connectionId={currentProject.connection_id}` and `wslConnectionId={currentProject.wsl_connection_id}` to `<KanbanProvider>`

### 2. Add task_id/task_name to spawn_acp_session (Rust)

**`src-tauri/src/ipc/acp_handlers.rs`** (line 159):
- Add params: `task_id: Option<i32>`, `task_name: Option<String>`
- Replace all `TaskMetadata { task_id: None, task_name: None, ...}` (lines 243, 269, 300, 314) with `TaskMetadata { task_id, task_name: task_name.clone(), ...}`

### 3. Update frontend service for new params

**`src/services/execution.service.ts`** (line 261-296):
- Add `taskId?: number | null` and `taskName?: string | null` to `useSpawnAcpSessionMutation` input type
- Pass through to `api.spawnAcpSession(...)` call — this requires checking if the bindings already accept these (they will after Rust change + `pnpm tauri:gen`)

### 4. Rewrite useExecuteTask hook

**`src/utils/hooks/useExecuteTask.ts`** — full rewrite:

```typescript
export function useExecuteTask(
  projectId: number | null,
  projectPath: string,
  connectionId: number | null,
  wslConnectionId: number | null,
) {
  // ...
  execute = async (task: Task) => {
    // 1. Resolve agent (task.agent_id ?? defaultAgent ?? error)
    // 2. Resolve cwd:
    //    - if task.isolated_worktree: find/create worktree, get absolute path
    //    - else: use projectPath
    // 3. Spawn ACP session (agentId, cwd, task.title, projectId, connectionId, wslConnectionId, branchName, task.id, task.title)
    // 4. Wait for spawn-ok event (listen `acp://spawn-ok/${logId}`, 30s timeout)
    // 5. Set model if task.model_override (api.setAcpModel)
    // 6. Build and send initial prompt:
    //    - Fetch attachments (api.getTaskAttachments)
    //    - If attachments: prepare via api.prepareExternalAttachments(logId, files, true)
    //    - Build content blocks: text block (title + description) + attachment blocks
    //    - api.sendAcpPromptStructured(logId, contentBlocks)
    // 7. Update task status to InProgress (api.updateTask)
  }
}
```

Key details:
- Use `listen()` from `@tauri-apps/api/event` for one-shot SpawnOk listener
- Rollback: if any step after spawn fails, call `api.cancelAcpSession(logId)`
- Get `defaultAgent` from `useDefaultAgent()` (configStore)
- Get connection IDs from updated KanbanContext

### 5. Update TaskCard for "Join Session" button

**`src/components/kanban/TaskCard.tsx`**:
- For `task.status === "InProgress"`: show "Join" button that navigates to Agents tab with the session
- Use `useActiveSessionsQuery()` to find session matching `task_id`
- On click: `setActiveTab("agents")` + set pending session key in navigation store

### 6. Task status transition timing

Current flow sets `status = InProgress` inside the Rust `spawn_interactive_execution` handler. New flow:
- Status update happens in frontend AFTER prompt is sent successfully
- Use existing `api.updateTask(task.id, { status: "InProgress" })` 
- If prompt send fails → don't transition, cancel session, show error

## Worktree Resolution Logic

Same as current hook but use `task.base_branch`:
1. Check existing worktrees for `task_id` match
2. If found: reuse `worktreeId`, `branchName`, resolve absolute path from relative path
3. If not found AND `task.isolated_worktree`: create via `createWorktreeMutation`
4. If `!task.isolated_worktree`: skip worktree, use `projectPath` directly

Need worktree absolute path for ACP `cwd`. Current worktree data returns relative path (`.maestro/worktrees/task-X`). Absolute = `${projectPath}/${relativePath}`.

## Initial Prompt Format

```json
[
  { "type": "text", "text": "# {task.title}\n\n{task.description}" },
  // ...prepared attachment content blocks (from prepare_external_attachments)
]
```

## Error Handling

| Failure Point | Action |
|---|---|
| No agent configured | Toast error, abort |
| Worktree creation fails | Toast error, abort |
| ACP session spawn fails | Toast error, abort |
| SpawnOk timeout (30s) | Cancel session, toast error, abort |
| Model set fails | Log warning, continue (non-critical) |
| Prompt send fails | Cancel session, toast error, abort |

Task stays in `Ready` until prompt sends successfully.

## Verification

1. `pnpm tauri:gen` — regenerate bindings after Rust changes
2. `pnpm build` — check TypeScript compiles
3. `pnpm test` — run unit tests
4. Manual test: create task with agent assigned → click Execute → verify ACP session spawns, model set, prompt sent, task moves to InProgress
5. Test edge cases: no agent assigned (should use default), isolated_worktree=false, task with attachments
