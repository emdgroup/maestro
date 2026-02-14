---
created: 2026-02-14T03:28
completed: 2026-02-14T03:45
title: Refactor LocalProjectsList and RemoteProjectsList components
area: ui
files:
  - src/components/LocalProjectsList.tsx
  - src/components/RemoteProjectsList.tsx
  - src/components/ProjectListItem.tsx
  - src/components/ProjectsListLayout.tsx
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

---

## Phase 2: Extract Layout Wrapper (2026-02-14)

User feedback indicated that composition could be taken further to eliminate additional presentation duplication.

### Additional Changes:

5. **Created `src/components/ProjectsListLayout.tsx`**
   - Extracted common layout structure (header with back button, scrollable content, footer with action button)
   - Uses composition pattern with `headerContent` slot and `children` for list items
   - Handles empty state rendering
   - ~40 additional lines of structure duplication eliminated

6. **Further refactored `LocalProjectsList.tsx`**
   - Now uses `<ProjectsListLayout>` wrapper component
   - Only contains local-specific logic: filtering, header content (Folder icon + "Local" title)
   - Reduced from 76 to 52 lines (total reduction: 100 → 52 = **-48%, 48 lines saved**)

7. **Further refactored `RemoteProjectsList.tsx`**
   - Now uses `<ProjectsListLayout>` wrapper component
   - Only contains remote-specific logic: filtering by connection, inline editing functionality
   - Reduced from 152 to 128 lines (total reduction: 176 → 128 = **-27%, 48 lines saved**)

### Total Impact:

✅ **~96 lines of duplicate code eliminated** (across both components)
✅ **Single source of truth for entire layout structure**
✅ **Highly composable** - header content can be customized while layout stays consistent
✅ **Maximum maintainability** - layout changes propagate to both components automatically
✅ **Components now focus on their unique logic** - filtering and header customization only
✅ **Build verified** - TypeScript compilation and bundle verification passed

### Final Component Sizes:

- `LocalProjectsList.tsx`: 100 → 52 lines (**-48%**)
- `RemoteProjectsList.tsx`: 176 → 128 lines (**-27%**)
- New shared code: 3 small, focused, reusable components

This demonstrates effective composition: extract common patterns into small building blocks, let consumers compose them with unique behavior.
