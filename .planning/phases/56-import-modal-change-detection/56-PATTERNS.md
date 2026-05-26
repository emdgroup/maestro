# Phase 56: Import Modal + Change Detection — Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 10 new/modified files
**Analogs found:** 10 / 10

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src-tauri/src/ipc/ticketing_handlers.rs` | handler | CRUD + request-response | `src-tauri/src/ipc/task_handlers.rs` | exact |
| `src-tauri/src/models/ticketing.rs` | model | — | self (add field to existing struct) | exact |
| `src-tauri/src/ticketing/azure_devops.rs` | service | request-response | `src-tauri/src/ticketing/jira_cloud.rs` | exact |
| `src-tauri/src/ticketing/linear.rs` | service | request-response | `src-tauri/src/ticketing/jira_cloud.rs` | exact |
| `src-tauri/src/ticketing/jira_cloud.rs` | service | request-response | self (add priority field) | exact |
| `src-tauri/src/lib.rs` | config | — | self (register 3 new commands) | exact |
| `src/services/task.service.ts` | service | CRUD + request-response | self (add 4 hooks) | exact |
| `src/components/kanban/ImportTicketsModal.tsx` | component | request-response | `src/components/project-picker/ProjectPicker.tsx` | role-match |
| `src/components/views/BacklogView.tsx` | component | CRUD | self (add Import button) | exact |
| `src-tauri/Cargo.toml` | config | — | self (add htmd dep) | exact |

---

## Pattern Assignments

### `src-tauri/src/ipc/ticketing_handlers.rs` (handler, CRUD)

**Analog:** `src-tauri/src/ipc/task_handlers.rs`

Three new commands are added to the existing `ticketing_handlers.rs`. The file already exists with `get_project_ticketing_config`, `save_project_ticketing_config`, and `fetch_remote_issues`.

**Imports pattern** (`ticketing_handlers.rs` lines 1–8):
```rust
use std::sync::Arc;
use tauri::State;
use crate::db::AppState;
use crate::models::project_config::{now_rfc3339, ProjectConfig, ProjectTicketingConfig};
use crate::models::ticketing::RemoteIssue;
use crate::ticketing::keychain::{KeychainOutcome, KeychainStore};
```

New imports to add for the three new commands:
```rust
use tauri::Emitter;
use chrono::Utc;
use crate::models::{Task, TASK_SELECT};
```

**IPC command declaration pattern** (`task_handlers.rs` lines 8–26):
```rust
#[tauri::command]
#[specta::specta]
pub fn get_tasks(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Task>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    // ...
    Ok(tasks)
}
```

`import_tasks` is async (HTTP-derived data), so it uses `pub async fn` like `fetch_remote_issues`. `update_task_from_remote` and `dismiss_task_change` only touch the DB and can be sync like `update_task`.

**Transaction pattern** (`task_handlers.rs` lines 93–149):
```rust
pub fn update_task(
    app_state: State<Arc<AppState>>,
    // ...
) -> Result<Task, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    // ... execute SQL inside tx ...

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = tx.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}
```

**Emit after mutation pattern** (`task_handlers.rs` line 75 and 148):
```rust
app_state.app_handle.emit("tasks-changed", ()).ok();
Ok(task)
```

**Parameterized query pattern** (`task_handlers.rs` lines 49–54):
```rust
conn.execute(
    "INSERT INTO tasks (project_id, title, description, skills, status, base_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    rusqlite::params![project_id, &title, &description, &skills_json, "Backlog", &base_branch, &now, &now],
)
.map_err(|e| e.to_string())?;
```

**Read-back after insert pattern** (`task_handlers.rs` lines 56–59):
```rust
let task_id = conn.last_insert_rowid();
let query = format!("{} WHERE id = ?", TASK_SELECT);
conn.query_row(&query, [task_id], Task::from_row)
    .map_err(|e| e.to_string())
```

**JSON serialization for Vec fields** (`task_handlers.rs` lines 46–47):
```rust
let skills_json = serde_json::to_string(&skills)
    .map_err(|e| format!("JSON serialization failed: {}", e))?;
```

**`import_tasks` specific — duplicate check** (from RESEARCH.md code examples):
```rust
let exists: bool = tx.query_row(
    "SELECT COUNT(*) FROM tasks WHERE external_id = ? AND project_id = ?",
    rusqlite::params![&issue.external_id, project_id],
    |row| row.get::<_, i64>(0),
).map(|count| count > 0).unwrap_or(false);

if exists { continue; }
```

The duplicate check must scope to `project_id` — do not check global uniqueness on `external_id` alone (Pitfall 6).

**`import_source` derivation** (RESEARCH.md Pattern 1):
```rust
let import_source = issue.external_id.split(':').next().unwrap_or("").to_string();
```

---

### `src-tauri/src/models/ticketing.rs` (model, struct extension)

**Analog:** self — add `priority: Option<String>` field to `RemoteIssue`.

**Current `RemoteIssue` struct** (`ticketing.rs` lines 86–95):
```rust
/// A remote issue fetched from a ticketing provider, ready for import as a Task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct RemoteIssue {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: Option<String>,
}
```

After adding `priority`:
```rust
pub struct RemoteIssue {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: Option<String>,
    pub priority: Option<String>,   // normalized: "Urgent"|"High"|"Medium"|"Low"|null
}
```

All existing `RemoteIssue { ... }` construction sites in provider files must add `priority: <mapped_value>`. Bindings must be regenerated after this change.

---

### `src-tauri/src/ticketing/azure_devops.rs` (service, request-response)

**Analog:** `src-tauri/src/ticketing/jira_cloud.rs` for the `extract_body` / ADF conversion pattern (lines 39–41):
```rust
fn extract_body(description: Option<serde_json::Value>) -> Option<String> {
    description.map(|adf| jc_adf::from_adf::to_markdown(&adf))
}
```

**AzDo HTML→markdown pattern** (mirrors Jira's `extract_body`):
```rust
fn html_to_markdown(html: &str) -> String {
    htmd::convert(html).unwrap_or_else(|_| html.to_string())
}
```

Apply to body field in the `RemoteIssue` construction at lines 247–254 (current):
```rust
// Before (line 250):
body: item.fields.description,

// After:
body: item.fields.description.map(|h| html_to_markdown(&h)),
```

**`WorkItemFields` priority addition** (add to struct at lines 59–69):
```rust
#[derive(serde::Deserialize)]
struct WorkItemFields {
    #[serde(rename = "System.Title")]
    title: String,
    #[serde(rename = "System.Description")]
    description: Option<String>,
    #[serde(rename = "System.ChangedDate")]
    changed_date: Option<String>,
    #[serde(rename = "System.Tags")]
    tags: Option<String>,
    // new:
    #[serde(rename = "Microsoft.VSTO.Priority")]
    priority: Option<i32>,
}
```

Add `"Microsoft.VSTO.Priority"` to `WIQL_FIELDS` at line 71.

**Priority normalization pattern** (follow CONTEXT.md mapping, inline in `RemoteIssue` construction):
```rust
priority: match item.fields.priority {
    Some(1) => Some("Urgent".to_string()),
    Some(2) => Some("High".to_string()),
    Some(3) => Some("Medium".to_string()),
    Some(4) => Some("Low".to_string()),
    _ => None,
},
```

**AzDo Cargo.toml addition** (`src-tauri/Cargo.toml` — add alongside `jc-adf`):
```toml
jc-adf = "0.2"
htmd = "0.5.4"
```

---

### `src-tauri/src/ticketing/linear.rs` (service, request-response)

**Analog:** self — add `priority` field to `LinearIssue` struct and update query constants.

**Current `LinearIssue` struct** (lines 36–44):
```rust
#[derive(serde::Deserialize)]
struct LinearIssue {
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    labels: LabelConnection,
}
```

After adding `priority`:
```rust
#[derive(serde::Deserialize)]
struct LinearIssue {
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    labels: LabelConnection,
    priority: Option<i32>,   // 0=null, 1=Urgent, 2=High, 3=Medium, 4=Low
}
```

**Query string update** (lines 79–80 — add `priority` to both query strings):
```rust
// Before:
const ISSUES_QUERY_ALL: &str = r#"{ issues(first: 100) { nodes { identifier title description url updatedAt labels { nodes { name } } } } }"#;

// After (add `priority` field):
const ISSUES_QUERY_ALL: &str = r#"{ issues(first: 100) { nodes { identifier title description url updatedAt priority labels { nodes { name } } } } }"#;
```

Same change applies to `ISSUES_QUERY_TEAM`.

**`RemoteIssue` construction** (lines 257–267 — add priority mapping):
```rust
let remote_issues = nodes
    .into_iter()
    .map(|issue| RemoteIssue {
        external_id: format!("linear:{}", issue.identifier),
        title: issue.title,
        body: issue.description,
        url: issue.url,
        labels: issue.labels.nodes.into_iter().map(|l| l.name).collect(),
        updated_at: issue.updated_at,
        priority: match issue.priority {
            Some(1) => Some("Urgent".to_string()),
            Some(2) => Some("High".to_string()),
            Some(3) => Some("Medium".to_string()),
            Some(4) => Some("Low".to_string()),
            _ => None,
        },
    })
    .collect();
```

---

### `src-tauri/src/ticketing/jira_cloud.rs` (service, request-response)

**Analog:** self — add `priority` field to `JiraIssueFields`.

**Current `JiraIssueFields`** (lines 27–32):
```rust
#[derive(serde::Deserialize)]
struct JiraIssueFields {
    summary: String,
    description: Option<serde_json::Value>,
    labels: Vec<String>,
    updated: Option<String>,
}
```

After adding priority support:
```rust
#[derive(serde::Deserialize)]
struct JiraPriority {
    name: String,
}

#[derive(serde::Deserialize)]
struct JiraIssueFields {
    summary: String,
    description: Option<serde_json::Value>,
    labels: Vec<String>,
    updated: Option<String>,
    priority: Option<JiraPriority>,
}
```

**JQL query update** (line 130 — add `priority` to fields):
```
// Before:
"?maxResults=100&fields=summary,description,labels,updated,self&jql=..."

// After:
"?maxResults=100&fields=summary,description,labels,updated,priority,self&jql=..."
```

**Priority normalization in `RemoteIssue` construction** (lines 165–179):
```rust
priority: issue.fields.priority.as_ref().and_then(|p| match p.name.as_str() {
    "Highest" => Some("Urgent".to_string()),
    "High" => Some("High".to_string()),
    "Medium" => Some("Medium".to_string()),
    "Low" | "Lowest" => Some("Low".to_string()),
    _ => None,
}),
```

---

### `src-tauri/src/lib.rs` (config, command registration)

**Analog:** self — append three new commands to `collect_commands![]`.

**Existing ticketing block** (lines 131–135):
```rust
            // Project ticketing config (Phase 55)
            crate::ipc::get_project_ticketing_config,
            crate::ipc::save_project_ticketing_config,
            crate::ipc::fetch_remote_issues,
        ])
```

**After adding Phase 56 commands:**
```rust
            // Project ticketing config (Phase 55)
            crate::ipc::get_project_ticketing_config,
            crate::ipc::save_project_ticketing_config,
            crate::ipc::fetch_remote_issues,
            // Import / change detection (Phase 56)
            crate::ipc::import_tasks,
            crate::ipc::update_task_from_remote,
            crate::ipc::dismiss_task_change,
        ])
```

---

### `src/services/task.service.ts` (service, CRUD + request-response)

**Analog:** self — add four new hooks following established patterns.

**Query key factory pattern** (lines 14–26 — extend `taskQueryKeys`):
```typescript
export const taskQueryKeys = {
  base: ["tasks"] as const,
  lists: () => [...taskQueryKeys.base, "list"] as const,
  list: (projectId: number) => [...taskQueryKeys.lists(), { projectId }] as const,
  // ...
};
```

For remote issues, add a separate key factory (mirrors `integrationQueryKeys` in `integration.service.ts` lines 17–22):
```typescript
export const ticketingQueryKeys = {
  remoteIssues: (projectId: number) => ["ticketing", "remote-issues", projectId] as const,
};
```

**`useQuery` hook pattern** (`task.service.ts` lines 51–57):
```typescript
return useQuery({
  queryKey: taskQueryKeys.list(projectId!),
  queryFn: () => api.getTasks(projectId!),
  enabled: projectId !== null,
  staleTime: 30000,
  refetchOnWindowFocus: true,
});
```

**`useFetchRemoteIssuesQuery`** follows `useProjectBranchesQuery` style (lines 328–335) with `enabled` + `refetchInterval`:
```typescript
export function useFetchRemoteIssuesQuery(projectId: number | null, isModalOpen: boolean) {
  return useQuery({
    queryKey: ticketingQueryKeys.remoteIssues(projectId!),
    queryFn: () => api.fetchRemoteIssues(projectId!),
    enabled: isModalOpen && projectId !== null,
    staleTime: 0,
    refetchInterval: isModalOpen ? 5 * 60 * 1000 : false,
    retry: 1,
  });
}
```

**`useMutation` pattern with `queryClient.invalidateQueries`** (`task.service.ts` lines 75–92):
```typescript
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: Task) =>
      api.createTask(/* ... */),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to create task"),
  });
}
```

`useImportTasksMutation` must invalidate `taskQueryKeys.lists()` on success in addition to the backend `tasks-changed` event (Pitfall 1 — double-invalidation prevents stale Available tab).

**`api` proxy usage** (`tauri-utils.ts` lines 28–54): all `mutationFn` bodies call `api.X()`, never `commands.X()` directly.

---

### `src/components/kanban/ImportTicketsModal.tsx` (component, request-response)

**Analog:** `src/components/project-picker/ProjectPicker.tsx` (tab animation) + `src/components/kanban/TaskModal.tsx` (Dialog wrapper) + `src/components/common/ReviewModal.tsx` (modal with query inside)

**Imports pattern** (from `ProjectPicker.tsx` lines 1–13):
```typescript
import { useState, useRef } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import {
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING,
} from "@/utils/constants/animations";
```

Additional imports for `ImportTicketsModal`:
```typescript
import { Dialog, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from "@/ui/dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RefreshCw, Download } from "lucide-react";
import { useFetchRemoteIssuesQuery, useImportTasksMutation, useUpdateTaskFromRemoteMutation, useDismissTaskChangeMutation } from "@/services/task.service";
import { useTasksQuery, useProjectBranchesQuery } from "@/services/task.service";
import { useProjectTicketingConfig } from "@/services/integration.service";
import type { RemoteIssue, Task } from "@/types/bindings";
```

**Dialog wrapper pattern** (`TaskModal.tsx` lines 44–69):
```tsx
return (
  <Dialog open={isOpen} onOpenChange={onClose}>
    <DialogPortal>
      <DialogOverlay />
      <DialogContent>
        <DialogTitle>Import Tickets</DialogTitle>
        {/* content */}
      </DialogContent>
    </DialogPortal>
  </Dialog>
);
```

**Tab array + direction-tracking pattern** (`ProjectPicker.tsx` lines 15–41):
```typescript
type TabId = "available" | "imported" | "changed";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "available", label: "Available" },
  { id: "imported", label: "Imported" },
  { id: "changed", label: "Changed" },
];

const TAB_ORDER: TabId[] = ["available", "imported", "changed"];

const [activeTab, setActiveTab] = useState<TabId>("available");
const [tabSlideDir, setTabSlideDir] = useState(1);
const prevTabRef = useRef<TabId>("available");

const handleTabClick = (tab: TabId) => {
  if (tab === prevTabRef.current) return;
  const prevIdx = TAB_ORDER.indexOf(prevTabRef.current);
  const newIdx = TAB_ORDER.indexOf(tab);
  setTabSlideDir(newIdx > prevIdx ? 1 : -1);
  prevTabRef.current = tab;
  setActiveTab(tab);
};
```

**Animated tab bar** (`ProjectPicker.tsx` lines 67–98):
```tsx
<LayoutGroup id="import-modal-tab-nav">
  <div className="grid grid-cols-3 rounded-lg bg-muted p-1 gap-1 mb-4">
    {TABS.map((tab) => {
      const isActive = activeTab === tab.id;
      return (
        <button
          key={tab.id}
          onClick={() => handleTabClick(tab.id)}
          className={`relative flex w-full items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium outline-none ${
            isActive ? "" : "cursor-pointer hover:bg-background/50"
          }`}
        >
          {isActive && (
            <motion.span
              layoutId="import-modal-active-pill"
              className="absolute inset-0 rounded-md bg-background shadow-sm"
              transition={{ type: "spring", stiffness: 400, damping: 35 }}
            />
          )}
          <motion.span
            animate={{ color: isActive ? "var(--accent)" : "var(--muted-foreground)" }}
            transition={{ duration: 0.15 }}
            className="relative z-10"
          >
            {tab.label} ({count})
          </motion.span>
        </button>
      );
    })}
  </div>
</LayoutGroup>
```

**Animated tab content** (`ProjectPicker.tsx` lines 102–118):
```tsx
<div className="flex-1 relative overflow-hidden">
  <AnimatePresence initial={false} custom={tabSlideDir}>
    <motion.div
      key={activeTab}
      custom={tabSlideDir}
      variants={slideVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
      className="absolute inset-0 overflow-hidden"
    >
      {activeTab === "available" && <AvailableTab />}
      {activeTab === "imported" && <ImportedTab />}
      {activeTab === "changed" && <ChangedTab />}
    </motion.div>
  </AnimatePresence>
</div>
```

**Row pill/badge pattern** (`BacklogView.tsx` lines 128–134):
```tsx
<span
  className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE_CLASSES[task.priority]}`}
>
  {task.priority}
</span>
```

Adapt for classification pills:
- `Available` → `bg-muted text-muted-foreground`
- `Imported` → `bg-green-500/15 text-green-700 dark:text-green-400`
- `Changed` → `bg-amber-500/15 text-amber-700 dark:text-amber-400` with `!` prefix

**Error inline pattern** (`ReviewModal.tsx` lines 42–49):
```typescript
const reviewError = useMemo(() => {
  if (!isOpen) return null;
  if (diffError) {
    const errorMsg = diffError instanceof Error ? diffError.message : String(diffError);
    return `Failed to fetch diff: ${errorMsg}`;
  }
  return null;
}, [isOpen, diffError]);
```

**`openUrl` pattern** (`src/components/execution/activity/MarkdownBlock.tsx`):
```typescript
import { openUrl } from "@tauri-apps/plugin-opener";
// ...
onClick={() => openUrl(task.external_url!)}
```

**Classification derivation** (pure frontend, no IPC — from RESEARCH.md Pattern 5):
```typescript
const importedExternalIds = new Set(
  (tasks ?? [])
    .filter(t => t.is_imported && t.external_id)
    .map(t => t.external_id!)
);

const remoteIssueMap = new Map(
  (remoteIssues ?? []).map(r => [r.external_id, r])
);

const available = (remoteIssues ?? []).filter(r => !importedExternalIds.has(r.external_id));

const importedTasks = (tasks ?? []).filter(
  t => t.is_imported && t.external_id && remoteIssueMap.has(t.external_id!)
);

const changedTasks = importedTasks.filter(t => {
  const remote = remoteIssueMap.get(t.external_id!);
  return remote && remote.updated_at !== t.external_updated_at;
});
```

**`refetchInterval` gated on `isOpen`** (RESEARCH.md Pattern 2 + Pitfall 4):
Pass `isOpen` as `isModalOpen` to `useFetchRemoteIssuesQuery`. Polling stops automatically when modal is closed because `enabled: isModalOpen && projectId !== null`.

---

### `src/components/views/BacklogView.tsx` (component, CRUD)

**Analog:** self — add "Import tickets" button to the header and a modal trigger.

**Existing header section** (`BacklogView.tsx` lines 85–96):
```tsx
<div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
  <div>
    <h2 className="text-sm font-semibold text-foreground">Backlog</h2>
    <p className="text-xs text-muted-foreground mt-0.5">
      Tasks waiting to be refined and promoted to the board
    </p>
  </div>
  <Button variant="accent" size="sm" onClick={openCreate} className="h-8">
    <Plus className="w-4 h-4" />
    Add Task
  </Button>
</div>
```

**Gating pattern** — use `useProjectTicketingConfig` from `integration.service.ts` (line 64):
```typescript
import { useProjectTicketingConfig } from "@/services/integration.service";
// ...
const { data: ticketingConfig } = useProjectTicketingConfig(projectId ?? 0);
const hasTicketing = ticketingConfig != null;
```

Then conditionally render the Import button before "Add Task":
```tsx
{hasTicketing && (
  <Button variant="ghost" size="sm" onClick={openImportModal} className="h-8">
    <Download className="w-4 h-4" />
    Import tickets
  </Button>
)}
```

**Modal state pattern** (follows `useState` pairs already in file, lines 30–32):
```typescript
const [importModalOpen, setImportModalOpen] = useState(false);
const openImportModal = () => setImportModalOpen(true);
const closeImportModal = () => setImportModalOpen(false);
```

---

## Shared Patterns

### IPC command registration
**Source:** `src-tauri/src/lib.rs` lines 24–135
**Apply to:** All three new commands in `ticketing_handlers.rs`
```rust
// After adding to ticketing_handlers.rs, register in lib.rs:
crate::ipc::import_tasks,
crate::ipc::update_task_from_remote,
crate::ipc::dismiss_task_change,
// Then run: pnpm tauri:gen
```

### DB lock pattern
**Source:** `src-tauri/src/ipc/task_handlers.rs` lines 13–14 (sync) and `ticketing_handlers.rs` lines 11–14 (async)
**Apply to:** All three new IPC commands
```rust
// Sync commands:
let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
// Commands needing transaction:
let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;
```

### Error mapping
**Source:** `src-tauri/src/ipc/task_handlers.rs` throughout
**Apply to:** All Rust IPC commands
```rust
.map_err(|e| e.to_string())?   // rusqlite errors
.map_err(|e| format!("...: {}", e))?  // custom context
```
Never `unwrap()`. Never `let _ =` on fallible operations.

### `tasks-changed` emit
**Source:** `src-tauri/src/ipc/task_handlers.rs` lines 75 and 148
**Apply to:** `import_tasks`, `update_task_from_remote`, `dismiss_task_change`
```rust
app_state.app_handle.emit("tasks-changed", ()).ok();
```
Emit after commit/success. The `.ok()` silently ignores emit errors (acceptable; listeners are best-effort).

### TanStack Query invalidation
**Source:** `src/services/task.service.ts` lines 87–89
**Apply to:** All three frontend mutation hooks
```typescript
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
},
```

### Error toast on mutation failure
**Source:** `src/services/task.service.ts` lines 90–91
**Apply to:** All three new mutation hooks
```typescript
onError: createErrorToastHandler("Failed to import tasks"),
```
Import from `@/lib/error-utils`.

### `api` proxy (never call `commands` directly)
**Source:** `src/utils/helpers/tauri-utils.ts` lines 28–54
**Apply to:** All `mutationFn` and `queryFn` bodies
```typescript
// Correct:
queryFn: () => api.fetchRemoteIssues(projectId!),
// Wrong:
queryFn: () => commands.fetchRemoteIssues(projectId!),
```

---

## Test File Patterns

### Frontend component test
**Analog:** `src/components/project-picker/__tests__/ProjectPicker.test.tsx`

**Test structure** (lines 1–10):
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ImportTicketsModal } from "../ImportTicketsModal.tsx";

// Mock all service hooks used by the component
vi.mock("@/services/task.service", () => ({
  useFetchRemoteIssuesQuery: vi.fn(),
  useImportTasksMutation: vi.fn(),
  useTasksQuery: vi.fn(),
  // ...
}));
```

**Mocked hook return shape** (follows test patterns in the file):
```typescript
import { vi } from "vitest";
(useFetchRemoteIssuesQuery as ReturnType<typeof vi.fn>).mockReturnValue({
  data: [],
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});
```

**Test placement:** `src/components/kanban/__tests__/ImportTicketsModal.test.tsx`

---

## No Analog Found

All files have close analogs. No files require research-only patterns.

---

## Metadata

**Analog search scope:** `src-tauri/src/ipc/`, `src-tauri/src/ticketing/`, `src-tauri/src/models/`, `src/services/`, `src/components/kanban/`, `src/components/views/`, `src/components/project-picker/`, `src/utils/constants/`
**Files scanned:** 14 analog files read in full or targeted sections
**Pattern extraction date:** 2026-05-24
