# Plan: Type-Safe Connection Identity at IPC Boundary

## Context

Phases 1-4 (remove project model setting, re-key agent cache, dynamic models/modes in task detail, SpawnSessionDialog update) are **already implemented**. During review, we identified that the IPC boundary uses an ambiguous `(connection_id: Option<i32>, wsl_connection_id: Option<i32>)` pattern — callers can pass conflicting values, and the priority rule (WSL wins) is implicit. The backend already has a `ConnectionKey` enum internally; this phase exposes it as a typed discriminated union at the IPC boundary.

---

## Phase 5: Replace Two-Optional-IDs with `ConnectionKey` Discriminated Union

### Step 1: Transform `ConnectionKey` to serializable struct variants

**`src-tauri/src/acp/mod.rs`**

Change from tuple variants to struct variants (required for `#[serde(tag)]`):

```rust
#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
#[specta(export)]
pub enum ConnectionKey {
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "ssh")]
    Ssh { id: i32 },
    #[serde(rename = "wsl")]
    Wsl { id: i32 },
}
```

- All pattern matches change: `ConnectionKey::Ssh(id)` → `ConnectionKey::Ssh { id }`
- Remove `to_event_payload()` — direct `serde_json::to_value(&connection_key)` replaces it
- Keep `from_ids` for `Project` → `ConnectionKey` conversion only

### Step 2: Update Tauri command signatures

Replace `connection_id: Option<i32>, wsl_connection_id: Option<i32>` with `connection: crate::acp::ConnectionKey` in:

**`src-tauri/src/ipc/acp_handlers.rs`** (8 commands):
- `spawn_acp_session`
- `get_agent_cache`
- `preflight_connection`
- `detect_project_agents`
- `discover_agents`
- `list_acp_sessions`
- `close_acp_session`
- `load_acp_session`

**`src-tauri/src/ipc/project_handlers.rs`** (1 command):
- `create_project`

Each handler removes `ConnectionKey::from_ids(...)` call — uses `connection` param directly.

### Step 3: Update event emissions

**`src-tauri/src/acp/manager.rs`** — replace `connection_key.to_event_payload()` with:
```rust
let mut payload = serde_json::to_value(&connection_key).unwrap_or_default();
payload["agent_id"] = serde_json::json!(agent_id);
```

Event shape becomes `{ "type": "ssh", "id": 5, "agent_id": "claude-code" }`.

### Step 4: Regen bindings

`pnpm tauri:gen` produces:
```typescript
export type ConnectionKey = 
  | { type: "local" }
  | { type: "ssh"; id: number }
  | { type: "wsl"; id: number };
```

### Step 5: Frontend utility

**New: `src/lib/connection-utils.ts`**
```typescript
import type { ConnectionKey, Project } from "@/types/bindings";

export function connectionKeyFromProject(project: Project): ConnectionKey {
  if (project.wsl_connection_id != null) return { type: "wsl", id: project.wsl_connection_id };
  if (project.connection_id != null) return { type: "ssh", id: project.connection_id };
  return { type: "local" };
}

export function connectionKeysEqual(a: ConnectionKey, b: ConnectionKey): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "local") return true;
  return (a as { id: number }).id === (b as { id: number }).id;
}
```

### Step 6: Update frontend hooks & components

**`src/services/execution.service.ts`** — all hooks change signature:
- `useAgentCacheQuery(agentId, connection: ConnectionKey)`
- `useAgentDiscoveryQuery(connection: ConnectionKey)`
- `useProjectAgentsQuery(connection: ConnectionKey, cwd)`
- Query keys: `["agentCache", connection, agentId]`
- Event listener: match with `connectionKeysEqual`

**`src/contexts/KanbanContext.tsx`** — replace two fields with `connection: ConnectionKey`

**Components passing connection params** (use `connectionKeyFromProject(project)` at call site):
- `src/views/AgentsView.tsx`
- `src/components/execution/SpawnSessionDialog.tsx`
- `src/components/execution/SessionHistoryPanel.tsx`
- `src/components/execution/activity/useAcpSessionLifecycle.ts`
- `src/components/execution/AgentActivityPanel.tsx`
- `src/components/kanban/CreateTaskModal.tsx`
- `src/components/task/TaskDetailScreen.tsx`

### What stays unchanged

- `Project` struct keeps `connection_id: Option<i32>` + `wsl_connection_id: Option<i32>` (DB FK columns, correct relational design)
- DB schema unchanged
- `ConnectionKey::from_ids` retained as internal helper for `Project` conversion

---

## Verification

1. `cargo check` — no compile errors
2. `pnpm tauri:gen` — bindings regenerate with `ConnectionKey` discriminated union
3. `pnpm build` — frontend compiles
4. `pnpm test` — all tests pass
5. Manual: spawn session on local → agent cache populates; open task detail → model/mode dropdowns show options
