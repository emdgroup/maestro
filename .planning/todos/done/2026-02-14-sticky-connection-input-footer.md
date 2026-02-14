---
created: 2026-02-14T03:57
completed: 2026-02-14T04:10
title: Make connection input section stick to bottom of card
area: ui
files:
  - src/components/ConnectionList.tsx
  - src/components/ProjectPickerNew.tsx:313
---

## Problem

In the connections view (ConnectionList component), the section containing the connection input field and "Add Connection" button should stick to the bottom of the card, similar to how the "Select New Project" button sticks to the bottom in the ProjectsListLayout component.

Currently, the input section scrolls with the content, which may not provide the best UX when there are many connections listed. The input controls should remain accessible at all times.

## Solution

**Implemented:** Fixed parent container flexbox layout in ProjectPickerNew.tsx

### Root Cause

ConnectionList component already had the correct sticky footer pattern implemented:
- Parent: `flex flex-col h-full`
- Scrollable middle: `flex-1 overflow-auto mb-4`
- Sticky footer: `pt-4 border-t border-border`

However, the wrapper div in ProjectPickerNew.tsx (line 313) had `flex-col h-full` but was **missing the `flex` class**. Without `flex`, the flexbox layout doesn't activate, so the sticky footer pattern couldn't work.

### Change Made

Updated ProjectPickerNew.tsx line 313:
```tsx
// Before
className={`transition-transform duration-300 ease-in-out flex-col h-full ${

// After
className={`transition-transform duration-300 ease-in-out flex flex-col h-full ${
```

Added the `flex` class to enable the flexbox layout. Now the connection input section properly sticks to the bottom of the card, remaining accessible even when the connection list scrolls.

### Result

✅ Connection input footer now sticky at bottom
✅ ConnectionList can scroll independently when many connections exist
✅ Input controls remain accessible at all times
✅ Build verified - TypeScript compilation and bundle verification passed
