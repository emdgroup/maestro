---
created: 2026-02-11T11:34
title: Fix application access after project folder selection
area: ui
files:
  - src/App.tsx
  - src/components/ProjectPicker.tsx
---

## Problem

Users report being unable to access the main application interface after selecting a local project folder through the ProjectPicker component. The project selection flow appears to complete, but the application does not transition to the main Kanban board view.

This issue affects the core onboarding experience and prevents users from accessing any functionality after initial project setup.

Potentially related to:
- Project state persistence after selection
- Project validation logic
- UI state transitions in App.tsx between ProjectPicker and main interface
- IPC communication between frontend and backend for project initialization

## Solution

TBD - Needs investigation to determine root cause:
1. Check if project data is properly persisted to database after selection
2. Verify state transitions in App.tsx after project selection
3. Review IPC handlers for project creation/loading
4. Check console for any errors during project selection flow
5. Test with Playwright e2e tests to reproduce and verify fix
