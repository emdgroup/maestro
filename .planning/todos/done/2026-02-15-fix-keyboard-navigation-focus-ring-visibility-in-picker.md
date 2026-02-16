---
created: 2026-02-15T02:31
title: Fix keyboard navigation focus ring visibility in picker
area: ui
files:
  - src/components/ProjectPicker.tsx
  - src/components/RemoteProjectsList.tsx
  - src/components/ConnectionList.tsx
---

## Problem

The project picker screen (and potentially other picker/selection screens) has a keyboard accessibility issue where the focus ring is not properly displayed when navigating with the Tab key:

**Symptoms:**
- When user navigates through options using the Tab key, the focus ring is partially hidden/clipped
- The focus ring is not fully visible around the focused element
- Mouse hover states work correctly and display properly
- This creates an accessibility barrier for keyboard-only users who cannot see which element has focus

**Impact:**
- Poor keyboard accessibility experience
- WCAG compliance concern (keyboard navigation should have clear visual focus indicators)
- Keyboard-only users may struggle to know which element is currently focused

This is likely a CSS z-index or overflow issue where parent containers are clipping the focus ring outline, or the focus ring styling needs adjustment to ensure it's always visible above other elements.

## Solution

Investigate and fix the focus ring visibility:

1. **Reproduce the issue**: Navigate through the picker screen with Tab key to observe the clipping behavior
2. **Identify the cause**: Check CSS properties that might clip the focus ring:
   - `overflow: hidden` on parent containers
   - Z-index stacking issues
   - Insufficient padding/spacing around focusable elements
   - Border-box sizing cutting off outline
3. **Fix the styling**:
   - Ensure focus rings use `outline` (not `border`) so they render outside the box model
   - Add sufficient padding/spacing to parent containers to accommodate focus rings
   - Adjust z-index if needed to ensure focus indicators appear above siblings
   - Consider using `outline-offset` for better visual separation
4. **Test thoroughly**:
   - Verify Tab navigation shows clear focus rings on all interactive elements
   - Test in both light and dark themes
   - Ensure mouse hover states still work correctly
   - Verify focus ring contrast meets WCAG AA standards

This likely affects ProjectPicker, RemoteProjectsList, and ConnectionList components where users select options.
