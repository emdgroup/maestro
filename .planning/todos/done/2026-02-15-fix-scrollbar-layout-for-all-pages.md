---
created: 2026-02-15T09:00
title: Fix scrollbar layout for all pages below action bar
area: ui
files:
  - src/App.tsx:231-262
  - src/components/SettingsPage.tsx:188-355
  - src/components/ActionBar.tsx
  - src/index.css:139-161
---

## Problem

The scrollbar behavior is inconsistent across the application pages. Currently, scrolling may affect the entire page viewport including the header and action bar, rather than being constrained to just the content area below the action bar.

**Current behavior:**
- The settings screen and potentially other pages have scrollbar issues
- Scrolling may affect elements that should remain fixed (AppHeader, ActionBar)
- Not all scrollable areas use the `.custom-scrollbar` style defined in index.css

**Expected behavior:**
For all pages (Tasks, Agents, Worktrees, Settings):
1. AppHeader should remain fixed at the top (no scrolling)
2. ActionBar should remain fixed below the header (no scrolling)
3. Only the main content area below the ActionBar should scroll
4. All scrollable content areas should use `.custom-scrollbar` class for consistent styling

**Visual layout:**
```
┌─────────────────────┐
│   AppHeader (fixed) │
├─────────────────────┤
│  ActionBar (fixed)  │
├─────────────────────┤
│                     │
│   Scrollable        │ ← Only this area scrolls
│   Content           │    with .custom-scrollbar style
│   Area              │
│                     │
└─────────────────────┘
```

## Solution

1. **Fix layout structure in App.tsx:**
   - Ensure the main content area (lines 232-262) has proper overflow handling
   - Content area should have `overflow-auto` class
   - Add `.custom-scrollbar` class to scrollable main content area
   - Verify flex layout: AppHeader and ActionBar should not scroll, only `<main>` should scroll

2. **Update SettingsPage.tsx:**
   - The outer container (line 188) has `overflow-auto` on the full page
   - Move overflow handling to inner content only
   - Apply `.custom-scrollbar` class to the scrollable container

3. **Apply to all page components:**
   - KanbanBoard
   - AgentMonitor
   - WorktreeManager
   - SettingsPage

   Each should:
   - Use `h-full overflow-auto custom-scrollbar` on their root container
   - Ensure content can scroll independently of header/action bar

4. **Verify .custom-scrollbar style:**
   - Already defined in index.css (lines 139-161)
   - Includes webkit-scrollbar styles for Chrome/Safari
   - Has fallback scrollbar-width/scrollbar-color for Firefox
   - Theme-aware using CSS variables

5. **Testing checklist:**
   - Navigate to each page (Tasks, Agents, Worktrees, Settings)
   - Verify AppHeader stays fixed when scrolling
   - Verify ActionBar stays fixed when scrolling
   - Verify only content area scrolls
   - Verify consistent scrollbar appearance across all pages
   - Test in both light and dark themes
