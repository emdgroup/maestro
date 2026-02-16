---
created: 2026-02-15T12:37
title: Fix keyboard navigation in project picker
area: ui
files:
  - src/components/ProjectPicker.tsx
  - src/components/FilePicker.tsx
---

## Problem

Keyboard navigation in the project picker does not provide the same quality of experience as pointer (mouse) navigation:

**Recent Projects List:**
- Tab key currently tries to select the "remove from list" button and "back to connections" button
- Tab should only jump between recent project entries and the "Select New Project" button
- No keyboard shortcut exists to remove entries (should use Del key)
- No keyboard shortcut exists to go back to connection list (should use Esc key)

**File Picker:**
- Keyboard navigation does not match the pointer interaction experience
- Specific issues not detailed, needs investigation

This creates an inconsistent and less accessible user experience for keyboard-only users.

## Solution

**Recent Projects List:**
1. Update tab navigation to skip auxiliary buttons (remove, back to connections)
2. Add Del key handler to remove the currently focused project entry
3. Add Esc key handler to navigate back to connection list
4. Ensure focus indicators are visible for keyboard navigation

**File Picker:**
1. Investigate current keyboard navigation behavior
2. Identify gaps compared to pointer interaction
3. Implement missing keyboard shortcuts and navigation patterns
4. Ensure consistent experience across both input methods

Consider accessibility best practices (WCAG 2.1 keyboard navigation guidelines).
