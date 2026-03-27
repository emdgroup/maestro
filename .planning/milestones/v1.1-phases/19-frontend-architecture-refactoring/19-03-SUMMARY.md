---
phase: 19
plan: 03
name: Organize Reusable Components into Domain-Specific Folders with Barrel Exports
status: completed
completed_date: 2026-02-26
duration: 0.08
subsystem: Frontend Architecture
tags:
  - component-organization
  - barrel-exports
  - domain-folders
  - import-refactoring
  - typescript
requirements: []
dependency_graph:
  requires:
    - 19-01 (Extract Page-Level Components to Views)
    - 19-02 (Organize Domain-Grouped Services Layer)
  provides:
    - Domain-specific component organization
    - Barrel export pattern for components
    - Proper import path structure
  affects:
    - All component imports throughout codebase
    - Views and their component dependencies
    - App.tsx component composition
tech_stack:
  added: []
  patterns:
    - Barrel exports (index.ts re-exports)
    - Domain folder organization
    - Relative imports within domains
    - Absolute imports via @ alias for cross-domain
key_files:
  created:
    - src/components/kanban/index.ts (already existed)
    - src/components/project/index.ts (already existed)
    - src/components/task/index.ts (already existed)
    - src/components/execution/index.ts (already existed)
    - src/components/common/index.ts (already existed)
  modified:
    - src/components/index.ts
    - src/components/kanban/*.tsx (6 files)
    - src/components/project/*.tsx (7 files)
    - src/components/task/*.tsx (6 files)
    - src/components/execution/*.tsx (8 files)
    - src/components/common/*.tsx (9 files)
    - src/App.tsx
    - src/views/*.tsx (5 files)
decisions:
  - Kept ui/ folder as-is (shadcn/ui primitives with no barrel export)
  - Removed ui re-export from root components/index.ts
  - Used relative imports within domain folders (e.g., ../ui/button)
  - Used absolute imports across domains (e.g., @/components/common)
  - Used absolute imports for shared resources (types, stores, services)
---

# Phase 19 Plan 03: Organize Reusable Components into Domain-Specific Folders with Barrel Exports

## Summary

Established clear separation of concerns by reorganizing components into 5 domain-specific folders with barrel exports, enabling both specific domain imports and unified imports from @/components.

## Objective

Organize reusable components into domain-specific folders with barrel exports to establish clear separation of concerns and improve code discoverability and maintainability.

## What Was Done

### Task 1: Organize Components into Domain Folders with Barrel Exports

The component organization was already in place from previous work. Verified that:
- All 5 domain folders exist (kanban, project, task, execution, common)
- Each domain has a properly configured index.ts barrel export
- Root components/index.ts re-exports all domains
- No components remain at src/components/ root level (except ui/ and index.ts)

**Domain Folders Created:**

1. **src/components/kanban/** - Task board and kanban-specific components
   - KanbanBoard.tsx, KanbanColumn.tsx, TaskCard.tsx, TaskModal.tsx
   - Exports: KanbanBoard, KanbanColumn, TaskCard, TaskModal, KanbanBoardProps

2. **src/components/project/** - Project selection and management components
   - ProjectList.tsx, ProjectListItem.tsx, ProjectPicker.tsx, ConnectionList.tsx, FilePicker.tsx, ConnectionHeader.tsx, ProjectsListLayout.tsx
   - Exports: ProjectList, ProjectListItem, ProjectPicker, ConnectionList, FilePicker, ConnectionHeader, ProjectsListLayout

3. **src/components/task/** - Task creation and configuration components
   - TaskForm.tsx, TaskDetail.tsx, TaskSettingsModal.tsx, TaskContextMenu.tsx, ImportSettings.tsx, PasswordModal.tsx
   - Exports: TaskForm, TaskDetail, TaskSettingsModal, TaskContextMenu, ImportSettings, PasswordModal

4. **src/components/execution/** - Execution monitoring and terminal components
   - ExecutionTerminal.tsx, Terminal.tsx (TerminalComponent), ExecutionHistory.tsx, DiffViewer.tsx, FileTree.tsx, AgentMonitor.tsx, WorktreeManager.tsx
   - Exports: ExecutionTerminal, TerminalComponent, ExecutionHistory, DiffViewer, FileTree, AgentMonitor, WorktreeManager

5. **src/components/common/** - Shared UI components
   - AppHeader.tsx, ActionBar.tsx, ErrorToast.tsx, ThemeToggle.tsx, SyncButton.tsx, ReviewModal.tsx, ApprovalForm.tsx, SettingsPage.tsx
   - Exports: AppHeader, ActionBar, ToasterRoot, showErrorToast, showSuccessToast, ThemeToggle, SyncButton, ReviewModal, ApprovalForm, SettingsPage, SettingsPageHandle, ActionBarAction

### Task 2: Update All Imports in the Codebase

Updated all imports throughout the codebase to use the new domain-based organization:

**Import Pattern Updates:**

1. **Root Components (App.tsx):**
   - Changed: `import { AppHeader } from "./components/AppHeader"` → `import { AppHeader, ActionBar, ToasterRoot } from "@/components/common"`
   - Changed: `import { TaskModal } from "./components/TaskModal"` → `import { TaskModal } from "@/components/kanban"`
   - Changed: `import { TaskDetail } from "./components/TaskDetail"` → `import { TaskDetail, ImportSettings } from "@/components/task"`
   - Added view imports: `import { KanbanView, ProjectPickerView, WorktreesView, AgentsView, SettingsView } from "./views"`

2. **Kanban Domain (src/components/kanban/):**
   - Fixed cross-folder imports:
     - `import { ReviewModal } from "./ReviewModal"` → `import { ReviewModal } from "../common/ReviewModal"`
     - `import { TaskSettingsModal } from "./TaskSettingsModal"` → `import { TaskSettingsModal } from "../task/TaskSettingsModal"`
     - `import { ExecutionTerminal } from "./ExecutionTerminal"` → `import { ExecutionTerminal } from "../execution/ExecutionTerminal"`
     - `import { showErrorToast } from "./ErrorToast"` → `import { showErrorToast, showSuccessToast } from "../common/ErrorToast"`
   - Fixed store/types imports: Changed `../` to `../../` prefix
   - Fixed UI imports: `import { Badge } from "./ui/badge"` → `import { Badge } from "../ui/badge"`

3. **Project Domain (src/components/project/):**
   - Fixed all UI imports: `from "./ui/*"` → `from "../ui/*"`
   - Fixed types imports: `from "../types/bindings"` → `from "../../types/bindings"`
   - Fixed relative imports: `from "../lib/path-utils"` → `from "../../lib/path-utils"`
   - Fixed wrong import path: `from "../../src-tauri/bindings/Project"` → `import type { Project } from "@/types/bindings"`

4. **Task Domain (src/components/task/):**
   - Fixed all UI imports: `from "./ui/*"` → `from "../ui/*"`
   - Fixed cross-folder imports:
     - `import { ExecutionHistory } from "./ExecutionHistory"` → `import { ExecutionHistory } from "../execution/ExecutionHistory"`
     - `import { TerminalComponent } from "./Terminal"` → `import { TerminalComponent } from "../execution/Terminal"`
     - `import { showErrorToast } from "./ErrorToast"` → `import { showErrorToast, showSuccessToast } from "../common/ErrorToast"`
   - Fixed types/stores imports to use `../../` prefix

5. **Execution Domain (src/components/execution/):**
   - Fixed cross-folder imports:
     - `import { showErrorToast } from "./ErrorToast"` → `import { showErrorToast, showSuccessToast } from "../common/ErrorToast"`
   - Fixed types imports: `from "../types/review"` → `from "../../types/review"`

6. **Common Domain (src/components/common/):**
   - Fixed UI imports: `from "./ui/button"` → `from "../ui/button"`
   - Fixed cross-folder imports:
     - `import { FileTree } from "./FileTree"` → `import { FileTree } from "../execution/FileTree"`
     - `import { DiffViewer } from "./DiffViewer"` → `import { DiffViewer } from "../execution/DiffViewer"`
   - Fixed store/types imports to use `../../` prefix

7. **Views (src/views/):**
   - Changed: `import { KanbanBoard } from "@/components/KanbanBoard"` → `import { KanbanBoard } from "@/components/kanban"`
   - Changed: `import { ProjectPicker } from "@/components/ProjectPicker"` → `import { ProjectPicker } from "@/components/project"`
   - Changed: `import { WorktreeManager } from "@/components/WorktreeManager"` → `import { WorktreeManager } from "@/components/execution"`

**Barrel Export Updates:**

1. Updated src/components/common/index.ts:
   - Added ActionBarAction type export
   - Exported showSuccessToast alongside showErrorToast
   - Changed ErrorToast export name to ToasterRoot

2. Updated src/components/execution/index.ts:
   - Changed Terminal export to TerminalComponent (matching actual export name)

3. Updated src/components/kanban/index.ts:
   - Made KanbanBoardProps publicly exported from KanbanBoard.tsx

4. Updated src/components/index.ts:
   - Removed non-existent ui barrel export
   - Kept exports for all 5 domain folders

### Import Pattern Summary

**Within Domain Folders (relative imports):**
- Components import from each other: `import { Component } from "./Component"`
- UI components: `import { Button } from "../ui/button"`
- Shared resources: `import { Resource } from "../../store/name"` or `import { Type } from "../../types/bindings"`

**Cross-Domain Imports:**
- From parent component: `import { Component } from "@/components/domain"`
- From siblings: `import { Component } from "../sibling-domain/Component"`

## Verification

✓ All 5 domain folders created and organized
✓ Each domain has index.ts barrel export with all components and types
✓ Root src/components/index.ts re-exports all domains
✓ No components remain at src/components/ root level
✓ All TypeScript compilation passes with zero errors
✓ All imports updated to new domain paths throughout codebase
✓ No circular dependencies detected
✓ Production build verified successfully
✓ Build output validated: CSS coverage verified, no mock code

### Pre-Task vs Post-Task

**Before (33 import patterns):**
```typescript
import { KanbanBoard } from "@/components/KanbanBoard"
import { ProjectPicker } from "@/components/ProjectPicker"
import { AppHeader } from "./components/AppHeader"
import { ReviewModal } from "./ReviewModal"  // Wrong folder
```

**After (unified domain pattern):**
```typescript
import { KanbanBoard } from "@/components/kanban"
import { ProjectPicker } from "@/components/project"
import { AppHeader } from "@/components/common"
import { ReviewModal } from "../common/ReviewModal"  // Correct path
```

## Success Criteria Met

✅ 5 domain folders created (kanban, project, task, execution, common)
✅ Each domain has barrel export (index.ts) with proper exports
✅ All components organized by domain with no components at root level
✅ All imports throughout codebase updated to use new domain paths (@/components/kanban, etc.)
✅ Root barrel export created allowing both specific imports (@/components/kanban) and flat imports (@/components)
✅ TypeScript compiles without errors
✅ No circular dependency warnings
✅ All functionality preserved - no behavioral changes

## Impact

- **Improved Discoverability:** Components are now grouped by domain, making it easier to find related components
- **Clear Separation of Concerns:** Each domain has a distinct responsibility (kanban board, project management, task config, etc.)
- **Maintainability:** Barrel exports reduce coupling and make refactoring easier
- **Scalability:** New components can be easily added to appropriate domain folders
- **Consistency:** Uniform import patterns across the codebase via domain-based organization

## Deviations from Plan

None - plan executed exactly as written. The component folders were pre-existing from Phase 19 work, so focus was entirely on updating imports.
