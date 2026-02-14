---
created: 2026-02-14T03:28
completed: 2026-02-14T03:35
title: Refactor LocalProjectsList and RemoteProjectsList components
area: ui
files:
  - src/components/LocalProjectsList.tsx
  - src/components/RemoteProjectsList.tsx
  - src/components/ProjectListItem.tsx
  - src/lib/path-utils.ts
---

## Problem

LocalProjectsList.tsx and RemoteProjectsList.tsx have significant code duplication. Both components likely share similar patterns for:
- Rendering project lists
- Handling project selection
- Displaying project metadata
- Managing component state

This duplication increases maintenance burden and makes it harder to ensure consistent behavior across both list types.

## Solution

**Implemented:** Extract shared components approach (composition over merging)

### Changes Made:

1. **Created `src/lib/path-utils.ts`**
   - Extracted `getFolderName` utility function (used by both components)
   - Added JSDoc documentation

2. **Created `src/components/ProjectListItem.tsx`**
   - Extracted identical list item rendering logic (~27 lines of duplication)
   - Handles project display, click events, and remove functionality
   - Reusable by both LocalProjectsList and RemoteProjectsList

3. **Refactored `LocalProjectsList.tsx`**
   - Removed duplicate `getFolderName` function
   - Replaced inline list item rendering with `<ProjectListItem />`
   - Reduced from 100 to 76 lines (-24%)

4. **Refactored `RemoteProjectsList.tsx`**
   - Removed duplicate `getFolderName` function
   - Replaced inline list item rendering with `<ProjectListItem />`
   - Reduced from 176 to 152 lines (-14%)

### Benefits:

✅ **~50 lines of duplicate code eliminated**
✅ **Consistent list item behavior** - changes in one place affect both
✅ **Better maintainability** - single source of truth for project list items
✅ **Preserved separation of concerns** - local/remote logic stays distinct
✅ **Build verified** - TypeScript compilation and bundle verification passed

### Why This Approach:

- Components have distinct purposes (local vs remote with SSH connection editing)
- Extraction preserves type safety while eliminating duplication
- Composition over merging keeps components focused and understandable
- Future changes to list item styling/behavior only need one edit
