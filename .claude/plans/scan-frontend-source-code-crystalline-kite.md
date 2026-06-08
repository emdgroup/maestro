# Panels Missing `custom-scrollbar` Class

## Context

The project uses a `custom-scrollbar` class (defined in `src/index.css:188-210`) for consistent scrollbar styling. Several scrollable panels are missing this class, resulting in default browser scrollbars appearing.

## Findings

### Panels that should get `custom-scrollbar`

| File | Line | Element |
|------|------|---------|
| `src/views/kanban/task-detail/TaskDetailScreen.tsx` | 591 | Main content area (`overflow-y-auto p-6`) |
| `src/views/kanban/task-detail/TaskDetailScreen.tsx` | 713 | Sidebar panel (`overflow-y-auto p-4`) |
| `src/components/execution/diff/ReviewConfirmModals.tsx` | 66 | Comment list (`max-h-40 overflow-y-auto`) |
| `src/components/execution/diff/ScopeSelector.tsx` | 105 | Dropdown list (`max-h-48 overflow-y-auto`) |
| `src/components/execution/activity/ActivityPlanPanel.tsx` | 67 | Plan content (`max-h-70 overflow-y-auto`) |
| `src/components/execution/diff/UntrackedFileDiffViewer.tsx` | 36 | Diff viewer (`flex-1 min-h-0 overflow-auto`) |
| `src/components/execution/activity/ActivityToolCallGroup.tsx` | 281 | Code block (`max-h-40 overflow-y-auto`) |
| `src/components/execution/activity/ActivityToolCallGroup.tsx` | 371 | Code block (`max-h-52 overflow-y-auto`) |
| `src/components/execution/worktree-card/WorktreeCardGrid.tsx` | 39 | Grid view (`flex-1 overflow-y-auto p-4`) |
| `src/components/execution/worktree-card/WorktreeCardGrid.tsx` | 64 | List view (`flex-1 overflow-y-auto p-4`) |
| `src/components/kanban/kanban-column/KanbanColumn.tsx` | 78 | Column card list (`flex-1 overflow-y-auto p-3`) |
| `src/components/kanban/create-task-modal/CreateTaskModal.tsx` | 401 | Textarea (`max-h-[40vh] overflow-y-auto`) |

### Intentionally excluded (no change needed)

- **UI primitives** (`dropdown-menu.tsx`, `context-menu.tsx`) — transient popups, custom scrollbar would look odd
- **Horizontal-only** (`MarkdownBlock.tsx`, `table.tsx`) — `overflow-x-auto` rarely shows persistent scrollbar
- **`no-scrollbar` users** (`sidebar.tsx`, `command.tsx`) — intentionally hidden

## Fix

Add `custom-scrollbar` class to each element listed above alongside existing overflow class.

## Verification

- Run `pnpm dev` and visually check each panel for styled thin scrollbar
- Specifically verify: TaskDetailScreen main + sidebar, KanbanColumn, WorktreeCardGrid, ActivityToolCallGroup code blocks
