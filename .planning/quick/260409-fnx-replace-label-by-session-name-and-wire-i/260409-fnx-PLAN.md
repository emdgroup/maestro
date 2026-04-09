---
phase: quick-260409-fnx
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src-tauri/src/db/schema.rs
  - src-tauri/src/models/execution_log.rs
  - src-tauri/src/models/worktree.rs
  - src-tauri/src/ipc/execution_handlers.rs
  - src/types/bindings.ts
  - src/services/execution.service.ts
  - src/views/AgentsView.tsx
  - src/components/kanban/TaskCard.tsx
  - src/components/execution/AgentMonitor.tsx
autonomous: true
requirements: [QUICK-260409-FNX]
must_haves:
  truths:
    - "Interactive sessions spawned with a session_name persist it in the DB"
    - "Session name is visible in the Agents sidebar when present"
    - "Session name is used as primary display name in AgentMonitor (falling back to branch_name)"
    - "TaskCard passes task.name as sessionName when spawning"
    - "Existing databases without session_name column upgrade transparently via ALTER TABLE"
  artifacts:
    - path: "src-tauri/src/db/schema.rs"
      provides: "session_name TEXT column in execution_logs (CREATE TABLE + ALTER TABLE migration)"
    - path: "src-tauri/src/models/worktree.rs"
      provides: "session_name field on ExecutionWithTask"
    - path: "src-tauri/src/ipc/execution_handlers.rs"
      provides: "session_name param wired into INSERT + SELECT"
    - path: "src/types/bindings.ts"
      provides: "Updated TS types with sessionName"
  key_links:
    - from: "src/views/AgentsView.tsx"
      to: "execution.service.ts"
      via: "useSpawnInteractiveExecutionMutation with sessionName param"
    - from: "src/components/execution/AgentMonitor.tsx"
      to: "ExecutionWithTask.session_name"
      via: "display logic: session_name ?? task_name ?? branch_name"
---

<objective>
Wire the session_name parameter end-to-end: rename the discarded `label` param to `session_name`, persist it in the execution_logs table, return it in ExecutionWithTask, and display it as the primary name in the Agents view sidebar.

Purpose: Currently the label param is accepted but immediately discarded (`let _ = label`). Users set a session name in the spawn dialog but it has no effect.
Output: session_name stored in DB and shown as primary display name for interactive sessions.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md

<interfaces>
<!-- Key types and contracts the executor needs -->

From src-tauri/src/models/worktree.rs (ExecutionWithTask — currently no session_name):
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExecutionWithTask {
    pub id: i32,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub terminal_output: Option<String>,
}
```

From src-tauri/src/models/execution_log.rs (ExecutionLog — not used in display, but for reference):
```rust
pub struct ExecutionLog {
    pub id: i32,
    pub task_id: i32,
    pub output: String,
    pub terminal_output: Option<String>,
    pub status: ExecutionStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub error_event: Option<ErrorEvent>,
}
```

From src/types/bindings.ts:
```typescript
export type ExecutionWithTask = { id: number; task_id: number | null; task_name: string | null; branch_name: string | null; status: string; started_at: string; completed_at: string | null; terminal_output: string | null }
```

From src/services/execution.service.ts (spawn mutation params):
```typescript
mutationFn: async ({ projectId, branchName, repoPath, label, worktreeId }: {
    projectId: number;
    branchName: string;
    repoPath: string;
    label: string | null;
    worktreeId?: number | null;
}) => {
    return await api.spawnInteractiveExecution(projectId, branchName, repoPath, label, worktreeId ?? null);
}
```

From src/components/execution/AgentMonitor.tsx (display logic, line 114):
```tsx
{execution.task_name ?? execution.branch_name ?? "Interactive session"}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Backend — add session_name column, model field, and IPC wiring</name>
  <files>
    src-tauri/src/db/schema.rs
    src-tauri/src/models/worktree.rs
    src-tauri/src/ipc/execution_handlers.rs
  </files>
  <action>
**schema.rs — non-destructive migration + fresh install:**

1. In `SCHEMA_V7` string, add `session_name TEXT` column to the `execution_logs` CREATE TABLE, after the `branch_name TEXT` line:
   ```sql
   session_name TEXT,
   ```
2. In `initialize_schema()`, AFTER the existing `if current_version < SCHEMA_VERSION` block (after the closing `}` on line 189), add a non-destructive ALTER TABLE migration that runs unconditionally (safe to run repeatedly since SQLite ALTER TABLE ADD COLUMN errors if column exists):
   ```rust
   // Non-destructive migration: add session_name column for existing V7 databases.
   // ALTER TABLE ADD COLUMN is a no-op error when the column already exists (fresh installs).
   let _ = conn.execute("ALTER TABLE execution_logs ADD COLUMN session_name TEXT", []);
   ```
   This runs after schema init so it covers both fresh installs (column already in CREATE TABLE) and existing V7 databases (column added via ALTER).

**worktree.rs — add field to ExecutionWithTask:**

3. Add `pub session_name: Option<String>` field to `ExecutionWithTask` struct, after `task_name`:
   ```rust
   pub session_name: Option<String>,    // Optional display name for the session
   ```

**execution_handlers.rs — wire session_name in spawn + list:**

4. In `spawn_interactive_execution` (line ~800):
   - Rename doc comment `label` references to `session_name`
   - Rename parameter `label: Option<String>` to `session_name: Option<String>`
   - Delete `let _ = label;` (line 814)
   - Update the INSERT SQL (line ~889) from:
     ```sql
     INSERT INTO execution_logs (task_id, branch_name, status, started_at) VALUES (NULL, ?, 'running', ?)
     ```
     to:
     ```sql
     INSERT INTO execution_logs (task_id, branch_name, session_name, status, started_at) VALUES (NULL, ?, ?, 'running', ?)
     ```
   - Update rusqlite::params! to include `&session_name` after `&branch_name`:
     ```rust
     rusqlite::params![&branch_name, &session_name, &now],
     ```

5. In `list_executions_with_task_info` (line ~977):
   - Add `el.session_name` to the SELECT clause (after `task_name`):
     ```sql
     SELECT el.id, el.task_id, t.name AS task_name, el.session_name,
            COALESCE(el.branch_name, w.branch_name) AS branch_name,
            el.status, el.started_at, el.completed_at, el.terminal_output
     ```
   - Update the row mapping to read `session_name` at the new column index (index 3, shifting branch_name to 4, etc.):
     ```rust
     Ok(ExecutionWithTask {
         id: row.get(0)?,
         task_id: row.get(1)?,
         task_name: row.get(2)?,
         session_name: row.get(3)?,
         branch_name: row.get(4)?,
         status: row.get(5)?,
         started_at: row.get(6)?,
         completed_at: row.get(7)?,
         terminal_output: row.get(8)?,
     })
     ```
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && cd src-tauri && cargo check 2>&1 | tail -5</automated>
  </verify>
  <done>
    - session_name column in CREATE TABLE and ALTER TABLE migration
    - ExecutionWithTask has session_name field
    - spawn_interactive_execution persists session_name to DB
    - list_executions_with_task_info returns session_name
    - cargo check passes
  </done>
</task>

<task type="auto">
  <name>Task 2: Regenerate bindings and update frontend (service, views, display)</name>
  <files>
    src/types/bindings.ts
    src/services/execution.service.ts
    src/views/AgentsView.tsx
    src/components/kanban/TaskCard.tsx
    src/components/execution/AgentMonitor.tsx
  </files>
  <action>
**Regenerate TypeScript bindings:**

1. Run `pnpm tauri:gen` to regenerate `src/types/bindings.ts`. This will:
   - Rename `label` param to `sessionName` in `spawnInteractiveExecution`
   - Add `session_name` field to `ExecutionWithTask` type

**execution.service.ts — rename param:**

2. In `useSpawnInteractiveExecutionMutation` (line ~70):
   - Rename `label: string | null` to `sessionName: string | null` in the destructured params
   - Update the api call: `api.spawnInteractiveExecution(projectId, branchName, repoPath, sessionName, worktreeId ?? null)`

**AgentsView.tsx — rename state and UI labels:**

3. Rename state variable: `spawnLabel` to `sessionName`, `setSpawnLabel` to `setSessionName`
4. Update the Label element (line ~178): `<Label htmlFor="spawn-session-name">Session name (optional)</Label>`
5. Update the Input element: `id="spawn-session-name"`, `value={sessionName}`, `onChange={(e) => setSessionName(e.target.value)}`
6. Update the mutation call (line ~199): `sessionName: sessionName.trim() || null`
7. Update the reconnect handler (line ~127): change `label: null` to `sessionName: null`
8. Reset in onSuccess/close: change `setSpawnLabel("")` to `setSessionName("")` (or wherever the state is reset)

**TaskCard.tsx — rename param:**

9. In the `spawnInteractiveExecution` call (line ~99), the 4th positional arg `task.name` maps to the renamed `sessionName` param. Since bindings regenerated, this call uses positional args through `api.spawnInteractiveExecution(...)` — verify the call still passes `task.name` as the 4th arg (now `sessionName`). The auto-generated binding param name change is transparent for positional calls, but if the service mutation is used instead, update the key name from `label` to `sessionName`.

**AgentMonitor.tsx — display session_name as primary name:**

10. Update the sidebar display logic to prioritize session_name. Change every occurrence of:
    ```tsx
    execution.task_name ?? execution.branch_name ?? "Interactive session"
    ```
    to:
    ```tsx
    execution.session_name ?? execution.task_name ?? execution.branch_name ?? "Interactive session"
    ```
    There are 3 occurrences:
    - Line ~62 (search filter): update the filter to also match session_name
    - Line ~114 (sidebar item label): `execution.session_name ?? execution.task_name ?? execution.branch_name ?? "Interactive session"`
    - Line ~145 (detail panel header): `execution.session_name ?? execution.task_name ?? execution.branch_name ?? "Interactive session"`

11. The "Interactive" badge (line ~116) should show when there's no task_name. Keep the condition as `!execution.task_name` — the badge indicates the session type, not the name source.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -10</automated>
  </verify>
  <done>
    - bindings.ts regenerated with sessionName param and session_name on ExecutionWithTask
    - execution.service.ts uses sessionName (not label)
    - AgentsView uses "Session name" label and sessionName state
    - TaskCard passes task.name as sessionName
    - AgentMonitor displays session_name as primary name for interactive sessions
    - pnpm build succeeds with 0 TypeScript errors
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Frontend to IPC | session_name is user input passed to SQL |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-fnx-01 | T (Tampering) | execution_handlers.rs INSERT | accept | session_name is passed via rusqlite parameterized query (params![]), not string interpolation — SQL injection not possible |
</threat_model>

<verification>
1. `cargo check` passes in src-tauri
2. `pnpm build` passes with 0 TypeScript errors
3. Manual: spawn an interactive session with a session name set — verify the name appears in the Agents sidebar
4. Manual: spawn an interactive session WITHOUT a session name — verify it falls back to branch name display
</verification>

<success_criteria>
- session_name persisted in execution_logs when provided via spawn dialog
- session_name displayed as primary label in AgentMonitor sidebar (before task_name and branch_name in the fallback chain)
- Existing V7 databases upgraded transparently via ALTER TABLE (no data loss)
- All renamed: label -> session_name (Rust), label -> sessionName (TypeScript)
</success_criteria>

<output>
After completion, create `.planning/quick/260409-fnx-replace-label-by-session-name-and-wire-i/260409-fnx-01-SUMMARY.md`
</output>
