---
created: 2026-02-11T14:08
title: Fix system accent color usage
area: ui
files:
  - src/components/ThemeProvider.tsx
  - src/index.css
---

## Problem

The system accent color integration implemented in Phase 17.1-03 may not be functioning correctly. According to STATE.md, the implementation includes:
- Accent color loaded from system theme in ThemeProvider
- CSS variables injected dynamically on mount
- Theme changes update accent color in real-time

However, there appears to be an issue with how the accent color is being used or applied in the application.

Possible issues to investigate:
- Accent color CSS variable not being applied to UI elements
- Incorrect CSS variable name or scope
- Accent color not updating when system theme changes
- Missing fallback colors when accent color is unavailable
- Contrast/accessibility issues with accent color usage
- Accent color not respecting light/dark mode context

## Solution

TBD - Needs investigation:
1. Review ThemeProvider.tsx accent color loading logic
2. Check CSS variable injection and naming (`--accent`, `--accent-foreground`, etc.)
3. Verify accent color is being applied to relevant UI components
4. Test accent color updates when system theme changes
5. Ensure WCAG AA contrast compliance with accent color
6. Add fallback colors if system accent color is unavailable
7. Verify behavior across light/dark modes
8. Check DevTools for CSS variable values at runtime
