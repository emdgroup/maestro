---
created: 2026-02-15T21:15
title: Improve dropdown contrast with bg-muted
area: ui
files:
  - src/components/AppHeader.tsx
---

## Problem

The project dropdown in the application header lacks sufficient visual contrast with the surrounding elements, making it harder to distinguish from the background.

The shadcn/ui design system provides a `bg-muted` class specifically for creating subtle contrast in UI elements like dropdowns, but it's not currently being applied to the dropdown component.

## Solution

Apply the `bg-muted` Tailwind class to the dropdown element in AppHeader.tsx to improve visual contrast and better distinguish the dropdown from surrounding header elements.

This follows the shadcn/ui design patterns for creating visual hierarchy with muted backgrounds on interactive controls.
