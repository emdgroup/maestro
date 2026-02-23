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
- [ ] **Phase 18: Maestro Folder Architecture & Rebranding** - Migrate to project-local .maestro folder for state/settings, rename project to Maestro

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

## Progress

**Execution Order:**
Phases execute in numeric order: 13 → 14 → 15 → 16 → 17 → 17.1 → 18

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 13 - Bug Fixes | 2 | Complete | 2026-02-09 |
| 14 - UI Foundation | 4 | Complete | 2026-02-10 |
| 15 - Component & Design System | 3 | Complete | 2026-02-10 |
| 16 - Page Redesigns | 2 | Complete | 2026-02-10 |
| 17 - Polish & Testing | 2 | Complete | 2026-02-10 |
| 17.1 - Critical UI Fixes (INSERTED) | 4 | Complete | 2026-02-11 |
| 18 - Maestro Folder Architecture & Rebranding | 4 | Complete | 2026-02-23 |

**Total v1.1 work:** 21 plans across 7 phases (13 original + 4 from urgent insertion Phase 17.1 + 4 from Phase 18)

---

*Roadmap created: 2026-02-09*
*Phase 13 planning completed: 2026-02-09*
*Continues from v1.0 phases 1-12 (shipped 2026-02-09)*
