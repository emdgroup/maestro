---
created: 2026-02-15T12:47
title: Fix directional slide animation for tab transitions
area: ui
files:
  - src/App.tsx
---

## Problem

The slide animation transition was added to the content pane of the tabs but it does not work as expected. Currently, the animation does not respect the direction of tab navigation.

**Expected behavior:**
- When user clicks on a tab to the **right** of the current tab: current tab should slide out to the left, new tab should slide in from the right
- When user clicks on a tab to the **left** of the current tab: current tab should slide out to the right, new tab should slide in from the left

**Current behavior:**
- Animation direction is not based on the relative position of tabs
- Creates a disorienting user experience where the animation doesn't match the spatial relationship of the tabs

This breaks the natural mental model where content should flow in the direction matching the tab navigation.

## Solution

Implement bidirectional slide animations:

1. Track the previous tab index and current tab index
2. Compare indices to determine direction (left/right)
3. Apply different CSS animation classes based on direction:
   - Right direction: `slide-out-left` + `slide-in-right`
   - Left direction: `slide-out-right` + `slide-in-left`
4. Update the transition logic in App.tsx to conditionally apply animation classes

Consider using Framer Motion or CSS transitions with dynamic class names based on navigation direction.
