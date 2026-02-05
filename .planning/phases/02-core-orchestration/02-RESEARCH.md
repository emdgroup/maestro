# Phase 2: Core Orchestration - Research

**Research Date:** 2026-02-05
**Objective:** What do I need to know to PLAN this phase well?

## Executive Summary

Phase 2 requires implementing a Kanban board UI with task management, drag-drop workflows, and GitHub/Jira issue import. The implementation spans React frontend components, Tauri IPC handlers, database operations, and third-party API integrations. Key research focuses on proven libraries, integration patterns, and architectural decisions needed for successful planning.

---

## 1. Kanban Board Implementation

### 1.1 Drag-and-Drop Libraries

**Finding:** Three production-grade libraries compete for this use case:

| Library | Strength | When to Use |
|---------|----------|-------------|
| **React Beautiful DnD** (`/hello-pangea/dnd`) | Most widely adopted, natural movement, excellent keyboard support | Complex Kanban with accessibility requirements (HIGH MATCH - 91.2 score, 299 snippets) |
| **dnd-kit** (`/websites/dndkit`) | Lightweight, modular, hooks-based, customizable | Performance-critical or complex drag scenarios (85.1 score, 315 snippets) |
| **Pragmatic Drag and Drop** (`/atlassian/pragmatic-drag-and-drop`) | Low-level, framework-agnostic, uses browser native DnD | Maximum flexibility (89.7 score, 316 snippets) |

**Recommendation:** **React Beautiful DnD** is optimal for Phase 2 because:
- Highest adoption in production Kanban boards
- Excellent accessibility (screen readers, keyboard support)
- Intuitive drop-zone feedback (dim invalid zones matches decision spec)
- Handles task re-ordering and column transitions cleanly
- Large community and documentation

### 1.2 Board State Management

**Finding:** Zustand is the lightweight choice for this scope.

**Options:**
- **Zustand** (`/pmndrs/zustand` v5.0.8 or latest): Small (2KB), hook-based, immutable-friendly with Immer middleware
- **Redux/Redux Toolkit**: Overkill for Phase 2 scope
- **Jotai**: Similar to Zustand, slightly heavier

**Recommendation:** Use **Zustand + Immer middleware** because:
- Minimal boilerplate for CRUD operations (create, read, update, delete tasks)
- Immutable array updates: `.toSpliced()`, `.map()`, `.filter()` methods cleanly
- Can define mutable update logic with Immer: `set((state) => { state.tasks.push(...) })`
- Isolates task state (filtering by status, sorting by column)
- Easy to persist to localStorage for quick saves

**Pattern for Phase 2:**
```typescript
// Board state store
const useBoardStore = create<BoardState>()(
  immer((set) => ({
    tasks: [], // All tasks
    updateTaskStatus: (taskId, newStatus) => set((state) => {
      const task = state.tasks.find(t => t.id === taskId);
      if (task) task.status = newStatus;
    }),
    addTask: (task) => set((state) => {
      state.tasks.push(task);
    }),
  }))
);
```

### 1.3 Column Layout Strategy

**Decision Point:** Fit all columns to viewport without horizontal scroll.

**Options:**
1. CSS Grid with `auto-fit` columns (columns shrink to fit)
2. Flexbox with `flex: 1` on each column
3. Fixed width with overflow scroll (rejected by spec)

**Recommendation:** **CSS Grid with dynamic column width**
```css
.kanban-board {
  display: grid;
  grid-template-columns: repeat(5, 1fr); /* 5 equal columns */
  gap: 1rem;
  width: 100%;
  height: calc(100vh - 60px); /* Fit viewport */
}

.column {
  display: flex;
  flex-direction: column;
  min-width: 0; /* Prevent flex overflow */
  overflow-y: auto; /* Allow task cards to scroll within column */
}
```

This ensures:
- All 5 columns visible without horizontal scroll
- Columns squeeze proportionally on small screens
- Tasks within columns scroll independently
- Column headers visible at all times

---

## 2. Task Modal and Form Implementation

### 2.1 Form Libraries

**Finding:** React Hook Form is the standard for this pattern.

**Options:**
- **React Hook Form**: Minimal, headless, highly efficient (140+ snippets, High reputation)
- **Formik**: More opinionated, heavier (3-4KB vs Hook Form's 8KB)
- **Final Form**: Similar to Formik

**Recommendation:** **React Hook Form** because:
- Integrates cleanly with Radix Dialog (next section)
- Minimal re-renders (stores field state separately)
- Validation works well with required fields (title, description, acceptance_criteria)
- Easy error handling and submission

**Phase 2 Pattern:**
```typescript
interface TaskForm {
  title: string;
  description: string;
  acceptanceCriteria: string;
}

const { register, handleSubmit, formState: { errors } } = useForm<TaskForm>({
  mode: 'onBlur',
});

const onSubmit = async (data: TaskForm) => {
  const newTask = await invoke('create_task', {
    title: data.title,
    description: data.description,
    acceptance_criteria: data.acceptanceCriteria,
  });
  // Update board state
};
```

### 2.2 Dialog/Modal Component

**Finding:** Radix Primitives Dialog is the accessible baseline.

**Options:**
- **Radix Primitives Dialog** (`/websites/radix-ui-primitives`): Low-level, fully accessible, 340 snippets
- **Headless UI**: Similar, slightly more opinionated
- **shadcn/ui**: Built on Radix, styled, includes Dialog preset

**Recommendation:** **Radix Dialog** (or shadcn/ui wrapper if styling is heavy) because:
- WAI-ARIA compliant (required for accessible UI)
- Keyboard navigation: Esc to close, Tab to navigate fields
- Screen reader announcements via `Dialog.Title` and `Dialog.Description`
- Composable with forms (no conflicting state management)
- Uncontrolled or controlled patterns supported

**Accessibility Requirements Met:**
- `Dialog.Trigger` button opens modal
- Focus trap (Tab cycles through form fields, then close button)
- Esc closes modal and returns focus to trigger
- Screen readers announce title on open

---

## 3. GitHub and Jira Integration

### 3.1 GitHub Issues API

**Finding:** Use Octokit REST client for GitHub integration.

**Library:** Octokit Rest (`/octokit/rest.js`, 82.6 score, 140 snippets)

**GitHub Endpoint:** `GET /repos/{owner}/{repo}/issues`

**Relevant Query Parameters:**
- `state`: 'open' (import only open issues to Backlog, per spec)
- `per_page`: 100 (paginate through large repos)
- `sort`: 'updated' (most recent changes first)

**Field Mapping for Task Import:**
- GitHub `title` → Task `name`
- GitHub `body` → Task `description`
- GitHub `number` (issue #) → Task `external_id` (for conflict detection)
- GitHub `updated_at` → Task `updated_at`

**Implementation Consideration:**
- Store `external_id` (GitHub issue number) in tasks table
- Use `external_id` to detect conflicts on re-sync (update if exists, insert if new)
- Mark imported tasks as read-only (add `is_imported` boolean flag to tasks table)

**Error Handling Strategy:**
- Network errors: Show error toast "Failed to fetch GitHub issues"
- Auth errors (401): Prompt for GitHub token in settings
- Rate limit (403): Show toast "GitHub API rate limit exceeded, try later"
- Validation errors: Skip malformed issues, continue import

### 3.2 Jira Issues API

**Finding:** Use Jira.js client for Jira integration.

**Library:** Jira.js (`/mrrefactoring/jira.js`) - comprehensive Jira Cloud REST API v3 wrapper

**Jira Endpoint:** `/issueSearch` via JQL (Jira Query Language)

**Typical JQL Query:**
```
project = "PROJECT_KEY" AND type = Task ORDER BY updated DESC
```

**Authentication Pattern (Jira Cloud):**
```typescript
const client = new Version3Client({
  host: 'https://your-domain.atlassian.net',
  authentication: {
    basic: {
      email: 'your@email.com',
      apiToken: 'YOUR_API_TOKEN', // User-provided in settings
    },
  },
});

const issues = await client.issueSearch.searchForIssuesUsingJql({
  jql: 'project = "GSD" AND type = Task',
  maxResults: 100,
});
```

**Field Mapping for Task Import:**
- Jira `summary` → Task `name`
- Jira `description` → Task `description`
- Jira `key` (e.g., "GSD-123") → Task `external_id` (for conflict detection)
- Jira `updated` → Task `updated_at`

**Configuration Storage (in settings table):**
```json
{
  "import_provider": "github" | "jira",
  "github_config": {
    "owner": "octocat",
    "repo": "Hello-World",
    "token": "ghp_..."
  },
  "jira_config": {
    "host": "https://my-domain.atlassian.net",
    "email": "user@example.com",
    "api_token": "JIRA_..."
  }
}
```

**Error Handling Strategy:**
- Authentication errors: Prompt to reconfigure in settings
- JQL syntax errors: Show toast with error message
- Connection timeouts: Retry with exponential backoff
- Malformed issues: Skip and continue (log warning)

### 3.3 Sync Behavior

**Decision Confirmation:** Manual sync button triggers import flow (not webhooks/polling in Phase 2).

**Sync Algorithm:**
1. Fetch issues from GitHub/Jira (limit: first 100, paginate if needed)
2. For each issue:
   - Check if `external_id` exists in tasks table
   - If exists: UPDATE with new title + description (preserve status and local edits if not imported)
   - If not exists: INSERT as new task in Backlog status, mark `is_imported = true`
3. Show toast: "Synced 5 issues from GitHub" or error if failed
4. Refresh board state

**Read-Only Protection:**
- If `is_imported = true`, disable editing in modal or show "Read-only (synced from GitHub)"
- Only allow re-ordering and status transitions (manual or via agent actions)

---

## 4. Database Schema Extensions

### 4.1 Tasks Table Modifications

Current schema (from Phase 1):
```sql
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

**Required Extensions for Phase 2:**

```sql
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT; -- For ORCH-01
ALTER TABLE tasks ADD COLUMN external_id TEXT;         -- For GitHub/Jira issue #
ALTER TABLE tasks ADD COLUMN is_imported BOOLEAN DEFAULT 0; -- For read-only flag
ALTER TABLE tasks ADD COLUMN import_source TEXT;       -- 'github' | 'jira' | null
```

**Rationale:**
- `acceptance_criteria`: Required field in task modal (ORCH-01)
- `external_id`: Detect conflicts on sync (same GitHub issue #123 updates existing task)
- `is_imported`: Enforce read-only protection after import
- `import_source`: Track origin for future sync validation

**Schema Version:** Increment to v2 (currently v1)

### 4.2 Settings Table Extensions

Store import configuration:

```sql
-- In settings table (key-value pairs)
INSERT INTO settings (key, value, updated_at) VALUES
  ('import_provider', 'github', NOW()), -- 'github' | 'jira' | null
  ('github_owner', 'octocat', NOW()),
  ('github_repo', 'Hello-World', NOW()),
  ('github_token', 'ghp_...', NOW()),  -- Encrypted in production
  ('jira_host', 'https://my-domain.atlassian.net', NOW()),
  ('jira_email', 'user@example.com', NOW()),
  ('jira_token', 'JIRA_...', NOW()); -- Encrypted in production
```

**Note:** In Phase 2 MVP, store as plaintext. Production should use platform keyring (Tauri has support).

---

## 5. IPC Handlers Required for Phase 2

### 5.1 Task CRUD Operations

```rust
// Create task with full context
#[tauri::command]
pub fn create_task(
    project_id: i32,
    name: String,
    description: String,
    acceptance_criteria: String,
) -> Result<Task, String>;

// Get tasks by project (filtered by status)
#[tauri::command]
pub fn get_tasks(project_id: i32) -> Result<Vec<Task>, String>;

// Update task (status, description, etc.)
#[tauri::command]
pub fn update_task(
    task_id: i32,
    status: Option<TaskStatus>,
    description: Option<String>,
) -> Result<Task, String>;

// Delete task
#[tauri::command]
pub fn delete_task(task_id: i32) -> Result<(), String>;
```

### 5.2 Import Operations

```rust
// Sync GitHub issues
#[tauri::command]
pub async fn sync_github_issues(
    project_id: i32,
    owner: String,
    repo: String,
    token: String,
) -> Result<SyncResult, String>;

// Sync Jira issues
#[tauri::command]
pub async fn sync_jira_issues(
    project_id: i32,
    host: String,
    email: String,
    api_token: String,
    jql: String,
) -> Result<SyncResult, String>;

// Save import configuration
#[tauri::command]
pub fn save_import_config(
    project_id: i32,
    provider: String, // 'github' | 'jira'
    config: serde_json::Value,
) -> Result<(), String>;
```

### 5.3 Return Types

```rust
#[derive(Serialize, Deserialize, Debug)]
pub struct SyncResult {
    pub imported_count: i32,
    pub updated_count: i32,
    pub error_message: Option<String>,
}
```

---

## 6. TypeScript Bindings Updates

Current bindings (Phase 1) include `Task` type with 5 columns. Update for Phase 2:

```typescript
// New fields for Phase 2
export type Task = {
  id: number;
  project_id: number;
  name: string;
  description: string;
  acceptance_criteria: string; // NEW
  status: TaskStatus;
  external_id: string | null;  // NEW (GitHub issue # or Jira key)
  is_imported: boolean;        // NEW
  import_source: string | null; // NEW ('github' | 'jira')
  created_at: string;
  updated_at: string;
};
```

Regenerate with: `cargo build -p gsd-demo` (ts-rs 7.1 auto-generates)

---

## 7. React Component Architecture

### 7.1 Component Hierarchy

```
App.tsx (already has project selection)
├── KanbanBoard.tsx (main orchestration)
│   ├── KanbanColumn.tsx (repeated 5x)
│   │   └── TaskCard.tsx (repeated per task)
│   │       └── DragSource (React Beautiful DnD)
│   └── TaskModal.tsx (overlaid)
│       ├── TaskForm.tsx (React Hook Form)
│       └── Dialog (Radix Primitives)
├── SyncButton.tsx
│   └── Import config trigger
└── ErrorToast.tsx (error notifications)
```

### 7.2 State Flow

1. **App mounts** → `useEffect` calls `get_tasks(project_id)` via IPC
2. **Zustand store** receives task list, groupBy(status) for column rendering
3. **User drags task** → React Beautiful DnD fires `onDragEnd`
4. **Drop handler** calls `update_task(id, newStatus)` → updates DB → refreshes board state
5. **User clicks "New Task"** → Modal opens (Radix Dialog, React Hook Form)
6. **Submit** → `create_task()` IPC → Zustand adds to store → Backlog column updates
7. **Manual sync** → `sync_github_issues()` IPC → conflict detection → toast with result

### 7.3 Styling Considerations

**From Phase 1 decisions:**
- CSS variables for theming
- Vite build to `src-tauri/gen/web`
- Design system via shadcn/ui or custom CSS variables

**Phase 2 adds:**
- Column containers need fixed-width or flex layout
- Task cards: title + status badge (no description preview per spec)
- Modal backdrop with semi-transparent overlay
- Drag preview styling (semi-transparent card during drag)
- Invalid drop zone visual feedback (dim/reduce opacity)
- Toast notifications positioned bottom-right

---

## 8. Error Handling Strategy

### 8.1 Import Errors

**GitHub:**
- `401 Unauthorized` → "Please configure GitHub token in settings"
- `403 Forbidden` → "GitHub API rate limited, try again later"
- `404 Not Found` → "Repository not found, check owner/repo"
- Network timeout → "Connection failed, check internet"

**Jira:**
- `401 Unauthorized` → "Jira credentials invalid, reconfigure"
- `403 Forbidden` → "Insufficient permissions to view project"
- `404 Not Found` → "Jira project not found"
- JQL syntax error → "Invalid JQL query, check format"

### 8.2 Task Operations

- **Validation failure on drop** → Show error toast, bounce card back (React Beautiful DnD supports `onDragEnd` with skip logic)
- **DB conflict** → "Task was modified, refresh to see changes"
- **Offline/Network** → Queue changes locally, sync when online (defer to Phase 4)

---

## 9. Performance Considerations

### 9.1 Task Loading

**Current approach:** Fetch all tasks on mount
- OK for MVP (assume <1000 tasks per project)
- Future optimization: Pagination or lazy load per column (Phase 5+)

### 9.2 Drag-Drop Performance

- React Beautiful DnD handles 100+ cards efficiently
- Zustand re-renders only affected components (selector optimization)
- Consider virtualizing long columns if >50 tasks (Phase 5+)

### 9.3 Import Performance

- Fetch first 100 issues (GitHub API default per_page=30, paginate if needed)
- Batch insert/update in single transaction (Phase 3: implement batch ops)
- Show progress indicator for large syncs (>50 issues)

---

## 10. Testing Considerations

### 10.1 Unit Tests

- Task CRUD IPC handlers
- Zustand store mutations (add, update, delete, filter by status)
- External ID conflict detection logic
- Form validation with required fields

### 10.2 Integration Tests

- Kanban board drag-drop (React Beautiful DnD has test utils)
- Modal open/close with form submission
- GitHub/Jira sync (mock API responses with `nock` or `msw`)

### 10.3 Manual Testing Checklist

- [ ] Create task in modal, appears in Backlog
- [ ] Drag task to Ready, status persists after refresh
- [ ] Drag invalid task between columns, bounces back with error
- [ ] Click sync, GitHub issues import to Backlog
- [ ] Re-sync updates existing issues by external_id
- [ ] Imported tasks show read-only indicator
- [ ] Error handling: invalid GitHub repo, network timeout
- [ ] Column headers show correct count
- [ ] All 5 columns fit on screen without scroll

---

## 11. Dependency Decision Matrix

| Dependency | Version | Rationale | Backfill Phase 1? |
|------------|---------|-----------|------------------|
| react-beautiful-dnd | ^13.1.1 | Industry standard Kanban DnD | Add to package.json |
| zustand | ^4.3+ | Lightweight state management | Add to package.json |
| react-hook-form | ^7.45+ | Efficient form handling | Add to package.json |
| @radix-ui/react-dialog | ^1.1+ | Accessible modal primitive | Add to package.json |
| @radix-ui/react-primitive | (peer dep) | For Dialog | Add to package.json |
| octokit | ^20.0+ | GitHub REST API client | Add to package.json (backend via Node sidecar for Phase 3+) |
| jira.js | ^10.0+ | Jira REST API client | Add to package.json (backend via Node sidecar for Phase 3+) |

**Note:** octokit and jira.js can run in Node.js sidecar (Phase 3) or browser (Phase 2 MVP). Browser approach simpler for MVP.

---

## 12. Key Decisions Summary

| Decision | Impact | Notes |
|----------|--------|-------|
| React Beautiful DnD | High | Must commit before building components |
| Zustand for board state | High | Alternative: React Context (heavier) |
| Radix Dialog for modal | Medium | Alternative: Headless UI (similar) |
| Read-only for imported tasks | High | Protects sync integrity |
| Manual sync (no webhooks) | Medium | Simpler MVP, upgrade in Phase 3 |
| Update on external_id match | High | Prevents duplicates on re-sync |
| Task CRUD in Rust IPC | High | Consistent with Phase 1 pattern |
| All columns fit viewport | Medium | Forces responsive column design |

---

## 13. Open Questions for Planning Phase

1. **Toast/Alert Library:** Use Radix Toast or lightweight alternative (e.g., React Toastify)?
2. **Acceptance Criteria UI:** Single textarea or multi-line list? (Affects form complexity)
3. **Column reordering:** Should users reorder columns? (Not in spec, defer to future)
4. **Bulk operations:** Delete multiple tasks, bulk import? (Out of scope for Phase 2)
5. **Export:** Should users export tasks as CSV/JSON? (Out of scope for Phase 2)
6. **Search/Filter:** Search tasks by name, filter by status? (Out of scope for Phase 2, defer to Phase 5)
7. **Undo/Redo:** Should task actions be undoable? (Out of scope, defer to Phase 5)

---

## 14. Risk Mitigation

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Drag-drop library incompatibility with Tauri | Medium | Verify React Beautiful DnD works in Tauri (likely yes, many apps use it) |
| GitHub API rate limit during testing | Low | Use test token with higher limits, mock responses in tests |
| External ID collision (GitHub + Jira same project) | Low | Prefix external_id with source: "gh:123" or "jira:GSD-123" |
| Modal state conflicts with Zustand | Low | Keep modal state local (React.useState), sync to Zustand only on submit |
| Database schema migration failure | Medium | Always backup DB before testing migrations, include rollback script |
| Accessibility compliance | Low | Use Radix components (WAI-ARIA compliant), test with keyboard nav and screen reader |

---

## 15. Recommendations for Planning

### Phase 2 Plan Structure (3 sub-plans estimated)

1. **02-01: Kanban Board UI and Drag-Drop** (~40 hours)
   - React component hierarchy
   - Zustand store setup
   - React Beautiful DnD integration
   - Column rendering and task cards
   - Drag-drop handlers and validation

2. **02-02: Manual Task Creation** (~20 hours)
   - Task modal (Radix Dialog)
   - React Hook Form form builder
   - Acceptance criteria textarea
   - IPC create_task handler
   - Form validation and error handling

3. **02-03: GitHub/Jira Import with Sync** (~25 hours)
   - Settings UI for GitHub/Jira config
   - Octokit/Jira.js client setup
   - Sync handlers (IPC)
   - Conflict detection by external_id
   - Read-only enforcement and error toasts
   - Batch import and DB transactions

### Estimated Total: 85 hours (assumes 2-person team with async review)

### Critical Path
1. ✓ Schema migrations (04-01)
2. ✓ Zustand store (02-01)
3. ✓ React Beautiful DnD (02-01)
4. ✓ Task modal (02-02)
5. ✓ IPC CRUD handlers (02-02)
6. ✓ Import logic (02-03)

All can proceed in parallel after Phase 1 completion.

---

## Conclusion

Phase 2 is well-scoped and achievable with production libraries. Key dependencies are proven (React Beautiful DnD, Zustand, Radix UI). Database schema needs minor extensions (4 new columns). IPC layer expands from Phase 1's pattern. Main implementation effort is component integration and import conflict handling.

**Go-/No-go for Planning:** **GO** - All research confirms feasibility and library compatibility.

---

*Research completed: 2026-02-05*
*Next Step: Create detailed plans for 02-01, 02-02, 02-03*
