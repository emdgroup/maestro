---
created: 2026-02-13T09:44:48
title: Refine project picker hover states
area: ui
files:
  - src/components/ProjectPicker.tsx
---

## Problem

The accent color is too strong when hovering over elements on the project selection screens. The current implementation likely uses the accent color as a background, which creates an overpowering visual effect that doesn't feel polished or subtle.

The hover states need to be more refined and elegant, providing clear feedback without overwhelming the user interface.

## Solution

Explore alternative hover indication approaches:

1. **Icon color approach**: Instead of changing the background color, change only the icon color to use the accent color on hover. This provides visual feedback while maintaining a cleaner, more subtle aesthetic.

2. **Primary action button**: Ensure the "Select New Project" button prominently uses the accent color to emphasize it as the primary action. This creates a clear visual hierarchy where the accent color draws attention to the main action rather than every hover state.

3. **Testing**: Verify the new hover states feel responsive and polished while respecting the system accent color integration established in Phase 17.1-03.
