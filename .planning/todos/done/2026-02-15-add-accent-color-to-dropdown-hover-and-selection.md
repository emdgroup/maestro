---
created: 2026-02-15T21:19
title: Add accent color to dropdown hover and selection
area: ui
files:
  - src/components/AppHeader.tsx
---

## Problem

The recent project list dropdown in the application header lacks visual feedback using the system accent color:

1. **Hover state**: Project option cards don't show an accent-colored outline when hovered
   - The "Back to Project Picker" option (last item) should be excluded as it's not a card-style element
   - Only the actual project cards should get the accent outline on hover

2. **Selection indicator**: The checkmark icon for the currently selected project doesn't use the accent color
   - Should use the system accent color to match the app's theme system

This reduces visual consistency with the rest of the UI, which uses system accent colors for interactive states and selection indicators.

## Solution

1. Add `hover:ring-2 hover:ring-accent` (or similar) to the project card elements in the dropdown content
2. Exclude the hover style from the "Back to Project Picker" option
3. Change the checkmark icon color from the current color to `text-accent` for the selected project indicator

This follows the established pattern from Phase 17.1-03 where system accent color was integrated throughout the app via CSS variables.
