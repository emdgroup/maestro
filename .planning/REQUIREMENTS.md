# Requirements: v1.1 UI/UX Polish

**Milestone:** v1.1 UI/UX Polish
**Goal:** Fix critical bugs and dramatically improve visual design with modern, clean aesthetic
**Status:** In progress (roadmap created)

---

## v1.1 Requirements (This Milestone)

### Bug Fixes

**Category:** Critical bug fixes from v1.0

- [x] **BUG-01**: User should not see mock IPC handlers in release builds
  - ✓ Implemented build-time conditional imports using import.meta.env.DEV
  - ✓ Vite tree-shaking eliminates mock code from production bundle
  - ✓ Verified: 0 mock markers in 298 JS files (Phase 13-01)

- [x] **BUG-02**: Developer should see zero Rust build warnings
  - ✓ Removed unused import from src-tauri/src/main.rs
  - ✓ cargo build --lib produces zero warnings
  - ✓ Verified: cargo build completes with "Finished" message (Phase 13-01)

### UI Foundation

**Category:** Core UI framework and theming infrastructure

- [x] **UI-01**: User can use Tailwind CSS utilities throughout the app
  - Install Tailwind CSS 4.1+ and @tailwindcss/vite
  - Configure tailwind.config.ts with content paths
  - Add Tailwind directives to main CSS file
  - Verify utilities work in components

- [x] **UI-02**: User can use shadcn/ui components
  - Initialize shadcn/ui with `pnpm dlx shadcn@latest init`
  - Configure path aliases in tsconfig.json and vite.config.ts
  - Install core components (Button, Card, Input, Dialog, Badge, Select)
  - Verify components render correctly (foundation ready, component integration Phase 15)

- [x] **UI-03**: User can switch between light, dark, and system theme
  - Install and configure next-themes (used ThemeProvider instead)
  - Implement theme provider wrapping app
  - Persist theme preference to storage
  - Support system theme detection

- [x] **UI-04**: User can toggle theme from settings
  - Add theme toggle control in settings panel
  - Show current theme selection (light/dark/system)
  - Update immediately on change

- [x] **UI-05**: User should not see theme flash on app startup
  - Inject theme detection script in index.html `<head>` (used main.tsx + Tauri preload instead)
  - Load theme from storage before React renders
  - Prevent FOUC (Flash of Unstyled Content)

### Component Redesign

**Category:** Migrate existing components to Tailwind + shadcn

- [ ] **UI-06**: User sees consistent styled components throughout app
  - Migrate Button, Card, Input, Dialog, Badge, Select to shadcn versions
  - Replace old component implementations
  - Verify all instances updated

- [ ] **UI-07**: Developer maintains styles using Tailwind and CSS modules
  - Replace global CSS files with Tailwind utilities
  - Use CSS modules only for terminal/special cases
  - Delete old CSS files after migration
  - Verify no CSS conflicts

### Page Redesign

**Category:** Redesign main application views matching mockup aesthetic

- [ ] **UI-08**: User sees modern Kanban board matching mockup design
  - Card-based layout with subtle borders
  - Status indicators with colored dots (animated pulse for in-progress)
  - Tight spacing (text-xs, h-7 buttons, p-3 cards)
  - Hover effects revealing actions (opacity transitions)
  - Drag-drop visual feedback (border highlights, background tints)

- [ ] **UI-09**: User sees modern Agent monitor interface
  - Terminal-style output with monospace font
  - Agent sidebar showing status and metrics
  - Live log streaming display
  - Status indicators (running/idle/error)
  - Agent selection interface

- [ ] **UI-10**: User sees modern Worktree manager interface
  - Worktree cards with git status
  - Branch names and commit info
  - Clean/dirty/conflict status indicators
  - Hover actions for management

- [ ] **UI-11**: User sees modern Settings panel
  - Sectioned layout with icons
  - Form controls using shadcn components
  - Clear visual hierarchy
  - Save/reset actions

- [ ] **UI-12**: User sees modern App header and navigation
  - Project selector dropdown
  - Navigation tabs (Tasks, Agents, Worktrees, Settings)
  - Status display (agents running indicator)
  - Action buttons (New Agent, etc.)

### Typography & Visual

**Category:** Design system implementation

- [ ] **UI-13**: User sees consistent colors using system accent color
  - Implement design system using system accent color (dynamic)
  - Dark theme as default
  - CSS variables for theming
  - Consistent color usage across components

- [ ] **UI-14**: User sees appropriate fonts for different content types
  - FiraCode font for terminal/code output
  - Inter font for UI text
  - Proper font loading and fallbacks

- [ ] **UI-15**: User sees consistent spacing throughout app
  - Tight, compact layout matching mockup
  - Consistent padding (p-3 for cards, py-0.5 for text)
  - Proper visual hierarchy

---

## Future Requirements

**Deferred to v1.2 or later:**

- Light mode implementation (dark mode only in v1.1)
- Mobile/responsive design (desktop-first in v1.1)
- Advanced animations and transitions
- Full accessibility audit (WCAG 2.1 AA compliance)
- Custom theme color picker
- Font size customization

---

## Out of Scope

**Explicitly excluded from v1.1:**

- Multi-project UI (defer to v2.0)
- Plugin marketplace UI (defer to v2.0)
- Custom theme builder (defer to v2.0)
- Mobile app support (desktop only)
- Web deployment (Tauri desktop only)
- i18n/localization (English only)

---

## Traceability

Mapping requirements to v1.1 roadmap phases:

| Requirement | Phase | Status |
|-------------|-------|--------|
| BUG-01 | 13 | Not started |
| BUG-02 | 13 | Not started |
| UI-01 | 14 | Complete |
| UI-02 | 14 | Complete |
| UI-03 | 14 | Complete |
| UI-04 | 14 | Complete |
| UI-05 | 14 | Complete |
| UI-06 | 15 | Complete |
| UI-07 | 15 | Complete |
| UI-13 | 15 | Complete |
| UI-14 | 15 | Complete |
| UI-15 | 15 | Complete |
| UI-08 | 16 | Not started |
| UI-09 | 16 | Not started |
| UI-10 | 16 | Not started |
| UI-11 | 16 | Not started |
| UI-12 | 16 | Not started |

**Coverage:** 17/17 requirements mapped ✓

---

*Roadmap traceability updated: 2026-02-09*
