---
created: 2026-02-16T09:06
title: Remove Appearance card and add theme switch to app header
area: ui
files:
  - src/components/SettingsPage.tsx
  - src/components/AppHeader.tsx
---

## Problem

Currently, the theme switcher is located in the Settings page as part of an "Appearance" card/section. This placement makes theme switching less accessible and takes up valuable space on the Settings page.

Users need to navigate to Settings just to change the theme, which is a common action that should be more readily available.

## Solution

1. Remove the Appearance card/section from SettingsPage.tsx
2. Add a theme switch button as an icon in AppHeader.tsx
3. Use a sun/moon icon or similar to indicate theme toggle
4. Integrate with existing ThemeProvider context
5. Position near other header controls (e.g., next to project dropdown)

The icon should be compact, accessible, and provide visual feedback on the current theme.
