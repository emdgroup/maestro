# Coding Conventions

**Analysis Date:** 2026-02-14

## Naming Patterns

**Files:**
- React components: PascalCase (e.g., `TaskCard.tsx`, `KanbanBoard.tsx`)
- TypeScript utilities: camelCase (e.g., `tauri-mock.ts`, `path-utils.ts`)
- Rust: snake_case (e.g., `connection.rs`, `execution_logs.rs`)
- Store files: camelCase with "Store" suffix (e.g., `boardStore.ts`)

**Functions:**
- TypeScript/React: camelCase (e.g., `formatElapsedTime`, `getStatusDotColor`)
- Rust: snake_case (e.g., `get_projects`, `get_or_create_project`, `initialize_schema`)
- Exported Tauri commands: snake_case (e.g., `spawn_agent_execution`, `pause_agent_execution`)

**Variables:**
- TypeScript: camelCase (e.g., `isLoading`, `setCurrentProject`, `activeTerminalTaskId`)
- React hooks: camelCase with "use" prefix (e.g., `useBoardStore`, `useForm`)
- State variables: camelCase (e.g., `selectedTaskId`, `reviewModalOpen`)

**Types:**
- TypeScript interfaces/types: PascalCase (e.g., `TaskFormData`, `BoardState`, `ActionBarProps`)
- Rust structs/enums: PascalCase (e.g., `TaskStatus`, `AppSettings`, `Project`)
- Rust enum variants: PascalCase (e.g., `InProgress`, `Backlog`, `Done`)
- Generic type parameters: Uppercase single letters or descriptive capitals (e.g., `T`, `State`)

## Code Style

**Formatting:**
- No auto-formatter configured (no ESLint/Prettier in root config)
- Spaces over tabs (observed throughout codebase)
- 2-space indentation in TypeScript/JavaScript
- 4-space indentation in Rust (Rust convention)

**Linting:**
- TypeScript strict mode enabled (see `tsconfig.json`)
- `noUnusedLocals: true` and `noUnusedParameters: true` enforced
- `noFallthroughCasesInSwitch: true` enforced
- Rust: Standard cargo/clippy conventions

## Import Organization

**Order:**
1. React and external frameworks (e.g., `import React`, `import { useState }`)
2. Third-party libraries (@dnd-kit, @radix-ui, sonner, zustand)
3. Tauri API imports (e.g., `from "@tauri-apps/api/core"`)
4. Internal modules (relative paths or path aliases)
5. Type imports (e.g., `type { Task }`)

**Path Aliases:**
- `@/*` → `./src/*` (root alias for all src files)
- `@/components` → `./src/components` (components alias)
- `@/components/ui` → `./src/components/ui` (UI components alias)
- `@/lib` → `./src/lib` (utilities and helpers)
- `@/hooks` → `./src/hooks` (custom React hooks)

Example imports:
```typescript
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { invoke } from "@tauri-apps/api/core";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types/bindings";
```

## Error Handling

**TypeScript/React:**
- Use try-catch blocks with async/await for Tauri IPC calls
- Log errors to console with `console.error()` for debugging
- Display user-facing errors via toast notifications (`showErrorToast()` from `ErrorToast.tsx`)
- Error messages show in bottom-right corner with 4s auto-dismiss (configurable)
- Multiple simultaneous toasts limited to 3 visible (via Sonner config)

**Error Logging Pattern:**
```typescript
try {
  const result = await invoke("command_name", { args });
} catch (err) {
  console.error("Operation failed:", err);
  showErrorToast(`Error: ${err instanceof Error ? err.message : String(err)}`);
}
```

**Rust:**
- Use `Result<T, AppError>` pattern for fallible operations
- Database operations return `Result<T, String>` for Tauri serialization compatibility
- Custom `AppError` enum in `src-tauri/src/error.rs` handles `DatabaseError` and `IoError`
- Convert errors to strings for IPC handlers: `.map_err(|e| e.to_string())`

**Rust Error Pattern:**
```rust
pub fn operation() -> Result<Data, AppError> {
    // operations
    .map_err(|e| AppError::DatabaseError(format!("Reason: {}", e)))?;
    Ok(result)
}
```

## Logging

**Framework:** `console` object (no external logging library)

**Patterns:**
- Debug logs prefixed with `[DEBUG]` tag for development tracing
- Error logs prefixed with component/module name
- No logging in production build (rely on browser dev tools)
- Structured logging in Tauri handlers for command tracing

**Examples:**
```typescript
console.log("[DEBUG] App.tsx: Loading all projects");
console.error("[ExecutionTerminal] Attach terminal error:", err);
console.warn("cancel_execution handler not available, marking task manually");
```

## Comments

**When to Comment:**
- Explain why, not what - code should be self-documenting
- Complex algorithms or non-obvious business logic
- Workarounds and temporary fixes (mark with TODO/FIXME)
- Marker comments for development context (e.g., `[DEBUG]` for debug logs)

**JSDoc/TSDoc:**
- Used sparingly in frontend (most components are self-explanatory)
- Rust doc comments (`///`) used for public module functions
- Example from `db/connection.rs`:
```rust
/// Initialize the SQLite database
///
/// This function:
/// 1. Creates the directory structure if it doesn't exist
/// 2. Opens or creates the SQLite database
/// 3. Enables foreign keys
/// 4. Initializes the schema
pub fn init_db(db_path: PathBuf) -> Result<Connection, AppError> { ... }
```

**TODO/FIXME Markers:**
```typescript
// TODO: cancel_execution expects logId, not taskId - this needs to fetch the log first
// TODO: Implement reset to defaults
// TODO: Implement save settings
```

## Function Design

**Size:** Favor small, focused functions (single responsibility)
- Component functions typically 50-150 lines with hooks
- Helper functions 10-30 lines
- Utility functions avoid side effects

**Parameters:**
- Use object destructuring for React component props (reduces param count)
- Type all parameters explicitly
- Provide sensible defaults where appropriate

**Return Values:**
- Async functions return `Promise<T>` with explicit type
- React components return `React.ReactElement` or use implicit return
- Always type function returns explicitly

**Example:**
```typescript
// Component with destructured props
export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  isDragging = false,
  projectPath = "",
  onTaskClick,
  onReviewClick,
  onSettingsClick
}) => { ... }

// Helper function with explicit types
function getStatusDotColor(status: string): string {
  switch (status) {
    case 'Done': return 'bg-success';
    default: return 'bg-muted';
  }
}

// Async utility
async function loadAllProjects(): Promise<void> {
  const projects = await safeInvoke<Project[]>("get_projects");
}
```

## Module Design

**Exports:**
- Named exports preferred for utilities and functions
- Default exports used for React components
- Type exports use `export type` syntax

**Barrel Files:**
- Not consistently used; most imports are direct paths
- Components imported from specific files (e.g., `from "./components/TaskCard"`)

**Store Pattern (Zustand):**
```typescript
// Use immer middleware for immutable updates
export const useBoardStore = create<BoardState>()(
  immer((set, get) => ({
    // State
    tasks: [],
    activeTerminalTaskId: null,

    // Reducers with immer (direct mutations allowed)
    loadTasks: (tasks: Task[]) =>
      set((state) => {
        state.tasks = tasks;
      }),

    // Selectors
    getTasks: () => {
      return get().tasks;
    }
  }))
);
```

## Styling Approach

**Tailwind CSS 4.1:**
- Global styles in `src/index.css` with `@import "tailwindcss"`
- Component-level utility classes in JSX
- Theme variables defined as CSS custom properties (OKLch color space for system accent support)
- Dark mode via `dark` class on `<html>` element

**Component Styling:**
```typescript
<div className="bg-background text-foreground rounded-md shadow-sm hover:shadow-md transition-colors">
  <span className="text-sm font-medium text-muted-foreground">Label</span>
</div>
```

**CSS Variables (from `index.css`):**
- `--background` / `--foreground` - Base colors
- `--card` / `--card-foreground` - Card containers
- `--primary` / `--primary-foreground` - Primary actions
- `--accent` / `--accent-foreground` - Accent color (system-sourced)
- `--destructive` / `--destructive-foreground` - Error/delete actions
- `--success`, `--warning` - Status indicators

---

*Convention analysis: 2026-02-14*
