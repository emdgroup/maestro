# Roadmap: v1.1 UI/UX Polish

## Overview

This milestone fixes critical v1.0 bugs (mock IPC leak, Rust warnings) then transforms the UI from functional to beautiful. We establish a modern CSS framework (Tailwind CSS 4.1 + shadcn/ui), implement a complete theming system with no flash-on-startup, migrate all components to a design system, and redesign all five major pages (Kanban, Agent Monitor, Worktree Manager, Settings, Header) matching the clean, modern mockup aesthetic with system-first theme and OS accent colors.

## Phases

**Phase Numbering:**
- Integer phases (13-17): Planned milestone work for v1.1
- Continues from v1.0 which ended at Phase 12

- [x] **Phase 13: Bug Fixes** - Fix mock IPC leak and Rust build warnings
- [x] **Phase 14: UI Foundation** - Tailwind CSS, shadcn/ui, theme system with no flash
- [x] **Phase 15: Component & Design System** - Migrate components, establish design tokens
- [x] **Phase 16: Page Redesigns** - Modernize all major application pages
- [x] **Phase 17: Polish & Testing** - Final QA, edge cases, production build validation
- [x] **Phase 17.1: Critical UI Fixes (INSERTED)** - Fix production folder selection, match reference design, verify with Playwright
- [x] **Phase 18: Maestro Folder Architecture & Rebranding** - Migrate to project-local .maestro folder for state/settings, rename project to Maestro
- [x] **Phase 19: Frontend Architecture Refactoring** - Reorganize src/ to follow standard structure with views/, services/, and grouped components
- [x] **Phase 20: Refactor Frontend to use TanStack Query** - Replace direct invoke() calls with TanStack Query hooks for data fetching, caching, and mutations
- [x] **Phase 21: Refactor Components Using Commands Object** - Refactor any component using directly "commands" object from @src/types/bindings.ts to use service hooks instead
- [ ] **Phase 22: Auto-remove Stale Projects** - Validate local project paths on fetch and silently remove missing ones before displaying the list

## Phase Details

### Phase 13: Bug Fixes

**Goal**: Eliminate mock IPC leak into production and resolve all Rust build warnings to achieve clean build

**Depends on**: v1.0 complete (Phase 12)

**Requirements**: BUG-01, BUG-02

**Success Criteria** (what must be TRUE):
  1. Release build does not include tauri-mock.ts or mock handlers
  2. `cargo build` produces zero warnings
  3. Mock handlers used only in dev mode with build-time exclusion verified

**Plans**: 2 plans

Plans:
- [x] 13-01-PLAN.md — Fix Rust warnings (cargo fix + manual dead code removal); implement build-time mock exclusion via import.meta.env.DEV gates; add automated bundle verification script to prevent regression
- [x] 13-02-PLAN.md — Document mock exclusion pattern in CLAUDE.md; add code comments explaining removed SSH functions and conditional imports; provide future developer reference

---

### Phase 14: UI Foundation

**Goal**: Establish CSS framework and complete theming system preventing flash-of-unstyled-content on startup

**Depends on**: Phase 13

**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05

**Success Criteria** (what must be TRUE):
  1. Tailwind CSS 4.1 utilities work throughout app with @tailwindcss/vite plugin configured
  2. User can toggle between light, dark, and system theme with instant visual update
  3. Theme preference persists across app restarts
  4. No visible flash or flicker on app startup regardless of theme selection
  5. shadcn/ui components render correctly with theme-aware styling

**Plans**: 4 plans

Plans:
- [x] 14-01-PLAN.md — Install Tailwind CSS 4.1 + @tailwindcss/vite, configure tailwind.config.ts with CSS variable colors and container queries, update src/index.css with theme variables
- [x] 14-02-PLAN.md — Extend AppSettings Rust model with theme_preference field, update database load/save functions, regenerate TypeScript bindings
- [x] 14-03-PLAN.md — Create ThemeProvider React component, integrate in App.tsx, add Tauri window preload for flash-free startup
- [x] 14-04-PLAN.md — Add theme selector to ProjectSettingsModal, implement theme persistence and instant visual updates

---

### Phase 15: Component & Design System

**Goal**: Migrate all reusable components to shadcn/ui, establish consistent design tokens for colors/fonts/spacing across the app

**Depends on**: Phase 14

**Requirements**: UI-06, UI-07, UI-13, UI-14, UI-15

**Success Criteria** (what must be TRUE):
  1. Button, Card, Input, Dialog, Badge, Select components use shadcn/ui throughout app
  2. All old hand-written CSS for core components deleted, single source of truth achieved
  3. Colors use system accent color dynamically (CSS variables) with dark theme as default
  4. Typography consistent: FiraCode for terminal/code, Inter for UI text with proper fallbacks
  5. Spacing follows compact, power-user-friendly pattern (text-xs, h-7 buttons, p-3 cards)

**Plans**: 3 plans

Plans:
- [ ] 15-01-PLAN.md — Initialize shadcn/ui, install core components (Button, Card, Input, Dialog, Badge, Select, Checkbox, Label, Textarea, Tabs, Popover)
- [ ] 15-02-PLAN.md — Migrate all components to shadcn/ui imports, delete old custom component implementations
- [ ] 15-03-PLAN.md — Establish design system (CSS variables, semantic colors, typography hierarchy, spacing scale)

---

### Phase 16: Page Redesigns

**Goal**: Redesign all major application pages with modern aesthetic matching mockup: Kanban board, Agent monitor, Worktree manager, Settings panel, App header

**Depends on**: Phase 15

**Requirements**: UI-08, UI-09, UI-10, UI-11, UI-12

**Success Criteria** (what must be TRUE):
  1. Kanban board displays with card-based layout, colored status dots (animated pulse for in-progress), drag-drop visual feedback
  2. Agent monitor shows split-pane interface with agent list sidebar and live terminal output with semantic prefix coloring
  3. Worktree manager displays cards with git status, branch names, clean/dirty indicators
  4. Settings panel uses sectioned layout with icons and shadcn form controls, clear visual hierarchy
  5. App header includes project selector, navigation tabs, agent status indicator, action buttons

**Plans**: 2 plans

Plans:
- [ ] 16-01-PLAN.md — Modernize Kanban board layout with grid structure, semantic status dots with pulse animation, hover effects, and drag feedback styling
- [ ] 16-02-PLAN.md — Create AppHeader component with navigation tabs, implement Agent Monitor and Worktree Manager pages, update Settings panel to modern sectioned layout

---

### Phase 17: Polish & Testing

**Goal**: Final QA pass validating responsive design, dark mode edge cases, color contrast, and production build correctness

**Depends on**: Phase 16

**Requirements**: None (closure phase)

**Success Criteria** (what must be TRUE):
  1. Production build (`pnpm tauri build`) succeeds with no CSS purging issues or missing classes
  2. Dark mode toggle persists correctly across app restarts with no flicker
  3. All text meets WCAG AA color contrast requirements (4.5:1 minimum)
  4. Hover states, focus rings, disabled states render correctly on all components
  5. No visual regressions from v1.0 Kanban workflow functionality

**Plans**: 2 plans

Plans:
- [x] 17-01-PLAN.md — Production build validation (pnpm tauri build succeeds, CSS coverage verified, dark mode persists, responsive layout tested, Kanban regression checked)
- [x] 17-02-PLAN.md — Accessibility audit (WCAG AA contrast ≥4.5:1, focus rings visible, keyboard navigation, semantic HTML, motion accessibility), final QA sign-off

---

### Phase 17.1: Critical UI Fixes (INSERTED)

**Goal**: Fix production mode project selection, implement slick modern UX patterns inspired by exemple/ (not pixel-perfect copy), and verify with actual screenshots using Playwright

**Depends on**: Phase 17

**Requirements**: None (urgent bug fixes)

**Success Criteria** (what must be TRUE):
  1. Production mode folder selection proceeds to main app (not stuck at picker)
  2. UI has slick modern aesthetic quality (not unstyled/unpolished appearance)
  3. UX patterns from exemple/ implemented:
     - Project dropdown in header (not separate ProjectPicker screen)
     - Tab navigation for "Tasks", "Agents", "Worktrees", "Settings" visible
     - Kanban columns have clear, intuitive names
     - Overall layout feels polished and intentional
  4. System accent color properly integrated (not hardcoded colors)
  5. Playwright screenshots taken showing before/after visual improvements
  6. All issues from user screenshots fixed and visually verified

**Plans**: 4 plans

Plans:
- [x] 17.1-01-PLAN.md — Production-safe IPC logging wrapper with comprehensive console debugging for folder selection flow
- [x] 17.1-02-PLAN.md — Modern AppHeader with inline project dropdown and tab navigation (Tasks/Agents/Worktrees/Settings)
- [x] 17.1-03-PLAN.md — System accent color integration with dynamic theme-aware injection
- [x] 17.1-04-PLAN.md — Playwright visual regression testing with 10 test cases and 13 baseline screenshots

---

### Phase 18: Maestro Folder Architecture & Rebranding

**Goal**: Shift from database-centric to project-local storage model with .maestro folder containing project state and settings; rebrand application from "GSD Orchestrator" to "Maestro"

**Depends on**: Phase 17.1

**Requirements**: None (architectural improvement)

**Success Criteria** (what must be TRUE):
  1. When creating a project, a `.maestro/` folder is created at project root
  2. Project-specific settings can be stored as JSON file in `.maestro/settings.json`
  3. Project state models support serialization to `.maestro/state.json`
  4. All references to "GSD Orchestrator" renamed to "Maestro" in UI, docs, and code

**Plans**: 4 plans

Plans:
- [x] 18-01-PLAN.md — Create ProjectConfig and ProjectState Rust models with JSON serialization
- [x] 18-02-PLAN.md — Implement file I/O layer (project_storage.rs) for .maestro folder operations
- [x] 18-03-PLAN.md — Rebrand application from GSD Orchestrator to Maestro (tauri.conf.json, Cargo.toml, docs)
- [x] 18-04-PLAN.md — Integrate .maestro initialization into project creation workflow

**Details:**

This phase represents a fundamental architectural shift:

**Current Architecture:**
- All project state stored in SQLite database in app data directory
- Projects reference external folder paths
- Settings stored globally in database

**New Architecture:**
- Each project folder contains `.maestro/` directory with:
  - `settings.json` - project-specific settings
  - `state.json` or similar - task state, worktree state
  - `logs/` - execution logs (optional design)
- Global database retains only:
  - Appearance settings (theme, UI preferences)
  - Recent projects list (paths to .maestro folders)
- Opening a project = loading from `.maestro/` folder
- Creating a project = initializing `.maestro/` folder structure

**Rebranding:**
- "GSD Orchestrator" → "Maestro" everywhere
- Window titles, app name, documentation, code comments
- Keep technical references to "gsd" in folder names (`.planning/`, command names) for consistency

---

### Phase 19: Frontend Architecture Refactoring

**Goal**: Reorganize frontend codebase to follow standard project structure with clear separation between views (pages), reusable components, services (business logic), and utilities

**Depends on**: Phase 18

**Requirements**: None (architectural improvement)

**Success Criteria** (what must be TRUE):
  1. All page-level components moved to `src/views/` with route-based organization
  2. Reusable components grouped by domain in `src/components/` with index exports
  3. Tauri IPC calls extracted into service layer at `src/services/`
  4. Hooks organized in `src/utils/hooks/` with folder-per-hook structure
  5. Helpers consolidated in `src/utils/helpers/` (path, diff, ui utilities)
  6. All imports updated to use new structure with no broken references

**Plans**: 6 plans in 4 waves

Plans:
- [ ] 19-01-PLAN.md — Extract page-level components to src/views/
- [ ] 19-02-PLAN.md — Create centralized service layer (ipc wrapper + domain services)
- [ ] 19-03-PLAN.md — Organize reusable components into domain folders
- [ ] 19-04-PLAN.md — Replace all invoke() calls with service layer
- [ ] 19-05-PLAN.md — Consolidate hooks and helpers into src/utils/
- [ ] 19-06-PLAN.md — Finalize path aliases and comprehensive verification

**Details:**

This phase refactors the frontend architecture to match industry-standard project structure guidelines:

**Current Structure Issues:**
- All components flat in `/components` - no separation between views and reusable UI
- Business logic mixed with component code (Tauri IPC calls inline)
- Hooks scattered in `/hooks` instead of `/utils/hooks`
- `/lib` folder exists but should be consolidated into `/utils`
- No `/services` folder for API/IPC abstraction
- No `/views` folder for page-level components

**Target Structure:**
```
src/
├── views/              # Page-level components (ProjectPicker, Kanban, Agents, Worktrees, Settings)
├── components/         # Reusable UI components grouped by domain
│   ├── kanban/        # TaskCard, KanbanColumn
│   ├── task/          # TaskForm, TaskModal, TaskDetail
│   ├── project/       # ProjectList, ProjectListItem
│   ├── connection/    # ConnectionList, ConnectionHeader
│   ├── common/        # ThemeToggle, SyncButton, etc.
│   └── ui/            # shadcn/ui primitives (keep as-is)
├── services/          # Business logic and IPC abstraction
│   ├── tauri.service.ts
│   ├── project.service.ts
│   ├── task.service.ts
│   └── worktree.service.ts
├── store/             # Global state (no changes)
├── utils/             # Utilities organized by type
│   ├── hooks/         # Custom hooks (folder per hook)
│   ├── helpers/       # Helper functions (path, diff, ui)
│   └── constants/     # Global constants
└── types/             # TypeScript types (no changes)
```

**Migration Strategy:**
1. Create service layer first (extract IPC calls)
2. Move page components to views/
3. Group reusable components by domain
4. Reorganize utils (hooks, helpers, constants)
5. Update all imports across codebase
6. Test and verify no regressions

---

### Phase 20: Refactor Frontend to use TanStack Query

**Goal**: Replace all direct Tauri invoke() calls with TanStack Query hooks for consistent data fetching, caching, and mutation patterns across the frontend

**Depends on**: Phase 19

**Requirements**: None (architectural improvement)

**Success Criteria** (what must be TRUE):
  1. All Tauri IPC data fetching operations use TanStack Query's useQuery hook
  2. All Tauri IPC mutations use TanStack Query's useMutation hook
  3. Query hooks defined in corresponding service files (src/services/*.ts) not in hooks folder
  4. Automatic cache invalidation and refetching configured for all mutations
  5. Loading and error states managed through TanStack Query state
  6. No direct invoke() calls remaining in React components for data operations

**Plans**: TBD (run /gsd:plan-phase 20 to break down)

Plans:
- [ ] TBD

**Details:**

This phase modernizes the frontend data layer by adopting TanStack Query as the standard pattern for all backend communication, following the pattern established in `useSshConnectionsQuery.ts`.

**Current Architecture:**
- Components make direct `invoke()` calls to Tauri backend
- Manual loading/error state management in components
- No automatic caching or refetching
- Inconsistent patterns across different features
- Example: `useSshConnectionsQuery.ts` already uses TanStack Query

**Target Architecture:**
- All data fetching through `useQuery` hooks
- All mutations through `useMutation` hooks
- Query hooks defined in service files (e.g., `src/services/task.service.ts`)
- Centralized cache management via QueryClient
- Optimistic updates for instant UI feedback
- Automatic refetching on window focus, network reconnect, etc.
- Consistent loading/error/success states

**Migration Strategy:**
1. Audit all invoke() calls across components
2. Create TanStack Query hooks in service files
3. Migrate components to use query hooks
4. Configure cache invalidation strategies
5. Test data flow and cache behavior
6. Remove old direct invoke() patterns

**Benefits:**
- Automatic caching reduces redundant backend calls
- Optimistic updates improve perceived performance
- Standardized loading/error handling
- Better developer experience with devtools
- Easier testing with query mocks

---

### Phase 21: Refactor Components Using Commands Object

**Goal**: Refactor any component using directly "commands" object from @src/types/bindings.ts to use service hooks instead

**Depends on**: Phase 20

**Requirements**: None (architectural improvement)

**Success Criteria** (what must be TRUE):
  1. No components directly import or use the `commands` object from bindings.ts
  2. All components use service hooks from service layer for IPC operations
  3. Type safety maintained through service layer abstractions
  4. Loading and error states properly managed through service hooks
  5. Production build passes with no TypeScript errors

**Plans**: 1 plan

Plans:
- [x] 21-PLAN.md — Extend connection.service.ts with 4 file browser hooks; verify project.service.ts hooks; refactor ProjectList, ConnectionHeader, FilePicker, SettingsPage, useSshConnectionManager to service hooks; eliminate all 15 direct commands usages

**Details:**

This phase completes the architectural refactoring by eliminating direct usage of the auto-generated `commands` object from TypeScript bindings. After Phase 19 (service layer creation) and Phase 20 (TanStack Query integration), some components may still directly import and use the `commands` object instead of going through the service layer.

**Current Issue:**
- Some components may directly use `commands.someCommand()` from bindings.ts
- Bypasses service layer abstraction and TanStack Query benefits
- Inconsistent patterns across codebase

**Target State:**
- All IPC operations go through service layer (src/services/)
- Components use hooks from services (useQuery/useMutation patterns)
- `commands` object only used internally by service layer
- Consistent error handling and loading states everywhere

**Migration Approach:**
1. Audit codebase for direct `commands` imports
2. For each component using `commands` directly:
   - Identify which commands are being called
   - Replace with corresponding service hooks
   - Remove direct `commands` import
3. Verify no direct `commands` usage remains outside service layer
4. Run production build to confirm type safety

---

### Phase 22: Auto-remove Stale Projects

**Goal**: When fetching projects for a connection, automatically validate that project paths still exist and silently remove those that don't before returning the list — so the user never sees dead entries.

**Depends on**: Phase 21

**Requirements**: None (UX improvement)

**Success Criteria** (what must be TRUE):
  1. Local projects whose paths no longer exist on disk are deleted from the database before `get_connection_projects` returns
  2. SSH projects whose remote paths no longer exist are deleted using the active SSH session
  3. The returned project list contains only projects with valid, existing paths
  4. SSH projects are validated using the active SSH session; if no session is found, validation is skipped for that connection.
  5. SSH validation is skipped gracefully if no active session is found (fail-safe)
  6. `cargo build` passes with no errors

**Plans**: 1 plan

Plans:
- [ ] 22-01-PLAN.md — Validate project paths (local via std::fs, SSH via active session) in `get_connection_projects`; delete stale entries from DB before returning the filtered list

---

## Progress

**Execution Order:**
Phases execute in numeric order: 13 → 14 → 15 → 16 → 17 → 17.1 → 18 → 19 → 20 → 21 → 22

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 13 - Bug Fixes | 2 | Complete | 2026-02-09 |
| 14 - UI Foundation | 4 | Complete | 2026-02-10 |
| 15 - Component & Design System | 3 | Complete | 2026-02-10 |
| 16 - Page Redesigns | 2 | Complete | 2026-02-10 |
| 17 - Polish & Testing | 2 | Complete | 2026-02-10 |
| 17.1 - Critical UI Fixes (INSERTED) | 4 | Complete | 2026-02-11 |
| 18 - Maestro Folder Architecture & Rebranding | 4 | Complete | 2026-02-23 |
| 19 - Frontend Architecture Refactoring | 6 | Complete | 2026-02-26 |
| 20 - Refactor Frontend to use TanStack Query | 7 | Complete | 2026-02-27 |
| 21 - Refactor Components Using Commands Object | 1 | Complete | 2026-02-28 |
| 22 - Auto-remove Stale Projects | 1 | Pending | - |

**Total v1.1 work:** 35 plans across 11 phases (13 original + 4 from urgent insertion Phase 17.1 + 4 from Phase 18 + 6 from Phase 19 + 7 from Phase 20 + 1 from Phase 21 + 1 from Phase 22)

---

*Roadmap created: 2026-02-09*
*Phase 13 planning completed: 2026-02-09*
*Continues from v1.0 phases 1-12 (shipped 2026-02-09)*
