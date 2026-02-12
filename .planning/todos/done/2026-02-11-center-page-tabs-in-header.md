---
created: 2026-02-11T14:28
title: Center page tabs in header
area: ui
files:
  - src/components/AppHeader.tsx
---

## Problem

The page navigation tabs (Tasks, Agents, Worktrees, Settings) in the AppHeader component are currently left-aligned. For better visual balance and modern app aesthetics, the tabs should be centered horizontally in the header.

Current layout (from Phase 17.1-02):
- Project dropdown on the left
- Navigation tabs next to project dropdown (left-aligned)
- Results in unbalanced visual weight

Desired layout:
- Project dropdown on the left
- Navigation tabs centered in the available header space
- Creates balanced, symmetrical header design

This is a common pattern in modern applications where primary navigation is visually centered to emphasize its importance and create visual harmony.

## Solution

Update AppHeader.tsx layout to center the tab navigation:

1. **Use flexbox for centering:**
   - Wrap tabs in a container div
   - Apply `flex-1 flex justify-center` to center container
   - Keep project dropdown in separate container on left
   - Optionally add spacer on right for perfect symmetry

2. **Implementation approach:**
   ```tsx
   <header className="flex items-center h-12 px-4 border-b">
     {/* Left: Project dropdown */}
     <div className="flex-shrink-0">
       <Select>...</Select>
     </div>

     {/* Center: Navigation tabs */}
     <div className="flex-1 flex justify-center">
       <Tabs>...</Tabs>
     </div>

     {/* Right: Optional spacer for symmetry */}
     <div className="flex-shrink-0 w-[200px]"></div>
   </header>
   ```

3. **Considerations:**
   - Ensure responsive behavior on smaller screens
   - Test that tabs remain clickable and don't overlap
   - Maintain proper spacing and padding
   - Verify active tab indicator remains visible
   - Check alignment with dark/light theme

Alternative: Use CSS Grid with three columns (left/center/right) for precise control over spacing.
