# Phase 56: Import Modal + Change Detection — Research

**Researched:** 2026-05-24
**Domain:** Rust IPC + TanStack Query service layer + React modal UI + ticketing provider extension
**Confidence:** HIGH

## Summary

Phase 56 completes the ticketing import flow. The data model is fully in place (DB schema V17, Task struct with all import fields, TypeScript bindings generated). The Rust backend needs three new IPC commands (`import_tasks`, `update_task_from_remote`, `dismiss_task_change`) and a `priority` field added to `RemoteIssue` with HTML→markdown conversion for Azure DevOps. The frontend needs four new TanStack Query hooks and the `ImportTicketsModal` component with a Framer Motion animated 3-tab interface.

The codebase is clean and consistent. All patterns for new IPC commands, service hooks, and modal components are established by existing code. No new dependencies are needed on the frontend. The only new Rust dependency is an HTML→markdown crate (`htmd 0.5.4` — already confirmed on crates.io).

The classification logic (Available / Imported / Changed) is a **pure frontend derivation**: it compares `fetchRemoteIssues` results against the TanStack Query task cache. No extra IPC is needed for classification.

**Primary recommendation:** Follow existing patterns exactly. `import_tasks` mirrors `create_task_impl` but inserts all external fields and skips duplicates by `external_id`. The modal's tab structure follows `ProjectPicker.tsx` with `LayoutGroup` + `motion.span layoutId="import-modal-active-pill"`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- Task struct redesign (name→title, acceptance_criteria removed, TaskPriority::None, labels/external_url/external_updated_at) is ALREADY DONE. Plan 01 Task 1 must not repeat this work. Commit the 17 uncommitted files as a standalone commit before Plan 01 begins.
- `priority: Option<String>` field added to `RemoteIssue` struct, normalized to Maestro values before returning from each provider.
- Priority mapping by provider:
  - Linear: 0→`null`, 1→`"Urgent"`, 2→`"High"`, 3→`"Medium"`, 4→`"Low"`
  - Jira Cloud: `"Highest"`→`"Urgent"`, `"High"`→`"High"`, `"Medium"`→`"Medium"`, `"Low"`/`"Lowest"`→`"Low"`, else `null`
  - AzDo: 1→`"Urgent"`, 2→`"High"`, 3→`"Medium"`, 4→`"Low"`, else `null`
  - GitHub / GitLab / Forgejo: always `null`
- AzDo `System.Description` HTML→markdown conversion in `azure_devops.rs` using `htmd` (or `html2text` if htmd unsuitable).
- `import_tasks` IPC: batch insert from RemoteIssue list, skip duplicates by `external_id`, return created Tasks.
- `update_task_from_remote` IPC: sync title/description/labels/external_updated_at from remote issue.
- `dismiss_task_change` IPC: advance `external_updated_at` to remote value without content update.
- Classification logic is pure frontend derivation (no extra IPC round-trip).
- D-1: Row classification shown as pill/badge per row (Available/Imported/Changed).
- D-2: Imported tab shows DB tasks even when remote fetch fails.
- D-3: Import content mapping — all fields locked (see table in CONTEXT.md).
- D-4: Fetch failure shown inline per tab; no full-screen error.
- `base_branch` on import: project default branch.
- `import_source`: derived from `external_id` prefix (split on `:`, take index 0).

### Claude's Discretion

- Exact Rust crate chosen for HTML→markdown (`htmd` preferred per CONTEXT.md, `html2text` if htmd unsuitable).
- File placement for `ImportTicketsModal` (recommend `src/components/kanban/ImportTicketsModal.tsx` or `src/components/task/ImportTicketsModal.tsx`).
- New service functions and hooks placement (recommend in existing `src/services/task.service.ts` and `src/services/integration.service.ts`).

### Deferred Ideas (OUT OF SCOPE)

- Assignee field — needs dedicated DB column, Rust struct change, UI for pick/configure.
- Attachments — provider fetch scope and DB design TBD.
- External ID display in UI (as button with provider icon) — Phase 56 plan detail, not prerequisite.
- GitHub/GitLab OAuth (phases 53-55), webhook sync (IMPT-F01), two-way sync (IMPT-F02).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| IMPT-01 | "Import tickets" button in Backlog column header, visible only when provider is connected | BacklogView.tsx header pattern identified; `useProjectTicketingConfig` hook exists in `integration.service.ts` |
| IMPT-02 | Modal shows tickets in Available / Imported / Changed tabs | ProjectPicker.tsx LayoutGroup + AnimatePresence tab pattern verified; shadcn Dialog available |
| IMPT-03 | Checkbox multi-select → "Import Selected" creates Backlog tasks with `external_url`, `labels`, `external_updated_at` | `import_tasks` IPC needed; `create_task_impl` pattern in `task_handlers.rs` provides template |
| IMPT-04 | Auto-refresh fetches fresh tickets every 5 min while modal is open | TanStack Query `refetchInterval` option supports this; pause on modal close via `enabled` prop |
| IMPT-05 | Manual Refresh button forces immediate fetch | TanStack Query `refetch()` from `useQuery` result |
| IMPT-06 | Filter by label for providers that support it | Client-side filter on `RemoteIssue.labels`; Popover + Checkbox components available |
| CHNG-01 | On ticket fetch, compare provider `updated_at` against stored `external_updated_at`; flag as Changed if different | Pure frontend derivation: compare `RemoteIssue.updated_at` vs `Task.external_updated_at` |
| CHNG-02 | Changed tab: Update action (overwrites content) + Dismiss action (clears flag) | `update_task_from_remote` and `dismiss_task_change` IPCs needed |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Fetch remote issues | API / Backend (Rust) | — | Network I/O, auth, provider-specific logic all in Rust |
| Import task creation | API / Backend (Rust) | — | DB writes must go through Rust IPC |
| Update task from remote | API / Backend (Rust) | — | DB update; same tier as import creation |
| Dismiss task change | API / Backend (Rust) | — | DB update of `external_updated_at` field |
| Issue classification (Available/Imported/Changed) | Browser / Client | — | Pure derivation from cached data — no IPC round-trip |
| Label filter | Browser / Client | — | Client-side filter on already-fetched remote issues |
| Auto-refresh interval | Browser / Client | — | TanStack Query `refetchInterval` |
| Modal UI + tab state | Browser / Client | — | Local component state |
| HTML→markdown conversion (AzDo) | API / Backend (Rust) | — | Data normalization before returning `RemoteIssue` |

---

## Standard Stack

### Core (already installed — no new npm installs)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@tanstack/react-query` | Already in use | Async data fetching, caching, mutations | Project standard for all IPC |
| `framer-motion` | Already in use | Animated tab indicator (LayoutGroup) | Used by ProjectPicker |
| `lucide-react` | Already in use | Icons (`Download`/`ArrowDownToLine`, `RefreshCw`, `ExternalLink`, `Filter`) | Project icon standard |
| `@tauri-apps/plugin-opener` | Already in use | `openUrl()` to open external_url in browser | Used by MarkdownBlock.tsx |

[VERIFIED: codebase grep — all packages in use]

### New Rust Dependencies

| Crate | Version | Purpose | Notes |
|-------|---------|---------|-------|
| `htmd` | `0.5.4` | HTML→markdown conversion for AzDo `System.Description` | Modeled after `jc-adf` pattern in jira_cloud.rs |

[VERIFIED: `cargo search htmd` — `htmd = "0.5.4"` current on crates.io]

**Cargo.toml addition:**
```toml
htmd = "0.5.4"
```

**No new npm packages.** All frontend dependencies are already installed.

---

## Architecture Patterns

### System Architecture Diagram

```
User clicks "Import tickets" (BacklogView)
        │
        ▼
ImportTicketsModal opens
        │
        ├──► fetch_remote_issues (existing IPC) ──► Rust ticketing providers
        │           │                                   (GitHub/GitLab/Linear/Jira/AzDo/Forgejo)
        │           ▼                                   (AzDo: htmd HTML→markdown)
        │    RemoteIssue[] (with priority field)
        │           │
        │    [TanStack Query 5-min refetchInterval]
        │
        ├──► getTasks (existing IPC, cached) ──► SQLite tasks table
        │           │
        │           ▼
        │    Task[] (Backlog tasks with external_id, external_updated_at)
        │
        │ [Frontend classification — pure derivation]
        │    available  = RemoteIssues where external_id NOT in Task.external_id set
        │    imported   = Tasks where is_imported = true AND external_id in RemoteIssue set
        │    changed    = imported tasks where Task.external_updated_at ≠ RemoteIssue.updated_at
        │
        ├──[Available tab]── Checkbox select → "Import Selected"
        │                         │
        │                         ▼
        │                 import_tasks (new IPC)
        │                         │
        │                         ▼
        │                 Batch INSERT tasks (skip existing external_id)
        │                         │
        │                         ▼
        │                 emit "tasks-changed" → TanStack Query invalidation
        │
        ├──[Imported tab]── ExternalLink → openUrl() (tauri-plugin-opener)
        │
        └──[Changed tab]── "Update task" → update_task_from_remote (new IPC)
                         └── "Dismiss change" → dismiss_task_change (new IPC)
```

### Recommended Project Structure

New files to create:

```
src-tauri/src/ipc/
└── ticketing_handlers.rs   # ADD: import_tasks, update_task_from_remote, dismiss_task_change

src/components/kanban/
└── ImportTicketsModal.tsx   # NEW: 3-tab import modal

src/services/
└── task.service.ts          # ADD: useFetchRemoteIssuesQuery, useImportTasksMutation,
                             #      useUpdateTaskFromRemoteMutation, useDismissTaskChangeMutation
```

### Pattern 1: New IPC command in ticketing_handlers.rs

The three new commands follow the exact same structure as existing task/ticketing handlers:

```rust
// Source: task_handlers.rs pattern (verified)
#[tauri::command]
#[specta::specta]
pub async fn import_tasks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    issues: Vec<RemoteIssue>,
    base_branch: String,
) -> Result<Vec<Task>, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    // Collect existing external_ids for this project to skip duplicates
    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    // ... INSERT per issue, skip if external_id already exists ...
    // emit "tasks-changed" after commit

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(created_tasks)
}
```

Key points:
- Use a transaction for the batch insert (matches `update_task` pattern)
- Skip duplicates by checking `external_id` with `INSERT OR IGNORE` or pre-query
- `import_source` = first segment of `external_id.split(':').next()`
- Priority: `RemoteIssue.priority` mapped to `TaskPriority` via `FromStr`
- Must be registered in `lib.rs` `collect_commands![]` and bindings regenerated

### Pattern 2: TanStack Query hook for remote issues fetch

```typescript
// Source: integration.service.ts + task.service.ts patterns (verified)
export function useFetchRemoteIssuesQuery(projectId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["remote-issues", projectId],
    queryFn: () => api.fetchRemoteIssues(projectId!),
    enabled: enabled && projectId !== null,
    staleTime: 0,                          // always fresh on refetch
    refetchInterval: 5 * 60 * 1000,       // 5 minutes while modal open
    retry: 1,
  });
}
```

The `enabled` prop is set to `isModalOpen` so the interval pauses when modal closes. [VERIFIED: TanStack Query docs pattern, consistent with project usage]

### Pattern 3: Framer Motion animated tab indicator

Exact pattern from `ProjectPicker.tsx` [VERIFIED: source read]:

```tsx
// Source: ProjectPicker.tsx (verified)
<LayoutGroup id="import-modal-tab-nav">
  {TABS.map((tab) => {
    const isActive = activeTab === tab.id;
    return (
      <button key={tab.id} onClick={() => handleTabClick(tab)}>
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
</LayoutGroup>
```

Tab content slides with `AnimatePresence` + `slideVariants` + direction tracking via `prevTabRef`. [VERIFIED: ProjectPicker.tsx source]

### Pattern 4: AzDo HTML→markdown with htmd

```rust
// Source: jira_cloud.rs pattern for ADF conversion (verified)
// In azure_devops.rs fetch_issues(), replace:
//   body: item.fields.description,
// with:
fn html_to_markdown(html: &str) -> String {
    htmd::convert(html).unwrap_or_else(|_| html.to_string())
}
// ...
body: item.fields.description.map(|h| html_to_markdown(&h)),
```

[VERIFIED: `jc_adf::from_adf::to_markdown` is the Jira precedent; `htmd::convert` is equivalent API]

### Pattern 5: Classification derivation (frontend)

```typescript
// Pure derivation — no IPC
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

[VERIFIED: Consistent with STATE.md locked decision "Issue classification is a pure frontend derivation"]

### Pattern 6: Open external URL

```typescript
// Source: MarkdownBlock.tsx (verified)
import { openUrl } from "@tauri-apps/plugin-opener";
// ...
onClick={() => openUrl(task.external_url!)}
```

`tauri-plugin-opener` is already registered in `main.rs`. [VERIFIED: codebase]

### Anti-Patterns to Avoid

- **Don't add classification state to Rust IPC** — no new DB column or IPC command for "is changed". Changed state is derived per fetch cycle on the frontend.
- **Don't re-insert existing tasks** — check `external_id` uniqueness; use `INSERT OR IGNORE` or pre-filter.
- **Don't use `let _ =`** on the batch insert results — propagate errors per CLAUDE.md.
- **Don't skip the `tasks-changed` emit** — `import_tasks` must emit after batch insert so TanStack Query invalidates and the Imported tab updates immediately.
- **Don't bypass the `api` proxy** — never call `commands.X()` directly; always use `api.X()` which unwraps `Result<T, E>`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTML→markdown for AzDo | Custom regex stripping | `htmd 0.5.4` | Edge cases: nested tags, entities, tables |
| Tab animation | CSS transitions | `framer-motion` LayoutGroup | Already in codebase; spring physics match rest of app |
| External URL open | `window.open()` | `openUrl` from `tauri-apps/plugin-opener` | CSP blocks browser APIs; plugin already installed |
| Result unwrapping | Manual `.status === "ok"` checks | `api` proxy in `tauri-utils.ts` | Project standard; hooks throw on error |
| IPC error reporting | Custom error UI | TanStack Query `isError` + existing error card pattern | Consistent UX with rest of app |

---

## Common Pitfalls

### Pitfall 1: Duplicate import on re-fetch
**What goes wrong:** If the user opens the modal, imports tickets, then refreshes, already-imported tickets reappear in Available tab if classification uses stale task cache.
**Why it happens:** TanStack Query may not have invalidated the tasks list yet when re-fetching remote issues.
**How to avoid:** `import_tasks` emits `tasks-changed` on success, which the `useTasksQuery` listener will pick up. The `onSuccess` callback in `useImportTasksMutation` should also explicitly invalidate `taskQueryKeys.lists()`.
**Warning signs:** Available count doesn't drop after import.

### Pitfall 2: `RemoteIssue.priority` field missing from TypeScript bindings
**What goes wrong:** After adding `priority: Option<String>` to the Rust `RemoteIssue` struct, the TypeScript `RemoteIssue` type won't include it until bindings are regenerated.
**Why it happens:** `pnpm tauri:gen` must be run after every Rust struct change.
**How to avoid:** The Plan 01 bindings-regen task must run after all Rust changes in Wave 1.
**Warning signs:** TypeScript compilation errors on `remoteIssue.priority`.

### Pitfall 3: AzDo description is `Option<String>` HTML, not `Option<String>` markdown
**What goes wrong:** AzDo sends HTML in `System.Description`. Currently `body: item.fields.description` passes raw HTML to `RemoteIssue.body`, violating the internal "all providers deliver markdown" contract.
**Why it happens:** Legacy code pre-dates the contract.
**How to avoid:** Apply `html_to_markdown()` in the AzDo `fetch_issues` function before constructing `RemoteIssue`. Must handle `None` case (no description → `None`, not empty markdown).
**Warning signs:** Imported AzDo tasks show raw `<p>`, `<div>` tags in description field.

### Pitfall 4: `refetchInterval` keeps running after modal closes
**What goes wrong:** If `enabled` is not tied to `isOpen`, the 5-minute polling continues after the dialog unmounts.
**Why it happens:** TanStack Query `refetchInterval` is independent of component mount if the query key is shared.
**How to avoid:** Pass `enabled: isOpen && projectId !== null` to `useFetchRemoteIssuesQuery`. The query will be disabled and interval stopped when `isOpen` is false.
**Warning signs:** Network requests to `fetch_remote_issues` appearing in logs when modal is closed.

### Pitfall 5: `base_branch` defaults vs project config
**What goes wrong:** `import_tasks` needs a `base_branch` value. If the caller doesn't pass the project's default branch, tasks are created with an invalid branch.
**Why it happens:** `create_task_impl` requires `base_branch` (NOT NULL in DB).
**How to avoid:** The frontend must fetch the project's default branch (use `useProjectBranchesQuery` which already returns `[branches, currentBranch]`) and pass `currentBranch` as `base_branch` to `import_tasks`.
**Warning signs:** SQLite NOT NULL constraint error on insert.

### Pitfall 6: `external_id` conflict check scope
**What goes wrong:** `import_tasks` skips duplicates by `external_id` but doesn't scope to `project_id`, so a task imported in project A blocks import in project B for the same external issue.
**Why it happens:** `external_id` is not globally unique across projects — it's `github:42` which could appear in multiple repos.
**How to avoid:** The duplicate check in `import_tasks` must be `WHERE external_id = ? AND project_id = ?`.
**Warning signs:** Issues imported in one project cannot be imported in another.

---

## Code Examples

### import_tasks — SQL patterns

```rust
// Source: task_handlers.rs create_task_impl (verified) + schema.rs TASK_SELECT (verified)
// Check for existing external_id in this project:
let exists: bool = tx.query_row(
    "SELECT COUNT(*) FROM tasks WHERE external_id = ? AND project_id = ?",
    rusqlite::params![&issue.external_id, project_id],
    |row| row.get::<_, i64>(0),
).map(|count| count > 0).unwrap_or(false);

if exists { continue; }

// INSERT with all external fields:
tx.execute(
    "INSERT INTO tasks (project_id, title, description, status, priority, base_branch, \
     is_imported, import_source, external_id, external_url, external_updated_at, \
     labels, skills, created_at, updated_at) \
     VALUES (?, ?, ?, 'Backlog', ?, ?, 1, ?, ?, ?, ?, ?, '[]', ?, ?)",
    rusqlite::params![
        project_id, &issue.title,
        issue.body.as_deref().unwrap_or(""),
        priority_str,        // from issue.priority mapped to TaskPriority string
        &base_branch,
        &import_source,      // issue.external_id.split(':').next().unwrap_or("")
        &issue.external_id,
        &issue.url,
        &issue.updated_at,
        labels_json,         // serde_json::to_string(&issue.labels)
        &now, &now
    ],
).map_err(|e| e.to_string())?;
```

### update_task_from_remote — SQL pattern

```rust
// Source: update_task pattern in task_handlers.rs (verified)
tx.execute(
    "UPDATE tasks SET title = ?, description = ?, labels = ?, \
     external_updated_at = ?, updated_at = ? WHERE id = ?",
    rusqlite::params![
        &issue.title,
        issue.body.as_deref().unwrap_or(""),
        labels_json,
        &issue.updated_at,
        &now,
        task_id,
    ],
).map_err(|e| e.to_string())?;
```

### dismiss_task_change — SQL pattern

```rust
// Advance external_updated_at to match remote, no content change
conn.execute(
    "UPDATE tasks SET external_updated_at = ?, updated_at = ? WHERE id = ?",
    rusqlite::params![&remote_updated_at, &now, task_id],
).map_err(|e| e.to_string())?;
```

### useFetchRemoteIssuesQuery — service hook

```typescript
// Source: integration.service.ts + task.service.ts patterns (verified)
export const ticketingQueryKeys = {
  remoteIssues: (projectId: number) => ["ticketing", "remote-issues", projectId] as const,
};

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

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `Task.name` | `Task.title` | Phase 56 pre-plan (complete) | All 17 files updated; bindings at V17 |
| `acceptance_criteria` field | Removed | Phase 56 pre-plan (complete) | Field dropped from DB, Rust, TS |
| No `TaskPriority::None` | `TaskPriority::None` added | Phase 56 pre-plan (complete) | Maps from providers with no native priority |
| No priority in RemoteIssue | `priority: Option<String>` | Phase 56 Plan 01 | Providers normalize before returning |
| AzDo raw HTML body | AzDo markdown body via `htmd` | Phase 56 Plan 01 | All providers deliver markdown |

---

## Environment Availability

Step 2.6: SKIPPED for npm packages (all already installed). Rust crate addition:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `htmd` | AzDo HTML→markdown | Not yet (needs `cargo add`) | 0.5.4 | `html2text 0.17.1` if htmd unsuitable |

**Missing dependencies with no fallback:** None that block execution.

**Missing dependencies with fallback:** `htmd` — needs to be added to `src-tauri/Cargo.toml`; `html2text` is a viable alternative if htmd produces poor output.

---

## Validation Architecture

`workflow.nyquist_validation` is absent from `.planning/config.json` — treated as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (via `vite.config.ts` test config) |
| Config file | `vite.config.ts` (inline test config) |
| Quick run command | `pnpm test ImportTicketsModal` |
| Full suite command | `pnpm test` |
| Rust tests | `cargo test` from `src-tauri/` |

[VERIFIED: vite.config.ts source read]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IMPT-01 | "Import tickets" button hidden when no ticketing config | unit | `pnpm test BacklogView` | ❌ Wave 0 |
| IMPT-02 | Modal 3-tab render + tab switching | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 |
| IMPT-03 | `import_tasks` IPC skips duplicates, returns created tasks | Rust unit | `cargo test import_tasks` | ❌ Wave 0 |
| IMPT-04 | `refetchInterval` enabled only when modal is open | unit | `pnpm test useFetchRemoteIssuesQuery` | ❌ Wave 0 |
| IMPT-05 | Refresh button triggers refetch | unit (mock) | `pnpm test ImportTicketsModal` | ❌ Wave 0 |
| IMPT-06 | Label filter hides non-matching rows | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 |
| CHNG-01 | Changed classification when updated_at differs | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 |
| CHNG-02 | Update + Dismiss mutations call correct IPCs | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test <relevant pattern>` + `cargo test` in src-tauri
- **Per wave merge:** `pnpm test` (full suite) + `cargo test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

The following test files must be created in Wave 0 (before implementation):

- [ ] `src/components/kanban/__tests__/ImportTicketsModal.test.tsx` — covers IMPT-02, IMPT-05, IMPT-06, CHNG-01, CHNG-02
- [ ] `src/components/views/__tests__/BacklogView.test.tsx` — covers IMPT-01
- [ ] Rust `#[cfg(test)] mod tests` in `ticketing_handlers.rs` — covers IMPT-03

*(Existing pattern: `src/components/common/__tests__/DisconnectBackdrop.test.tsx`, `src/components/project-picker/__tests__/ProjectPicker.test.tsx`)*

---

## Security Domain

Security enforcement: no explicit `false` in config — treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Token already stored by Phase 52-55; `import_tasks` uses project-scoped DB |
| V3 Session Management | No | No new sessions |
| V4 Access Control | No | `import_tasks` scoped to `project_id` — same boundary as all task handlers |
| V5 Input Validation | Yes | `external_id`, `title`, `labels` from provider; length/content not validated |
| V6 Cryptography | No | No new crypto |

### Known Threat Patterns for Rust IPC + provider data

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Oversized provider payload | DoS | `first: 100` limit already in Linear query; GitHub/GitLab/Jira fetch first page only |
| Malicious title/description injected from provider | Tampering | Data stored as text; rendered via React (XSS-safe); no eval |
| SQL injection via external_id/title | Tampering | rusqlite parameterized queries (`rusqlite::params![]`) — already used throughout |
| Cross-project external_id collision | Tampering | Duplicate check must be `WHERE external_id = ? AND project_id = ?` — see Pitfall 6 |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `htmd::convert(html)` produces reasonable markdown from AzDo HTML | Standard Stack | AzDo descriptions may render poorly; fallback to html2text |
| A2 | AzDo `System.Priority` field (integer 1-4) maps to CONTEXT.md priority values | Standard Stack | Priority mapping may be wrong; needs empirical verification |
| A3 | `base_branch` for imported tasks should be the project's current branch from `useProjectBranchesQuery` | Code Examples | User may prefer a different default; low risk |

**Note on A2:** The CONTEXT.md mapping (1→Urgent, 2→High, 3→Medium, 4→Low) is specified by the user as locked, but AzDo's `Microsoft.VSTO.Priority` field name and numeric values should be confirmed against actual API responses. The current `WorkItemFields` struct does not include a Priority field — it needs to be added to the WIQL_FIELDS list.

---

## Open Questions (RESOLVED)

1. **AzDo priority field name**
   - What we know: AzDo uses `Microsoft.VSTO.Priority` or `System.Priority` for work item priority; the current `WorkItemFields` struct does not fetch it.
   - What's unclear: Exact field name in AzDo REST API (`Microsoft.VSTO.Priority` vs `Microsoft.Azure.DevOps.Agile.Priority`).
   - Recommendation: Add `"Microsoft.VSTO.Priority"` to `WIQL_FIELDS` and `WorkItemFields.priority: Option<i32>`, test against live AzDo; if field is absent, priority remains `null`.
   - RESOLVED: Use `Microsoft.VSTO.Priority` in `WIQL_FIELDS`; add `priority: Option<i32>` to `WorkItemFields` with `#[serde(rename = "Microsoft.VSTO.Priority")]`; map 1→Urgent, 2→High, 3→Medium, 4→Low; if field absent or unrecognized, priority is `None`.

2. **Linear priority field in GraphQL query**
   - What we know: Linear GraphQL API has a `priority` field on issues (integer 0-4).
   - What's unclear: Current `ISSUES_QUERY_ALL` and `ISSUES_QUERY_TEAM` do not request `priority`.
   - Recommendation: Add `priority` to both Linear GraphQL query strings and to `LinearIssue` struct.
   - RESOLVED: Add `priority` field to both `ISSUES_QUERY_ALL` and `ISSUES_QUERY_TEAM` GraphQL strings; add `priority: Option<i32>` to `LinearIssue` struct; 0→None, 1→Urgent, 2→High, 3→Medium, 4→Low.

3. **Jira priority field format**
   - What we know: Jira `fields.priority.name` is a string (`"Highest"`, `"High"`, `"Medium"`, `"Low"`, `"Lowest"`).
   - What's unclear: Current `JiraIssueFields` does not have a `priority` field.
   - Recommendation: Add `priority: Option<JiraIssuePriority>` struct with `name: String` field to `JiraIssueFields`.
   - RESOLVED: Add `JiraPriority { name: String }` struct and `priority: Option<JiraPriority>` to `JiraIssueFields`; map name: Highest→Urgent, High→High, Medium→Medium, Low/Lowest→Low, else None.

---

## Sources

### Primary (HIGH confidence)
- [VERIFIED: codebase] `src-tauri/src/models/task.rs` — Task struct, TASK_SELECT, TaskPriority enum
- [VERIFIED: codebase] `src-tauri/src/models/ticketing.rs` — RemoteIssue struct (no priority field yet)
- [VERIFIED: codebase] `src-tauri/src/db/schema.rs` — Schema V17, all task columns confirmed
- [VERIFIED: codebase] `src-tauri/src/ipc/task_handlers.rs` — create_task_impl, update_task patterns
- [VERIFIED: codebase] `src-tauri/src/ipc/ticketing_handlers.rs` — fetch_remote_issues dispatch
- [VERIFIED: codebase] `src-tauri/src/ticketing/azure_devops.rs` — WorkItemFields, no priority, HTML body
- [VERIFIED: codebase] `src-tauri/src/ticketing/linear.rs` — LinearIssue, no priority field
- [VERIFIED: codebase] `src-tauri/src/ticketing/jira_cloud.rs` — JiraIssueFields, no priority field
- [VERIFIED: codebase] `src/components/project-picker/ProjectPicker.tsx` — LayoutGroup tab pattern
- [VERIFIED: codebase] `src/components/views/BacklogView.tsx` — header layout, row pattern
- [VERIFIED: codebase] `src/services/task.service.ts` — TanStack Query hook patterns
- [VERIFIED: codebase] `src/services/integration.service.ts` — PROVIDER_NAMES, useProjectTicketingConfig
- [VERIFIED: codebase] `src/utils/helpers/tauri-utils.ts` — api proxy pattern
- [VERIFIED: codebase] `src/components/execution/activity/MarkdownBlock.tsx` — openUrl usage
- [VERIFIED: codebase] `src/utils/constants/animations.ts` — slideVariants, PAGE_TRANSITION_*
- [VERIFIED: codebase] `src-tauri/Cargo.toml` — existing Rust dependencies (no htmd yet)
- [VERIFIED: cargo search] `htmd = "0.5.4"` — current on crates.io

### Secondary (MEDIUM confidence)
- [CITED: TanStack Query docs] `refetchInterval` behavior — standard option, consistent with project usage

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified in codebase or crates.io
- Architecture: HIGH — all patterns verified against existing code
- Pitfalls: HIGH — derived from direct code inspection of existing insert/update patterns
- Open questions: MEDIUM — AzDo/Linear/Jira priority field names need verification against live APIs

**Research date:** 2026-05-24
**Valid until:** 2026-06-24 (stable domain; no fast-moving libraries)
