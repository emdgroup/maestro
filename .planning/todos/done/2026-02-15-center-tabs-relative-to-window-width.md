---
created: 2026-02-15T21:12
title: Center tabs relative to window width
area: ui
files:
  - src/components/AppHeader.tsx
---

## Problem

The tab navigation in the main application header is currently centered relative to the available space between the project dropdown and the right-side element, rather than being centered relative to the full window width.

This causes the tabs to shift horizontally when the project name changes:
- Longer project names make the dropdown wider, reducing the available space and shifting tabs to the right
- Shorter project names make the dropdown narrower, increasing the available space and shifting tabs to the left

This creates a visually jarring experience where the tabs appear to "jump" when switching between projects, rather than maintaining a stable, centered position in the window.

## Solution

Adjust the flexbox/CSS layout in AppHeader to position the tabs relative to the full window width instead of the available space between flanking elements.

Possible approaches:
1. Use absolute positioning or CSS grid to center tabs relative to viewport
2. Use a three-column flex layout with equal flex-grow values to ensure tabs stay in the visual center
3. Use CSS `position: absolute` with `left: 50%; transform: translateX(-50%)` on the tabs container

The solution should maintain responsive behavior and work across different window sizes.
