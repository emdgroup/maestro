---
created: 2026-02-11T14:24
title: Convert project settings from modal to page
area: ui
files:
  - src/components/ProjectSettingsModal.tsx
  - src/App.tsx
  - src/components/AppHeader.tsx
---

## Problem

The project settings currently displays as a modal dialog (ProjectSettingsModal.tsx), which is not the ideal UX pattern for a settings interface. Modal dialogs are best for short-form interactions, confirmations, or focused tasks that require user attention before continuing.

Settings pages typically benefit from a full-page layout because:
- They contain multiple sections and configuration options
- Users may want to reference other parts of the app while adjusting settings
- Settings don't require blocking the main UI workflow
- Full pages provide more space for clear organization and visual hierarchy
- Users expect settings to be a navigable destination, not an overlay

Current issues:
- Modal dialog interrupts workflow with overlay backdrop
- Limited space for organizing settings sections
- No persistent URL route for settings (can't bookmark or direct link)
- Inconsistent with modern app navigation patterns (tab-based navigation from Phase 17.1-02)

## Solution

Refactor ProjectSettingsModal.tsx into a full settings page:

1. **Create Settings page component:**
   - Rename/convert `ProjectSettingsModal.tsx` to `SettingsPage.tsx`
   - Remove Dialog/modal wrapper components
   - Update to full-page layout with proper padding and max-width constraints
   - Keep existing settings sections (theme selector, project info, etc.)

2. **Update navigation:**
   - The "Settings" tab in AppHeader (from Phase 17.1-02) already exists
   - Ensure clicking "Settings" tab sets `activePage` state to "Settings"
   - Remove any modal trigger buttons from header/other components

3. **Update App.tsx routing:**
   - Add "Settings" to the page routing switch statement
   - Render `<SettingsPage />` when `activePage === "Settings"`
   - Remove ProjectSettingsModal dialog component

4. **Layout considerations:**
   - Use consistent page layout with other full-page views (Tasks, Agents, Worktrees)
   - Add page header with title "Settings" and optional breadcrumb
   - Organize settings into clear sections with visual separation
   - Maintain responsive design and dark mode support

5. **State management:**
   - Settings state already persists via Tauri IPC (theme preference, etc.)
   - No changes needed to persistence layer
   - Update any click handlers that opened the modal to navigate to settings page instead

This aligns with the modern navigation patterns established in Phase 17.1-02 and provides a better UX for settings management.
