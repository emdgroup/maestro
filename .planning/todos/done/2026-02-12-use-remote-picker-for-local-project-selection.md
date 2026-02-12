---
created: 2026-02-12T13:38
title: Use remote picker for local project selection
area: ui
files:
  - src/components/LocalSection.tsx
  - src/components/RemoteSection.tsx
  - src/components/ProjectPicker.tsx
  - src/components/ProjectPickerNew.tsx
---

## Problem

Currently using different UI patterns for local vs remote project selection with two separate panels. This creates visual inconsistency and a fragmented user experience. The split layout makes the interface feel more complex than necessary.

## Solution

Merge local and remote sections into a single unified connection list where:
- First element is "Local" connection (with Folder icon, not Server icon)
- Local connection behaves the same as SSH connections (click to show projects/file picker)
- SSH connections follow below in the same list
- Single panel layout instead of split grid
- Consistent interaction pattern across all connection types
- Unified, cleaner interface
