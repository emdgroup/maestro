# Plan: Homogenize Project Conventions

## Context

Multiple naming, structural, and convention inconsistencies across the codebase. This plan establishes target conventions and lists all changes needed to reach them.

## Conventions (Decided)

### IPC Command Verbs
| Verb | Usage |
|------|-------|
| `get_` | Single item retrieval |
| `list_` | Collection retrieval |
| `create_` | New top-level entity |
| `add_` | Sub-entity (relationships, attachments, instructions) |
| `delete_` | All destruction (drop `remove_`) |
| `save_` | Upsert only (settings) — not for creation |

### File Naming
- **Directories:** kebab-case (`kanban-column/`, `agent-monitor/`)
- **Filenames:** camelCase (`TaskCard.tsx`, `useShortcuts.ts`, `agentMeta.ts`)
- **Services:** `kebab-case.service.ts` (already correct)
- **Stores:** keep `camelCaseStore.ts`

### Component Structure (folder-per-component with domain grouping)
```
src/
├── components/          ← Reusable across views
│   └── <domain>/        ← Domain grouping layer (kebab-case)
│       └── <component>/ ← Component folder (kebab-case)
│           ├── ComponentName.tsx
│           ├── ComponentName.test.tsx
│           └── <sub-component>/  ← Only-used-by-parent nests inside
├── views/               ← Pages/routes
│   └── <view>/          ← View folder (kebab-case)
│       ├── ViewName.tsx
│       ├── ViewName.test.tsx
│       └── <view-specific-component>/  ← Tied to this view only
└── ...
```

**Rules:**
- View-agnostic component → `components/<domain>/<component>/`
- View-specific component (inherently tied to one view) → `views/<view>/<component>/`
- Sub-component (only used by one parent component) → nested inside parent folder
- Domain grouping layer when related components share a domain

### Test Placement
- Co-located: `ComponentName.test.tsx` next to `ComponentName.tsx` in same folder
- Delete all `__tests__/` subdirectories, move tests to co-locate

### Hook Placement
- Co-locate hooks with the component that uses them
- `utils/hooks/` only for truly generic/shared hooks (used by 3+ unrelated components)

### Integration/Issue-Tracking Terminology
- `integration` = generic provider connection capability (credentials, auth, resource discovery)
- `issue_tracking` = specific integration type for issue-tracking providers
- Rename `provider_lookup_handlers.rs` → `integration_lookup_handlers.rs`
- Rename `provider-lookup.service.ts` → `integration-lookup.service.ts`
- `integration_handlers.rs` stays (credential management)
- `issue_tracking_handlers.rs` stays (per-project issue config + fetch)
- Split issue-tracking config out of `integration.service.ts` → new `issue-tracking.service.ts`

### Backend Models
- Group related model files into subfolder when >1 file per domain
- `project.rs` + `project_config.rs` + `project_state.rs` → `models/project/` with `mod.rs`

### Backend Handlers
- Split WSL commands out of `filesystem_handlers.rs` → new `wsl_handlers.rs`

---

## Changes Required

### 1. IPC Verb Renames (Rust + auto-generated bindings)

Commands to rename:
- `get_ssh_connections` → `list_ssh_connections`
- `get_wsl_connections` → `list_wsl_connections`
- `get_task_relationships` → `list_task_relationships`
- `get_task_instructions` → `list_task_instructions`
- `get_task_attachments` → `list_task_attachments`
- `fetch_remote_issues` → `list_remote_issues`
- `remove_project` → `delete_project`
- `remove_task_relationship` → `delete_task_relationship`
- `remove_task_attachment` → `delete_task_attachment`
- `save_ssh_connection` → `create_ssh_connection`
- `save_integration` → `create_integration`
- `save_wsl_connection` → `create_wsl_connection`
- `save_clipboard_image` → keep (this is a "save" action, not entity creation)

After rename: `pnpm tauri:gen` to regenerate `bindings.ts`, then update frontend service calls.

### 2. File Renames (Frontend)

**Hooks:**
- `src/utils/hooks/use-mobile.ts` → `src/utils/hooks/useMobile.ts`

**Utility files in execution/activity/:**
- `file-type-utils.ts` → `fileTypeUtils.ts`
- (others already camelCase: `agentMeta.ts`, `utils.ts`, `types.ts`)

**Non-component PascalCase .ts files:**
- `MentionEntry.ts` → `mentionEntry.ts`
- `ExternalAttachment.ts` → `externalAttachment.ts`

### 3. Component Restructuring

This is the largest change. Target structure by domain:

**`components/kanban/`** — Reusable kanban components:
```
components/kanban/
  kanban-column/
    KanbanColumn.tsx
    KanbanColumn.test.tsx (move from __tests__/)
  task-card/
    TaskCard.tsx
  create-task-modal/
    CreateTaskModal.tsx
  archive-modal/
    ArchiveModal.tsx
    ArchiveModal.test.tsx (move from __tests__/)
```

**`components/execution/`** — split into sub-domains:
```
components/execution/
  agent-monitor/
    AgentMonitor.tsx
    AgentMonitor.test.tsx
  agent-activity-panel/
    AgentActivityPanel.tsx
  terminal/
    Terminal.tsx
    ExecutionTerminal.tsx
  session-history/
    SessionHistoryPanel.tsx
    ExecutionHistory.tsx
  worktree-card/
    WorktreeCard.tsx
    WorktreeCardGrid.tsx
    WorktreeCardGroup.tsx
    useStagingState.ts        ← co-located hook
  worktree-dialog/
    CreateWorktreeDialog.tsx
    DeleteWorktreeDialog.tsx
  diff/
    DiffActionBar.tsx
    DiffFilePanel.tsx
    DiffViewer.tsx
    UntrackedFileDiffViewer.tsx
    WorktreeDiffPanel.tsx
    FileTree.tsx
  spawn-session-dialog/
    SpawnSessionDialog.tsx
    AgentSelectorDialog.tsx   (+ test co-located)
  activity/
    ... (keep current structure, fix file naming)
    config-selectors/
      ... (keep — sub-component of activity)
```

**`components/common/`** — only truly reusable:
```
components/common/
  brand-icon/
    BrandIcon.tsx
  error-toast/
    ErrorToast.tsx
  disconnect-backdrop/
    DisconnectBackdrop.tsx
    DisconnectBackdrop.test.tsx
  shortcut-hint/
    ShortcutHint.tsx
    ShortcutHintProvider.tsx
    ShortcutHintTooltip.tsx
  theme-toggle/
    ThemeToggle.tsx
  accent-color-picker/
    AccentColorPicker.tsx
```

**Move domain-specific out of `common/`:**
- `ReviewModal.tsx` → `components/execution/review-modal/` (or into a view if view-specific)
- `ApprovalForm.tsx` → determine which view uses it, move there
- `SettingsPage.tsx` → `views/settings/settings-page/`
- `AppHeader.tsx` → `components/layout/app-header/`
- `common/settings/` (issue-tracking forms) → `views/settings/issue-tracking-forms/` (view-specific, only used in settings)

**`components/views/BoardView.tsx`** → move to `views/kanban/board-view/BoardView.tsx` (it's kanban-view-specific)

**`views/`** — restructure into view folders:
```
views/
  kanban/
    KanbanView.tsx
    board-view/
      BoardView.tsx
    task-detail-screen/
      TaskDetailScreen.tsx
      TaskForm.tsx
      TaskContextMenu.tsx
  agents/
    AgentsView.tsx
  worktrees/
    WorktreesView.tsx
  settings/
    SettingsView.tsx
    SettingsPage.tsx
  project-picker/
    ProjectPickerView.tsx
    project-list/
      ProjectList.tsx
      ProjectListItem.tsx
      ProjectsListLayout.tsx
    clone-project-dialog/
      CloneProjectDialog.tsx
    create-project-dialog/
      CreateProjectDialog.tsx
    ... (other project-picker-specific components)
```

### 4. Backend Restructuring

**Split `filesystem_handlers.rs`:**
- WSL commands → new `wsl_handlers.rs`
- Keep local filesystem + drives + accent color in `filesystem_handlers.rs`

**Rename handler:**
- `provider_lookup_handlers.rs` → `integration_lookup_handlers.rs`

**Group models:**
```
models/
  project/
    mod.rs
    config.rs    (was project_config.rs)
    state.rs     (was project_state.rs)
  connection.rs
  diff.rs
  integration.rs
  issue_tracking.rs
  review.rs
  settings.rs
  task.rs
  worktree.rs
```

### 5. Frontend Service Renames
- `provider-lookup.service.ts` → `integration-lookup.service.ts`
- Split issue-tracking config from `integration.service.ts` → new `issue-tracking.service.ts`

---

## Verification

1. `cargo check` — Rust compiles after handler/model renames
2. `pnpm tauri:gen` — Regenerate bindings after command renames
3. `pnpm build` — Frontend compiles with new paths/imports
4. `pnpm test` — All tests pass
5. `pnpm lint` — No broken imports
6. `pnpm tauri:dev` — App starts and basic flows work (create project, view tasks, open terminal)

---

## Execution Notes

- This is a large refactor. Recommend phased PRs:
  1. IPC verb renames (mechanical, self-contained)
  2. File naming fixes (small, mechanical)
  3. Backend restructuring (models + handlers)
  4. Frontend component restructuring (largest, most files)
- Each phase verifiable independently
- Component restructuring may need import alias updates in `vite.config.ts`
