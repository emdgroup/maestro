---
created: 2026-02-24T12:37
title: Fix FilePicker dialog width and migrate breadcrumb
area: ui
files:
  - src/components/FilePicker.tsx
  - src/components/ui/breadcrumb.tsx
---

## Problem

The FilePicker component is displayed in a dialog that is not wide enough, making it difficult for users to navigate and read file paths. Additionally, the FilePicker uses a custom breadcrumb implementation instead of leveraging the standardized Breadcrumb component from the design system (src/components/ui/breadcrumb.tsx), leading to inconsistent UI patterns and duplicated code.

## Solution

1. Increase the dialog width in the component that renders FilePicker to provide better readability and usability
2. Replace the custom breadcrumb implementation in FilePicker with the standard Breadcrumb component from src/components/ui/breadcrumb.tsx
3. Ensure the migrated breadcrumb maintains all existing functionality (navigation, path display, click handlers)
