# Phase 4: Frontend Component Restructuring

Split into 6 sub-phases. Each independently verifiable with `pnpm build`.

---

## Sub-phase 4A: Views restructuring (flat → folder-per-view)

Move top-level views into domain folders and absorb view-specific components.

```
src/views/KanbanView.tsx        → src/views/kanban/KanbanView.tsx
src/views/AgentsView.tsx        → src/views/agents/AgentsView.tsx
src/views/WorktreesView.tsx     → src/views/worktrees/WorktreesView.tsx
src/views/SettingsView.tsx      → src/views/settings/SettingsView.tsx
src/views/ProjectPickerView.tsx → src/views/project-picker/ProjectPickerView.tsx
```

Absorb view-specific components:
```
src/components/views/BoardView.tsx       → src/views/kanban/board-view/BoardView.tsx
src/components/task/TaskDetailScreen.tsx  → src/views/kanban/task-detail/TaskDetailScreen.tsx
src/components/task/TaskForm.tsx          → src/views/kanban/task-detail/TaskForm.tsx
src/components/task/TaskContextMenu.tsx   → src/views/kanban/task-detail/TaskContextMenu.tsx
src/components/common/SettingsPage.tsx    → src/views/settings/settings-page/SettingsPage.tsx
src/components/common/settings/*         → src/views/settings/issue-tracking-forms/*
```

Move entire project-picker domain into view (all only used by ProjectPickerView):
```
src/components/project-picker/*  → src/views/project-picker/*  (folder-per-component inside)
```

Delete: `src/components/views/`, `src/components/task/`

Update: `App.tsx` lazy imports, `KanbanView` imports

**Files touched:** ~25 moves, ~15 import updates

---

## Sub-phase 4B: common/ cleanup (move domain-specific out, folder-per-component for what remains)

Move out of common:
```
ReviewModal.tsx + ApprovalForm.tsx → src/views/kanban/review-modal/ReviewModal.tsx + ApprovalForm.tsx
AppHeader.tsx                      → src/components/layout/app-header/AppHeader.tsx
```

Folder-per-component for remaining common:
```
common/AccentColorPicker.tsx             → common/accent-color-picker/AccentColorPicker.tsx
common/BrandIcon.tsx                     → common/brand-icon/BrandIcon.tsx
common/DisconnectBackdrop.tsx + test     → common/disconnect-backdrop/DisconnectBackdrop.tsx + .test.tsx
common/ErrorToast.tsx                    → common/error-toast/ErrorToast.tsx
common/ShortcutHint*.tsx (3 files)       → common/shortcut-hint/ShortcutHint.tsx + Provider + Tooltip
common/ThemeToggle.tsx                   → common/theme-toggle/ThemeToggle.tsx
```

Delete: `common/__tests__/`

**Files touched:** ~15 moves, ~18 import updates (many files import from common)

---

## Sub-phase 4C: kanban/ folder-per-component

```
kanban/KanbanColumn.tsx     → kanban/kanban-column/KanbanColumn.tsx
kanban/TaskCard.tsx         → kanban/task-card/TaskCard.tsx
kanban/CreateTaskModal.tsx  → kanban/create-task-modal/CreateTaskModal.tsx
kanban/ArchiveModal.tsx     → kanban/archive-modal/ArchiveModal.tsx
kanban/__tests__/ArchiveModal.test.tsx → kanban/archive-modal/ArchiveModal.test.tsx
```

Delete: `kanban/__tests__/`

**Files touched:** ~6 moves, ~5 import updates

---

## Sub-phase 4D: execution/ top-level folder-per-component

Group execution flat files into domain folders:
```
execution/AgentMonitor.tsx            → execution/agent-monitor/AgentMonitor.tsx
execution/__tests__/AgentMonitor.test.tsx → execution/agent-monitor/AgentMonitor.test.tsx
execution/__tests__/AgentSelectorDialog.test.tsx → execution/spawn-session-dialog/AgentSelectorDialog.test.tsx
execution/AgentActivityPanel.tsx      → execution/agent-activity-panel/AgentActivityPanel.tsx
execution/Terminal.tsx + ExecutionTerminal.tsx → execution/terminal/Terminal.tsx + ExecutionTerminal.tsx
execution/SessionHistoryPanel.tsx + ExecutionHistory.tsx → execution/session-history/SessionHistoryPanel.tsx + ExecutionHistory.tsx
execution/WorktreeCard.tsx + Grid + Group + useStagingState.ts → execution/worktree-card/*
execution/CreateWorktreeDialog.tsx + DeleteWorktreeDialog.tsx → execution/worktree-dialog/*
execution/Diff*.tsx + FileTree.tsx + UntrackedFile*.tsx + WorktreeDiffPanel.tsx → execution/diff/*
execution/SpawnSessionDialog.tsx → execution/spawn-session-dialog/SpawnSessionDialog.tsx
```

`execution/activity/` stays as-is (already grouped, sub-components nested).

Delete: `execution/__tests__/`

**Files touched:** ~20 moves, ~15 import updates

---

## Sub-phase 4E: project-picker/ folder-per-component (inside views/)

After 4A moved project-picker into `views/project-picker/`, apply folder-per-component:
```
project-picker/ProjectPicker.tsx              → keep at root (main orchestrator)
project-picker/ProjectList.tsx + Item + Layout → project-picker/project-list/*
project-picker/CloneProjectDialog.tsx          → project-picker/clone-project-dialog/
project-picker/CreateProjectDialog.tsx         → project-picker/create-project-dialog/
project-picker/FilePicker.tsx                  → project-picker/file-picker/
project-picker/ConnectionList.tsx + Header     → project-picker/connection-list/
project-picker/IntegrationsTab.tsx + dialogs   → project-picker/integrations/
project-picker/SshAuthModal.tsx                → project-picker/ssh-auth-modal/
project-picker/PreflightModal.tsx              → project-picker/preflight-modal/
project-picker/ProviderRepoPicker.tsx          → project-picker/provider-repo-picker/
project-picker/GitInitDialog.tsx               → project-picker/git-init-dialog/
```

Co-locate tests:
```
__tests__/CloneProjectDialog.test.tsx  → clone-project-dialog/
__tests__/CreateProjectDialog.test.tsx → create-project-dialog/
__tests__/ProjectList.test.tsx         → project-list/
__tests__/ProjectPicker.test.tsx       → keep at root
__tests__/ProjectsListLayout.test.tsx  → project-list/
```

Delete: `__tests__/`

**Files touched:** ~20 moves, ~10 import updates (mostly internal cross-refs)

---

## Sub-phase 4F: Hook co-location + cleanup

Move view-specific hooks out of `utils/hooks/`:
```
useFilePickerInitialization.ts    → views/project-picker/ (only used there)
usePathNavigation.ts + test       → views/project-picker/ (only used there)
useProjectPickerNavigation.ts     → views/project-picker/ (only used there)
useSshConnectionManager.ts        → views/project-picker/ (only used there)
useExecuteTask.ts                 → views/kanban/ or components/execution/ (check usage)
useCtrlHoldHint.ts                → components/common/shortcut-hint/ (only used there)
```

Keep in `utils/hooks/` (truly generic):
```
useConnectionHealth.ts + test
useKeyboardNavigation.ts
useMobile.ts
useShortcuts.ts
```

**Files touched:** ~7 moves, ~7 import updates

---

## Execution Order

4A → 4B → 4C → 4D → 4E → 4F

Each sub-phase: `git mv` files → fix imports → `pnpm build` → commit.

Total: ~95 file moves, ~70 import updates across all sub-phases.
