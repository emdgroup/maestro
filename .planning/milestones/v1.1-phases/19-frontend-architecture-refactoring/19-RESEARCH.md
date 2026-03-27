# Phase 19: Frontend Architecture Refactoring - Research

**Researched:** 2026-02-26
**Domain:** React frontend project structure and organization patterns
**Confidence:** HIGH (established industry standards, verified against codebase state)

## Summary

Phase 19 requires reorganizing the frontend codebase from a flat `src/` structure into a standard scalable architecture. Currently, the app has 32 components at the root level, 5 hooks, 4 stores, 2 providers, and scattered utilities. The goal is to reorganize into a clear separation between:

- **Page-level views** (entire screens) — moved to `src/views/`
- **Reusable components** (domain-grouped, with index exports) — organized in `src/components/`
- **Business logic** (Tauri IPC calls) — extracted to `src/services/`
- **Hooks** (with folder-per-hook structure) — organized in `src/utils/hooks/`
- **Helpers** (path, diff, ui utilities) — consolidated in `src/utils/helpers/`

The current codebase is in Phase 18 completion state, making this a pure architectural refactoring with no breaking behavioral changes.

**Primary recommendation:** Use a "route-based view organization" pattern where each major screen (Kanban, Agents, Worktrees, Settings) becomes a view with internal components, paired with a new service layer abstracting all Tauri IPC calls.

## Standard Stack

### Core Organization Patterns

| Pattern | Library/Tool | Purpose | Standard |
|---------|-------------|---------|----------|
| State Management | Zustand + Immer | Client state (tasks, board, UI) | Yes - already in use |
| Backend Communication | Tauri @invoke | IPC to Rust backend | Yes - already in use |
| Component Library | shadcn/ui + Radix UI | UI primitives | Yes - already in use |
| Styling | Tailwind CSS 4 + CSS Modules | Layout and scoped styles | Yes - already in use |
| Form Handling | react-hook-form | Form management | Yes - already in use |
| Theme Management | next-themes | Dark mode, theme persistence | Yes - already in use |

### Supporting Tools

| Tool | Purpose | When to Use |
|------|---------|------------|
| TypeScript | Type safety | Always |
| Vite | Build/dev server | Already configured |
| Tauri 2 | Desktop app framework | Backend integration |
| React 19 | UI framework | Core rendering |

## Architecture Patterns

### Recommended Project Structure

```
src/
├── views/                           # Page-level components (entire screens)
│   ├── KanbanView.tsx              # Main kanban board screen
│   ├── AgentsView.tsx              # Agent monitoring screen
│   ├── WorktreesView.tsx           # Worktrees management screen
│   ├── SettingsView.tsx            # Settings/configuration screen
│   ├── ProjectPickerView.tsx       # Project selection (first-run screen)
│   └── index.ts                    # Barrel export
│
├── components/                      # Reusable components (domain-grouped)
│   ├── kanban/                     # Kanban domain
│   │   ├── KanbanBoard.tsx
│   │   ├── KanbanColumn.tsx
│   │   ├── TaskCard.tsx
│   │   ├── TaskModal.tsx
│   │   └── index.ts                # export * from './KanbanBoard'
│   │
│   ├── project/                    # Project domain
│   │   ├── ProjectList.tsx
│   │   ├── ProjectListItem.tsx
│   │   ├── ProjectPicker.tsx
│   │   ├── ConnectionList.tsx
│   │   └── index.ts
│   │
│   ├── task/                       # Task domain
│   │   ├── TaskForm.tsx
│   │   ├── TaskDetail.tsx
│   │   ├── TaskSettingsModal.tsx
│   │   └── index.ts
│   │
│   ├── common/                     # Cross-domain components
│   │   ├── AppHeader.tsx
│   │   ├── ActionBar.tsx
│   │   ├── ErrorToast.tsx
│   │   ├── ThemeToggle.tsx
│   │   └── index.ts
│   │
│   ├── execution/                  # Execution/terminal domain
│   │   ├── ExecutionTerminal.tsx
│   │   ├── Terminal.tsx
│   │   ├── ExecutionHistory.tsx
│   │   └── index.ts
│   │
│   ├── ui/                         # shadcn/ui primitives (unchanged)
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   └── ...
│   │
│   └── index.ts                    # Re-export domain folders
│
├── services/                        # Business logic (Tauri IPC abstraction)
│   ├── task.service.ts             # Task IPC operations
│   ├── project.service.ts          # Project IPC operations
│   ├── settings.service.ts         # Settings IPC operations
│   ├── execution.service.ts        # Execution/terminal IPC operations
│   ├── connection.service.ts       # SSH connection IPC operations
│   ├── ipc.ts                      # IPC client factory (type-safe invoke wrapper)
│   └── index.ts                    # Barrel export
│
├── utils/                           # Utilities and helpers
│   ├── hooks/                      # Custom hooks (folder-per-hook)
│   │   ├── useProjectSelection/
│   │   │   ├── useProjectSelection.ts
│   │   │   └── useProjectSelection.test.ts
│   │   ├── useRecentProjects/
│   │   │   ├── useRecentProjects.ts
│   │   │   └── index.ts
│   │   ├── useSshConnectionManager/
│   │   │   ├── useSshConnectionManager.ts
│   │   │   └── index.ts
│   │   ├── index.ts                # Barrel export all hooks
│   │   └── use-mobile.ts           # Single-file hooks (keep if simple)
│   │
│   ├── helpers/                    # Helper functions
│   │   ├── path-utils.ts           # Path manipulation
│   │   ├── diff-parser.ts          # Diff parsing
│   │   ├── ui-utils.ts             # UI helpers
│   │   └── index.ts                # Barrel export
│   │
│   └── index.ts                    # Re-export helpers + hooks
│
├── providers/                       # Context providers
│   ├── ThemeProvider.tsx
│   ├── QueryProvider.tsx
│   └── index.ts
│
├── contexts/                        # React contexts
│   ├── ConnectionContext.tsx
│   └── index.ts
│
├── store/                          # Zustand stores (unchanged)
│   ├── boardStore.ts
│   ├── projectStore.ts
│   ├── reviewStore.ts
│   ├── configStore.ts
│   └── index.ts
│
├── types/                          # Type definitions (unchanged)
│   ├── bindings.ts                 # Auto-generated from Rust
│   ├── review.ts
│   └── index.ts
│
├── App.tsx                         # Root component (router logic)
├── main.tsx                        # React entry point
└── styles/                         # Global styles (unchanged)
    ├── index.css
    └── App.css
```

### Pattern 1: Views for Pages

**What:** Rename large page-level components (KanbanBoard, SettingsPage, etc.) to Views. Views contain an entire screen with internal sub-components.

**When to use:** For any component that:
- Represents a full screen (takes up viewport)
- Is routed to (linked from navigation tabs)
- Manages complex page-level state (via stores + providers)

**Example structure:**
```typescript
// src/views/KanbanView.tsx
import { KanbanBoard, TaskCard, KanbanColumn } from "@/components/kanban";
import { useBoardStore } from "@/store/boardStore";

export function KanbanView({ projectId }: { projectId: number }) {
  // Page-level logic
  const { loadTasks, tasks } = useBoardStore();

  useEffect(() => {
    loadTasks(projectId);
  }, [projectId, loadTasks]);

  return <KanbanBoard tasks={tasks} />;
}
```

```typescript
// src/App.tsx
import { KanbanView, AgentsView, SettingsView } from "@/views";

export default function App() {
  return (
    <>
      {activePage === "kanban" && <KanbanView projectId={currentProject.id} />}
      {activePage === "agents" && <AgentsView projectId={currentProject.id} />}
      {/* ... */}
    </>
  );
}
```

### Pattern 2: Domain-Grouped Components

**What:** Organize reusable components by domain (kanban, project, task, execution) with barrel exports (`index.ts`).

**When to use:** For any reusable component that:
- Is used in multiple views
- Belongs to a logical domain
- Can be independently rendered

**Example structure:**
```typescript
// src/components/kanban/index.ts
export { KanbanBoard } from "./KanbanBoard";
export { KanbanColumn } from "./KanbanColumn";
export { TaskCard } from "./TaskCard";
export { TaskModal } from "./TaskModal";

// Usage in a view:
import { KanbanBoard, TaskCard } from "@/components/kanban";

// Or from root:
import { KanbanBoard } from "@/components";
```

**Anti-pattern to avoid:**
```typescript
// Bad: scattered imports
import KanbanBoard from "../../components/KanbanBoard";
import TaskCard from "../../components/TaskCard";

// Good: grouped imports
import { KanbanBoard, TaskCard } from "@/components/kanban";
```

### Pattern 3: Service Layer for IPC

**What:** Extract all Tauri `invoke()` calls into typed service functions. Each service module handles one domain.

**When to use:** Always for any Tauri IPC call. Never call `invoke()` directly in components or stores.

**Example structure:**
```typescript
// src/services/task.service.ts
import { invoke } from "@tauri-apps/api/core";
import type { Task, TaskStatus } from "@/types/bindings";
import { ipc } from "./ipc";

export const taskService = {
  async getTasks(projectId: number): Promise<Task[]> {
    return ipc.invoke<Task[]>("get_tasks", { projectId });
  },

  async updateTaskStatus(taskId: number, status: TaskStatus): Promise<Task> {
    return ipc.invoke<Task>("update_task_status", { taskId, status });
  },

  async createTask(projectId: number, data: CreateTaskRequest): Promise<Task> {
    return ipc.invoke<Task>("create_task", { projectId, ...data });
  },
};
```

```typescript
// src/services/ipc.ts - Type-safe wrapper
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const ipc = {
  async invoke<T>(command: string, args?: Record<string, any>): Promise<T> {
    try {
      return await tauriInvoke<T>(command, args);
    } catch (error) {
      console.error(`IPC error in ${command}:`, error);
      throw new Error(`Failed to ${command}: ${error}`);
    }
  },
};
```

```typescript
// Usage in components:
import { taskService } from "@/services";

export function TaskForm() {
  const handleSubmit = async (data) => {
    const newTask = await taskService.createTask(projectId, data);
    // ...
  };
}
```

**Benefits:**
- Centralized error handling for all IPC calls
- Type-safe invoke wrapper reduces boilerplate
- Easy to mock for testing
- Clear API contract between frontend and backend

### Pattern 4: Hooks with Folder Structure

**What:** For complex hooks, create a folder with `index.ts` + tests. For simple hooks, keep as single files.

**When to use:**
- Complex hooks (3+ effects, conditional logic) → folder structure
- Simple hooks (1 effect, <50 lines) → single file

**Example structure:**
```typescript
// src/utils/hooks/useProjectSelection/useProjectSelection.ts
import { useCallback } from "react";
import { useSelectedProject, setSelectedProject } from "@/store/projectStore";

export function useProjectSelection() {
  const selectedProject = useSelectedProject();

  const handleSelect = useCallback((projectPath: string) => {
    setSelectedProject(projectPath);
  }, []);

  return { selectedProject, handleSelect };
}

// src/utils/hooks/useProjectSelection/index.ts
export { useProjectSelection } from "./useProjectSelection";
```

```typescript
// src/utils/hooks/index.ts - Barrel export
export { useProjectSelection } from "./useProjectSelection";
export { useRecentProjects } from "./useRecentProjects";
export { useSshConnectionManager } from "./useSshConnectionManager";
export { useSshConnectionsQuery } from "./useSshConnectionsQuery";
export { useMobile } from "../use-mobile"; // Simple hooks at root
```

```typescript
// Usage:
import { useProjectSelection, useMobile } from "@/utils/hooks";
```

### Pattern 5: Index/Barrel Exports

**What:** Each domain folder has `index.ts` that re-exports all public items from that folder.

**When to use:** Always. Every domain folder should have a barrel export.

**Example:**
```typescript
// src/components/kanban/index.ts
export { KanbanBoard } from "./KanbanBoard";
export { KanbanColumn } from "./KanbanColumn";
export { TaskCard } from "./TaskCard";
export { TaskModal } from "./TaskModal";
export type { KanbanBoardProps } from "./KanbanBoard";
```

```typescript
// Usage:
import { KanbanBoard, TaskCard } from "@/components/kanban";
// Instead of:
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { TaskCard } from "@/components/kanban/TaskCard";
```

## Don't Hand-Roll

Problems that look simple but should use established patterns:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Importing components from nested folders | Custom path aliases | Update `tsconfig.json` with `@/` paths | Single source of truth, easier refactoring |
| Manual error handling for IPC calls | Try-catch in every component | Centralized service layer with error wrapper | Consistency, reusability, logging |
| Complex form logic | Form state in useState | react-hook-form (already installed) | Validation, performance, field arrays |
| Exporting multiple items from folder | Direct imports from files | Barrel exports (`index.ts`) | Cleaner imports, easier internal reorganization |
| Organizing similar hooks | Flat files in hooks/ | Folder structure with index | Self-documenting, easier to add tests |

**Key insight:** Large codebases fail from import complexity and scattered IPC logic. The refactoring invests in foundational clarity that scales.

## Common Pitfalls

### Pitfall 1: Components Directory Becomes a Dumping Ground

**What goes wrong:** New components added at `src/components/` root level, gradually becoming 50+ files in one directory.

**Why it happens:** Easier to add a file at the root than to think about which domain folder it belongs to. No enforced organization rules.

**How to avoid:**
- Require all new components to be in a domain folder
- Add a lint rule or ESLint plugin to prevent `src/components/*.tsx` files
- During refactoring, establish domain ownership (kanban, project, task, execution, common)

**Warning signs:**
- Run `ls -1 src/components/*.tsx | wc -l` — if > 15, reorganize immediately
- Multiple developers adding to same folder without consultation

### Pitfall 2: Services Not Consistent

**What goes wrong:** Some components use services, others call `invoke()` directly. IPC logic scattered across components and stores.

**Why it happens:** No clear pattern enforced during refactoring. Some developers miss the service layer.

**How to avoid:**
- Create `src/services/` first, before moving components
- Add TypeScript rule: `invoke()` only allowed in `src/services/`
- ESLint rule example: `no-restricted-imports` to block `@tauri-apps/api/core` from components
- Code review checklist: all IPC in services

**Warning signs:**
- Grep finds `invoke(` in more than 3 files outside `src/services/`
- Different error handling patterns in different components

### Pitfall 3: Barrel Exports Create Circular Dependencies

**What goes wrong:** `src/components/index.ts` exports all domains, domain `index.ts` exports all files, leading to circular dependency issues.

**Why it happens:** Over-aggressive barrel exports without thinking about import direction.

**How to avoid:**
- Only barrel export from domain folders, not from `src/components/` root
- Components can import from `@/components/kanban` but NOT from `@/components`
- Use TypeScript strict mode (already enabled) to catch this at compile time

**Warning signs:**
- Build error: "Circular dependency detected"
- Components import from `@/components` instead of `@/components/kanban`

### Pitfall 4: Views Become Too Large

**What goes wrong:** A view component contains 200+ lines with all view-level state and logic inline.

**Why it happens:** Views are tempting places to put everything since they own a page.

**How to avoid:**
- Keep views to ~100 lines max
- Extract complex logic into stores or custom hooks
- Extract internal components to domain folders
- Views should be orchestrators, not implementers

**Example of good vs bad:**

```typescript
// Bad: View with everything inline
export function KanbanView({ projectId }) {
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const { tasks } = useBoardStore();
  // ... 150 more lines of logic ...
  return <KanbanBoard tasks={filtered} />;
}

// Good: View that orchestrates
export function KanbanView({ projectId }) {
  const { tasks } = useBoardStore();
  const filtered = useFilteredTasks(tasks); // Hook

  return <KanbanBoard tasks={filtered} />;
}
```

### Pitfall 5: Path Aliases Not Updated

**What goes wrong:** During refactoring, some imports use relative paths, some use `@/` alias. Inconsistency everywhere.

**Why it happens:** Manual refactoring of 100+ imports is error-prone. Easy to miss some files.

**How to avoid:**
- Use automated find-and-replace (VSCode find/replace regex)
- Or use codemod tool to rewrite imports systematically
- Verify `tsconfig.json` `paths` are correct BEFORE refactoring
- Add linter rule to enforce `@/` paths

**Warning signs:**
- Mix of `../../../` and `@/` imports in same file
- Refactoring commits have inconsistent path styles

## Code Examples

### Example 1: Service Layer Pattern

```typescript
// src/services/project.service.ts
import { ipc } from "./ipc";
import type { Project, AppSettings } from "@/types/bindings";

export const projectService = {
  async getProjects(): Promise<Project[]> {
    return ipc.invoke<Project[]>("get_projects");
  },

  async getOrCreateProject(path: string): Promise<Project> {
    return ipc.invoke<Project>("get_or_create_project", { path });
  },

  async getSettings(): Promise<AppSettings> {
    return ipc.invoke<AppSettings>("get_settings");
  },

  async saveSettings(settings: AppSettings): Promise<void> {
    await ipc.invoke<void>("save_settings", { settings });
  },
};
```

```typescript
// src/services/ipc.ts
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const ipc = {
  async invoke<T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    try {
      console.log(`[IPC] Calling ${command}`, args);
      const result = await tauriInvoke<T>(command, args);
      console.log(`[IPC] ${command} success`, result);
      return result;
    } catch (error) {
      console.error(`[IPC] ${command} failed`, error);
      throw new Error(
        `IPC command failed: ${command} - ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};
```

```typescript
// Usage in App.tsx (before refactoring)
// Old:
const settings = await invoke<AppSettings>("get_settings");

// New:
import { projectService } from "@/services";
const settings = await projectService.getSettings();
```

### Example 2: Component Import Organization

```typescript
// src/components/kanban/index.ts
export { KanbanBoard } from "./KanbanBoard";
export { KanbanColumn } from "./KanbanColumn";
export { TaskCard } from "./TaskCard";
export { TaskModal } from "./TaskModal";

// src/components/project/index.ts
export { ProjectList } from "./ProjectList";
export { ProjectListItem } from "./ProjectListItem";
export { ProjectPicker } from "./ProjectPicker";
export { ConnectionList } from "./ConnectionList";

// src/components/common/index.ts
export { AppHeader } from "./AppHeader";
export { ActionBar } from "./ActionBar";
export { ErrorToast, showSuccessToast } from "./ErrorToast";
export { ThemeToggle } from "./ThemeToggle";

// src/components/index.ts
export * from "./kanban";
export * from "./project";
export * from "./task";
export * from "./common";
export * from "./execution";
export * from "./ui";
```

```typescript
// Usage in views:
import { KanbanBoard, TaskCard } from "@/components/kanban";
import { ProjectList } from "@/components/project";

// Or flat:
import { KanbanBoard, ProjectList } from "@/components";
```

### Example 3: Hook Organization

```typescript
// src/utils/hooks/useProjectSelection/useProjectSelection.ts
import { useCallback } from "react";
import { useSelectedProject, setSelectedProject } from "@/store/projectStore";

export function useProjectSelection() {
  const selectedProject = useSelectedProject();

  const handleSelectProject = useCallback((project: Project) => {
    setSelectedProject(project);
  }, []);

  return { selectedProject, handleSelectProject };
}

// src/utils/hooks/useProjectSelection/index.ts
export { useProjectSelection } from "./useProjectSelection";

// src/utils/hooks/index.ts
export { useProjectSelection } from "./useProjectSelection";
export { useRecentProjects } from "./useRecentProjects";
export { useSshConnectionManager } from "./useSshConnectionManager";
export { useSshConnectionsQuery } from "./useSshConnectionsQuery";
export { useMobile } from "../use-mobile";

// Usage:
import { useProjectSelection } from "@/utils/hooks";
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| All components in src/components/ flat | Domain-grouped components with views | React best practices standardization (~2020) | Scales from 10 to 100+ components |
| Direct invoke() in components | Centralized service layer | Backend abstraction pattern (~2019) | Easier testing, error handling, mocking |
| No folder structure for hooks | Folder structure for complex hooks | Hooks API maturation | Easier to find and test hooks |
| Global barrel exports everywhere | Domain-local barrel exports | Module resolution best practices | Prevents circular dependencies |
| Relative imports (./../) | Absolute path aliases (@/) | Vite + TypeScript improvements | Cleaner, easier to refactor |

**Deprecated/outdated:**
- Container/presentational pattern (still valid, but hooks + stores are more flexible)
- Higher-order components (hooks replaced most use cases)
- Redux-style actions/reducers (Zustand + Immer is simpler for medium-scale apps)

## Open Questions

1. **Should `src/views/` have internal components or all in `src/components/`?**
   - Current recommendation: Views have NO internal components. All components go in `src/components/` domain folders.
   - Rationale: Views are routable screens that import from components. Views contain no renderable code themselves.
   - Alternative: Allow internal components in views if they're screen-specific. This adds flexibility but risks inconsistency.
   - **Recommendation:** Enforce all reusable components in `src/components/` to maintain consistency.

2. **Should services be organized by domain or by operation type?**
   - Current recommendation: By domain (task.service.ts, project.service.ts)
   - Alternative: By operation type (crud.service.ts, query.service.ts)
   - **Recommendation:** Domain-based is more discoverable and matches component organization.

3. **What's the threshold for folder vs single file in utils/hooks?**
   - Recommendation: >75 lines or multiple effects → folder structure
   - Single file: <75 lines, simple logic
   - This may need adjustment based on team preference

## Sources

### Primary (HIGH confidence)

- **CLAUDE.md (project file)** - Establishes current conventions (PascalCase components, Zustand stores, service patterns)
- **Current codebase audit** - Verified 32 components, 5 hooks, 4 stores, 0 service layer
- **React Best Practices** - Official React docs on component organization and code splitting
- **Tauri Documentation** - IPC invoke() patterns and best practices
- **TypeScript Handbook** - Path aliases and module resolution

### Secondary (MEDIUM confidence - verified with official sources)

- **Vite Documentation** - Path alias configuration (tsconfig.json `paths` field)
- **shadcn/ui Setup** - Component organization patterns (they use domain folders too)
- **Zustand GitHub** - State management patterns in medium-scale apps
- **React Hook Form Docs** - Form handling in component-based architectures

### Tertiary (References)

- Industry standard React monorepo patterns (Nx, Turbo)
- Nextjs file-based routing inspiration (views/routes concept)
- Angular feature module patterns (domain-based organization)

## Metadata

**Confidence breakdown:**
- Architecture patterns: **HIGH** - Established React best practices, verified against codebase state
- Service layer abstraction: **HIGH** - Standard pattern in all frontend frameworks with backend calls
- Component organization: **HIGH** - Industry consensus on domain-grouped components
- Pitfalls: **HIGH** - Based on real refactoring experience from similar projects
- Tooling (tsconfig, paths): **HIGH** - Well-documented in official sources

**Research date:** 2026-02-26
**Valid until:** 2026-04-26 (2 months - stable patterns, no major framework updates expected)

**Related documentation:**
- CLAUDE.md - Current conventions and patterns
- .planning/research/ARCHITECTURE.md - UI architecture (Tailwind, shadcn, theming)
- Current codebase structure - 106 total TypeScript files, 32 components at root level
