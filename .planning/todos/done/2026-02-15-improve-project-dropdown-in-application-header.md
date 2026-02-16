---
created: 2026-02-15T02:13
title: Improve project dropdown in application header
area: ui
files:
  - src/components/AppHeader.tsx
---

## Problem

The project dropdown in the application header currently has several UX limitations:

1. Fixed width that doesn't adapt to the length of the project name
2. Shows all recent projects regardless of which connection they belong to (should filter by current connection)
3. Simple text list display - needs richer UI with project name and path visible
4. No way to navigate back to the project picker screen from the dropdown

These limitations make project switching less intuitive, especially when working with multiple connections or projects with long names.

## Solution

Implement the following improvements to the project dropdown:

1. **Adaptive sizing**: Dropdown should dynamically adjust its width based on the project name length
2. **Connection filtering**: Only display recent projects that belong to the same connection as the currently selected project
3. **Card-based list items**: Each project in the dropdown should be a card showing:
   - Project name (prominent)
   - Project path (secondary, below the name)
4. **Project picker navigation**: Add a separated option at the bottom of the dropdown list that navigates back to the project picker screen

This will require updates to the AppHeader component and potentially the project/connection data structure to support connection-based filtering.
