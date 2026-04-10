---
phase: quick-260410-awn
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src-tauri/src/ipc/execution_handlers.rs
  - src/components/kanban/TaskCard.tsx
  - src/types/bindings.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "When a task is executed from the kanban board, the claude agent starts with a named session matching the task name"
    - "After the agent starts, the task description is automatically injected as the first input"
    - "The task status changes to InProgress when execution begins"
  artifacts:
    - path: "src-tauri/src/ipc/execution_handlers.rs"
      provides: "Enhanced spawn_interactive_execution with task_id, named session, description injection, and status update"
    - path: "src/components/kanban/TaskCard.tsx"
      provides: "Updated handleExecute passing task_id and description to spawn IPC"
  key_links:
    - from: "src/components/kanban/TaskCard.tsx"
      to: "spawn_interactive_execution"
      via: "api.spawnInteractiveExecution with task_id and description"
      pattern: "spawnInteractiveExecution.*taskId"
---

<objective>
Enhance the task execution flow with three improvements: (1) start the claude agent using a named session (`claude -n <task_name>`), (2) inject the task description into the agent after it starts (with a delay to ensure readiness), (3) automatically move the task status to InProgress when execution begins.

Purpose: Currently executing a task from the kanban board spawns a bare `claude` process with no session name, no context about the task, and doesn't update the task status. These changes make execution smarter — the agent gets its task context automatically and the board reflects the running state.

Output: Modified `spawn_interactive_execution` IPC handler and `TaskCard.tsx` execution flow.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src-tauri/src/ipc/execution_handlers.rs
@src-tauri/src/process/pty.rs
@src/components/kanban/TaskCard.tsx
@src/services/execution.service.ts
@src/types/bindings.ts

<interfaces>
<!-- Key types and contracts the executor needs -->

From src-tauri/src/ipc/execution_handlers.rs (current spawn_interactive_execution signature):
```rust
pub async fn spawn_interactive_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch_name: String,
    repo_path: String,
    session_name: Option<String>,
    worktree_id: Option<i32>,
) -> Result<i32, String>
```

From src-tauri/src/process/pty.rs (spawn function):
```rust
pub async fn spawn_agent_cli_pty(
    task_id: i32,
    command: String,
    args: Vec<String>,
    working_dir: std::path::PathBuf,
) -> Result<PtySession, String>
```

From src-tauri/src/models/task.rs (Task struct fields needed):
```rust
pub struct Task {
    pub id: i32,
    pub name: String,
    pub description: String,
    // ...
}
```

From src/components/kanban/TaskCard.tsx (current execution call):
```typescript
await api.spawnInteractiveExecution(projectId, branchName, projectPath, task.name, worktreeId);
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add task_id param, named session args, description injection, and status update to spawn_interactive_execution</name>
  <files>src-tauri/src/ipc/execution_handlers.rs</files>
  <action>
Modify `spawn_interactive_execution` in `src-tauri/src/ipc/execution_handlers.rs`:

**1. Add `task_id: Option<i32>` parameter** after `worktree_id`:
```rust
pub async fn spawn_interactive_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch_name: String,
    repo_path: String,
    session_name: Option<String>,
    worktree_id: Option<i32>,
    task_id: Option<i32>,
    task_description: Option<String>,
) -> Result<i32, String> {
```

**2. Store task_id in execution_logs INSERT** — change the INSERT from `VALUES (NULL, ?, ?, ...)` to use the actual task_id:
```rust
"INSERT INTO execution_logs (task_id, branch_name, session_name, status, started_at) VALUES (?, ?, ?, 'running', ?)",
rusqlite::params![&task_id, &branch_name, &session_name, &now],
```

**3. Update task status to InProgress** — right after inserting the execution log, if task_id is Some, update the task:
```rust
if let Some(tid) = task_id {
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ? AND status = 'Ready'",
        rusqlite::params![&now, tid],
    ).map_err(|e| format!("Failed to update task status: {}", e))?;
}
```
The `AND status = 'Ready'` guard prevents overwriting status if the task is already InProgress (e.g., on re-execute/resume).

**4. Build claude CLI args with `-n` for named session** — construct args before the local/remote PTY spawn branches. Use the session_name (which is the task name) if available:
```rust
let claude_args: Vec<String> = match &session_name {
    Some(name) => vec!["-n".to_string(), name.clone()],
    None => vec![],
};
```

**5. For remote SSH path** — change the init command from:
```
cd '{path}' && clear && claude\n
```
to include the `-n` flag:
```rust
let claude_cmd = match &session_name {
    Some(name) => {
        let escaped_name = name.replace('\'', "'\\''");
        format!("claude -n '{}'", escaped_name)
    }
    None => "claude".to_string(),
};
let init_cmd = format!("cd '{}' && clear && {}\n", escaped_path, claude_cmd);
```

**6. For local PTY path** — pass `claude_args` to `spawn_agent_cli_pty`:
```rust
let pty_session = crate::process::spawn_agent_cli_pty(
    log_id,
    "claude".to_string(),
    claude_args,
    std::path::PathBuf::from(&worktree_abs_path),
).await?;
```

**7. Inject task description after agent starts** — after the PTY is spawned and stored in the session map (both local and remote branches), if `task_description` is Some and non-empty, spawn a tokio task that sleeps 2 seconds then writes the description to the PTY:

For the remote branch (after inserting into `ssh_pty_sessions`):
```rust
if let Some(ref desc) = task_description {
    if !desc.trim().is_empty() {
        let desc_text = desc.clone();
        let write_tx = pty_handle.write_tx.clone();
        // Clone before moving pty_handle into session map
        // Actually, clone write_tx before inserting handle
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let input = format!("{}\n", desc_text);
            let _ = write_tx.send(crate::ssh::SshWriteOp::Data(input.into_bytes())).await;
        });
    }
}
```
Important: clone `pty_handle.write_tx` BEFORE moving `pty_handle` into the session map.

For the local branch (after inserting into `pty_sessions`):
```rust
if let Some(ref desc) = task_description {
    if !desc.trim().is_empty() {
        let desc_text = desc.clone();
        let session_clone = Arc::clone(sessions.get(&log_id).unwrap());
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let session_lock = session_clone.lock().await;
            let input = format!("{}\n", desc_text);
            let _ = session_lock.write_input(input.as_bytes()).await;
        });
    }
}
```
Get the Arc-cloned session reference from the sessions map after insert, before dropping the lock.

Keep the existing flow for interactive sessions (from Agents view New Session dialog) unchanged — they pass `task_id: None` and `task_description: None`.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro/src-tauri && cargo check 2>&1 | tail -5</automated>
  </verify>
  <done>
    - spawn_interactive_execution accepts task_id and task_description params
    - execution_logs INSERT uses actual task_id (not always NULL)
    - task status updated to InProgress when task_id provided and status is Ready
    - claude launched with `-n <session_name>` for both local and remote
    - task description injected into PTY 2s after spawn
    - cargo check passes
  </done>
</task>

<task type="auto">
  <name>Task 2: Update frontend TaskCard and bindings to pass task_id and description</name>
  <files>src/components/kanban/TaskCard.tsx, src/types/bindings.ts, src/services/execution.service.ts</files>
  <action>
**1. Regenerate TypeScript bindings** — run `pnpm tauri:gen` to pick up the new `task_id` and `task_description` params on `spawn_interactive_execution`. The binding should now be:
```typescript
async spawnInteractiveExecution(
  projectId: number, branchName: string, repoPath: string,
  sessionName: string | null, worktreeId: number | null,
  taskId: number | null, taskDescription: string | null
): Promise<Result<number, string>>
```

If `pnpm tauri:gen` does not update the binding automatically (it sometimes requires a test run), manually update the binding in `src/types/bindings.ts`:
- Find the `spawnInteractiveExecution` method
- Add `taskId: number | null, taskDescription: string | null` to its parameters
- Update the TAURI_INVOKE call to include `{ ..., taskId, taskDescription }`

**2. Update TaskCard.tsx handleExecute** — pass `task.id` and `task.description` to the spawn call. Change line ~120 from:
```typescript
await api.spawnInteractiveExecution(projectId, branchName, projectPath, task.name, worktreeId);
```
to:
```typescript
await api.spawnInteractiveExecution(projectId, branchName, projectPath, task.name, worktreeId, task.id, task.description);
```

Also add optimistic UI update after the spawn succeeds — update the local task status via boardStore. After the `api.spawnInteractiveExecution` call succeeds (before the toast), add:
```typescript
store.updateTaskStatus(task.id, "InProgress");
```
This provides immediate visual feedback on the kanban board. The backend has already persisted the status change.

**3. Update useSpawnInteractiveExecutionMutation** in `src/services/execution.service.ts` — add `taskId` and `taskDescription` to the mutation args type and pass through to the api call:
```typescript
mutationFn: async ({
  projectId, branchName, repoPath, sessionName, worktreeId,
  taskId, taskDescription,
}: {
  projectId: number;
  branchName: string;
  repoPath: string;
  sessionName: string | null;
  worktreeId?: number | null;
  taskId?: number | null;
  taskDescription?: string | null;
}) => {
  return await api.spawnInteractiveExecution(
    projectId, branchName, repoPath, sessionName,
    worktreeId ?? null, taskId ?? null, taskDescription ?? null
  );
},
```
Also add `taskQueryKeys.all` to the invalidation in `onSuccess` so the task list refreshes to show the InProgress status:
```typescript
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: executionQueryKeys.all });
  queryClient.invalidateQueries({ queryKey: ["tasks"] });
},
```

**4. Verify AgentsView callers** — the `AgentsView.tsx` uses `useSpawnInteractiveExecutionMutation` for interactive (non-task) sessions. Ensure those call sites still work by NOT passing `taskId` or `taskDescription` (they default to null via `?? null`). No changes needed in AgentsView — the new params are optional.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -10</automated>
  </verify>
  <done>
    - TypeScript bindings updated with taskId and taskDescription params
    - TaskCard.handleExecute passes task.id and task.description to spawnInteractiveExecution
    - TaskCard optimistically updates task status to InProgress in boardStore after spawn
    - useSpawnInteractiveExecutionMutation accepts optional taskId/taskDescription
    - Agents view interactive sessions unaffected (params default to null)
    - Frontend builds with zero TypeScript errors
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| frontend -> Rust IPC | Task description passes from frontend through IPC to PTY stdin |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-01 | I (Injection) | PTY stdin injection via task_description | accept | Task description is user-authored content written to their own PTY session — same trust level as manual typing; shell-quote the session name in remote SSH command to prevent command injection |
| T-quick-02 | T (Tampering) | task status update without auth check | accept | All IPC commands run in same desktop process with same user trust level; AND status = 'Ready' guard prevents unexpected state transitions |
</threat_model>

<verification>
1. `cargo check` passes in src-tauri/ (Rust compiles)
2. `pnpm build` passes (TypeScript compiles, no errors)
3. Manual verification: click Execute on a Ready task card, confirm:
   - Agent session starts with named session (visible in claude UI / agents sidebar)
   - Task description appears as first input in the terminal
   - Task card moves to InProgress column on kanban board
</verification>

<success_criteria>
- spawn_interactive_execution IPC accepts task_id and task_description optional parameters
- claude CLI launched with `-n <session_name>` for both local and remote paths
- Task description written to PTY stdin 2 seconds after agent spawn
- Task status updated to InProgress in database when task_id is provided
- Frontend passes task.id and task.description from TaskCard execute button
- Kanban board shows task in InProgress after execution starts
- Interactive (non-task) sessions from Agents view are unaffected
</success_criteria>

<output>
After completion, create `.planning/quick/260410-awn-enhance-task-execution-named-session-inj/260410-awn-SUMMARY.md`
</output>
