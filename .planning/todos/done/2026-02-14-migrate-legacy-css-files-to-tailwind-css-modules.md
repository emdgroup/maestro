---
created: 2026-02-14T12:34
title: Migrate legacy CSS files to Tailwind/CSS modules
area: ui
files:
  - src/styles/TaskForm.css
  - src/styles/ImportSettings.css
  - src/styles/KanbanBoard.css
  - src/styles/ExecutionHistory.css
  - src/styles/TaskDetail.css
  - src/styles/ProjectSettingsModal.css
  - src/styles/TaskSettingsModal.css
  - src/styles/ExecutionTerminal.css
  - src/styles/ProjectPicker.css
  - src/styles/ProjectCard.css
  - src/styles/TaskCard.css
  - src/styles/TaskModal.css
  - src/styles/fonts.css
---

## Problem

The `src/styles/` folder contains 13 CSS files that violate the project's styling architecture:

**Project styling rules:**
1. Tailwind CSS first (utility classes)
2. CSS modules second (for special cases where Tailwind is insufficient)
3. Global CSS for components is forbidden

**Current state:**
- 13 legacy CSS files exist in `src/styles/`
- These files use global component-specific styles instead of Tailwind utilities or CSS modules
- This creates maintenance overhead, specificity issues, and inconsistency with the v1.1 design system (Phase 15 established Tailwind + CSS variables as the standard)

**Scope:**
- Analyze where each CSS file is imported/used
- Identify which styles can be replaced with Tailwind utilities
- Identify special cases requiring CSS modules
- Migrate all styles to follow the architecture
- Remove legacy CSS files after migration

## Solution

**Phase 1: Analysis**
- Grep for imports of each CSS file across the codebase
- Document component dependencies
- Categorize styles: Tailwind-replaceable vs CSS-module candidates

**Phase 2: Migration**
- Replace simple styles with Tailwind utilities (layout, spacing, colors, typography)
- Convert complex animations/pseudo-selectors to CSS modules where needed
- Update imports in components
- Test visual regression with existing Playwright tests

**Phase 3: Cleanup**
- Delete `src/styles/*.css` files (except fonts.css if needed for font-face declarations)
- Verify no broken imports
- Commit with atomic changes per component

**Notes:**
- `fonts.css` may be legitimate if it contains @font-face declarations (check if these can move to global.css)
- Phase 15 already established CSS variables for theming, so color values should use `hsl(var(--primary))` pattern
- Some CSS files may already be partially unused after Phase 14-17 component migrations
