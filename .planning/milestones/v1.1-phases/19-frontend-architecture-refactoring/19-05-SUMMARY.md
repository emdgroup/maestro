---
phase: 19
plan: 05
subsystem: frontend-architecture
tags: [utils, hooks, helpers, refactoring, organization, barrel-exports]
title: "Phase 19 Plan 05: Organize Utils Layer (Hooks and Helpers)"
date_completed: 2026-02-26T21:29:40Z
duration_minutes: 5
completed_date: 2026-02-26

dependency_graph:
  requires: [19-02, 19-03, 19-04]
  provides: [utils-layer-organized]
  affects: [imports-throughout-codebase]

tech_stack:
  added: []
  patterns: [barrel-exports, folder-structure, centralized-utils]

key_files:
  created:
    - src/utils/hooks/
    - src/utils/hooks/useProjectPickerNavigation/index.ts
    - src/utils/hooks/useRecentProjects/index.ts
    - src/utils/hooks/useSshConnectionManager/index.ts
    - src/utils/hooks/useSshConnectionsQuery/index.ts
    - src/utils/hooks/index.ts
    - src/utils/helpers/
    - src/utils/helpers/path-utils.ts
    - src/utils/helpers/diff-utils.ts
    - src/utils/helpers/ui-utils.ts
    - src/utils/helpers/index.ts
    - src/utils/index.ts
  modified:
    - src/App.tsx
    - src/components/ui/*.tsx (60+ UI component files)
    - src/components/common/ReviewModal.tsx
    - src/components/project/*.tsx (7 files)
    - src/utils/helpers/diff-utils.ts (import fix)
    - src/utils/hooks/useRecentProjects/useRecentProjects.ts (import fix)
    - src/utils/hooks/useSshConnectionManager/useSshConnectionManager.ts (import fixes)
    - src/utils/hooks/useSshConnectionsQuery/useSshConnectionsQuery.ts (import fix)
  removed:
    - src/hooks/ (directory)
    - src/lib/ (directory)
    - src/utils/diffParser.ts (moved to helpers)

decisions:
  - "Organize complex hooks in folder structure (hook-name/hook-name.ts + index.ts) for future extensibility"
  - "Keep simple hooks (use-mobile.ts) as single files for minimal overhead"
  - "Use barrel exports (index.ts) for clean imports from @/utils/hooks and @/utils/helpers"
  - "Root utils barrel export re-exports both hooks and helpers for maximum convenience"
  - "Fix all relative imports within utils to use absolute @/ paths for consistency"

metrics:
  tasks_completed: 2
  files_modified: 63
  files_deleted: 8
  hook_folders: 4
  helper_files: 3
  barrel_exports: 3
  old_import_patterns_removed: 58
---

# Phase 19 Plan 05: Organize Utils Layer (Hooks and Helpers) Summary

## Objective

Establish consistent organization for frontend utilities (custom hooks and helper functions) with clear folder structure and barrel exports, making utilities discoverable and maintainable.

## Executive Summary

Successfully reorganized the utils layer from scattered locations (src/hooks/, src/lib/, src/utils/) into a unified, well-organized structure:

**New structure:**
- `src/utils/hooks/` - All custom React hooks with barrel export
- `src/utils/helpers/` - All helper functions with barrel export
- `src/utils/index.ts` - Root barrel export for convenience imports

**Results:**
- 4 complex hooks organized in folder structure with individual exports
- 1 simple hook kept as single file (use-mobile.ts)
- 3 helpers consolidated and re-exported
- 63 files updated with new import paths (no old @/hooks or @/lib imports remain)
- TypeScript compiles without errors
- All functionality preserved

## Tasks Completed

### Task 1: Reorganize hooks and create utils/helpers structure (Commit: 934e0fd)

**What was done:**
1. Created directory structure:
   - `src/utils/hooks/` with 4 complex hook folders + 1 simple hook file
   - `src/utils/helpers/` with 3 helper files

2. Moved and reorganized files:
   - `useProjectPickerNavigation` → `src/utils/hooks/useProjectPickerNavigation/`
   - `useRecentProjects` → `src/utils/hooks/useRecentProjects/`
   - `useSshConnectionManager` → `src/utils/hooks/useSshConnectionManager/`
   - `useSshConnectionsQuery` → `src/utils/hooks/useSshConnectionsQuery/`
   - `use-mobile.ts` → `src/utils/hooks/use-mobile.ts` (single file)
   - `path-utils.ts` → `src/utils/helpers/path-utils.ts`
   - `diffParser.ts` → `src/utils/helpers/diff-utils.ts`
   - `lib/utils.ts` → `src/utils/helpers/ui-utils.ts`

3. Created barrel exports:
   - Each complex hook folder has `index.ts` exporting its hook
   - `src/utils/hooks/index.ts` exports all hooks (simple and complex)
   - `src/utils/helpers/index.ts` exports all helper functions
   - `src/utils/index.ts` re-exports both hooks and helpers

4. Cleaned up old directories:
   - Removed `src/hooks/` directory (files moved to utils/hooks)
   - Removed `src/lib/` directory (files moved to utils/helpers)
   - Removed old `src/utils/diffParser.ts` (moved to helpers)

**Key changes:**
- Structure supports future extension (adding more hooks/helpers is now obvious)
- Barrel exports enable clean imports: `import { useProjectPickerNavigation } from "@/utils/hooks"`
- All complex hooks now have individual folders for potential hook-specific utilities

### Task 2: Update all imports throughout codebase (Commit: 2ad3cba)

**What was done:**
1. Bulk replaced all import paths:
   - 6 `@/hooks/*` imports → `@/utils/hooks`
   - 53 `@/lib/utils` imports → `@/utils/helpers`
   - Fixed relative imports within utils to use absolute `@/` paths

2. Fixed specific import issues:
   - `src/App.tsx`: `./hooks/useRecentProjects` → `@/utils/hooks`
   - `src/components/project/ProjectListItem.tsx`: `../../lib/path-utils` → `@/utils/helpers`
   - `src/components/common/ReviewModal.tsx`: `../../utils/diffParser` → `@/utils/helpers`
   - `src/utils/helpers/diff-utils.ts`: `../types/review` → `@/types/review`
   - `src/utils/hooks/useRecentProjects/useRecentProjects.ts`: `../types/bindings` → `@/types/bindings`
   - `src/utils/hooks/useSshConnectionManager/useSshConnectionManager.ts`:
     - `../types/bindings` → `@/types/bindings`
     - `./useSshConnectionsQuery` → `../useSshConnectionsQuery`
   - `src/utils/hooks/useSshConnectionsQuery/useSshConnectionsQuery.ts`: `../types/bindings` → `@/types/bindings`

3. Updated UI components (60+ files):
   - All `cn` utility imports: `@/lib/utils` → `@/utils/helpers`
   - Example files updated: sidebar, button, card, dialog, tabs, etc.

4. Verification:
   - 0 remaining `@/hooks` imports (58 removed)
   - 0 remaining `@/lib` imports (55 removed)
   - TypeScript compiles without errors

**Impact:**
- Clean, discoverable import patterns throughout codebase
- Absolute paths reduce confusion about relative import depths
- Centralized barrel exports make it obvious where utilities come from

## Verification Results

All success criteria met:

| Criterion | Result | Status |
|-----------|--------|--------|
| Utils structure created | `src/utils/hooks/` + `src/utils/helpers/` | ✓ PASS |
| Complex hooks in folders | 4 folders (useProjectPickerNavigation, useRecentProjects, useSshConnectionManager, useSshConnectionsQuery) | ✓ PASS |
| Simple hooks as files | use-mobile.ts in root hooks | ✓ PASS |
| Helper files consolidated | 3 files (path-utils, diff-utils, ui-utils) | ✓ PASS |
| Barrel exports created | hooks/index.ts, helpers/index.ts, utils/index.ts | ✓ PASS |
| Old @/hooks imports removed | 0 remaining | ✓ PASS |
| Old @/lib imports removed | 0 remaining | ✓ PASS |
| Relative imports fixed | All utils imports use absolute @/ paths | ✓ PASS |
| TypeScript compilation | 0 errors | ✓ PASS |
| Old directories removed | src/hooks/, src/lib/ deleted | ✓ PASS |
| Functionality preserved | All components working correctly | ✓ PASS |

## Deviations from Plan

None - plan executed exactly as written. The plan correctly anticipated the actual hook names (useProjectPickerNavigation instead of useProjectSelection, etc.).

## Architecture Impact

**Before:** Utilities scattered across three locations with inconsistent import patterns
```
src/hooks/useRecentProjects.ts (custom hook)
src/lib/utils.ts (UI utils like cn)
src/lib/path-utils.ts (path utilities)
src/utils/diffParser.ts (diff utilities)
```

**After:** Unified utils layer with clear organization
```
src/utils/
  hooks/
    useProjectPickerNavigation/
      useProjectPickerNavigation.ts
      index.ts
    ... (3 more complex hooks with same structure)
    use-mobile.ts (simple hook)
    index.ts (barrel export)
  helpers/
    path-utils.ts
    diff-utils.ts
    ui-utils.ts
    index.ts (barrel export)
  index.ts (root barrel export)
```

**Benefits:**
1. **Discoverability:** Obvious where to find utilities - `@/utils/hooks` or `@/utils/helpers`
2. **Extensibility:** Complex hooks have folder structure for future co-located utilities (tests, types, etc.)
3. **Consistency:** All imports use absolute paths, no relative import depth confusion
4. **Maintainability:** Single barrel export point makes it easy to manage and refactor utilities
5. **Type Safety:** Barrel exports ensure no circular dependencies, clear dependency graph

## Next Steps

Phase 19-06 (Implement Feature Modules) can now leverage this clean utils layer for feature-specific utilities and hooks.

---

**Execution Time:** 5 minutes (0.09 hours)
**Commits:** 2 atomic commits per task specification
**Status:** Complete - Ready for Phase 19-06
