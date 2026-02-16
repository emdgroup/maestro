---
created: 2026-02-15T02:24
title: Fix settings screen save buttons and dropdown styling
area: ui
files:
  - src/App.tsx
  - src/components/AppHeader.tsx
---

## Problem

The settings screen currently has two UI issues that impact usability and visual consistency:

### 1. Duplicate Save Buttons
There are currently two "Save" buttons on the settings screen:
- One at the bottom of the settings form
- Another in the action bar at the top

This duplication is confusing for users and creates uncertainty about which button to use. Only the action bar button should remain, and it must be fully functional to persist all settings changes.

### 2. Inconsistent Dropdown Styling
The dropdown elements (Select components) on the settings screen have inconsistent styling compared to the project dropdown in the header bar. This creates a disjointed visual experience where similar UI elements look different depending on their location.

## Solution

Implement the following fixes:

1. **Remove duplicate save button**:
   - Keep only the save button in the action bar
   - Remove the save button at the bottom of the settings form
   - Verify that the action bar save button correctly invokes all settings persistence logic (likely `save_settings` IPC command)
   - Ensure all settings fields (theme, model defaults, MCP defaults, skills defaults) are properly saved

2. **Standardize dropdown styling**:
   - Audit the Select components on the settings screen
   - Apply the same styling/variant used in the header bar's project dropdown
   - Ensure consistent appearance (padding, borders, background, focus states, etc.)
   - This should use the shadcn/ui Select component with consistent Tailwind classes

This will require reviewing the Settings component structure in App.tsx and ensuring action bar integration follows the same pattern as other screens (Tasks, Agents, Worktrees).
