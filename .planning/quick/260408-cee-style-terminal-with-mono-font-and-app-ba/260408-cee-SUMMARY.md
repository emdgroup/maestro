---
phase: quick-260408-cee
plan: 01
subsystem: execution-ui
tags: [terminal, theme, xterm, css-vars, fonts]
dependency_graph:
  requires: []
  provides: [terminalTheme helper, themed xterm terminals]
  affects: [Terminal.tsx, DeadSessionTerminal.tsx]
tech_stack:
  added: []
  patterns: [css-var computed-style trick for oklch→rgb resolution]
key_files:
  created:
    - src/utils/helpers/terminalTheme.ts
  modified:
    - src/components/execution/Terminal.tsx
    - src/components/execution/DeadSessionTerminal.tsx
decisions:
  - CSS var resolution via temporary invisible div — browser resolves oklch→rgb automatically, no manual conversion needed
  - getTerminalTheme() called inside useEffect so DOM theme class (.dark/light) is applied before reading vars
  - spread operator merges theme into Terminal options; cursorBlink/scrollback/disableStdin overridden cleanly
metrics:
  duration: 0.008h
  completed: "2026-04-08"
  tasks_completed: 2
  files_modified: 3
---

# Phase quick-260408-cee Plan 01: Terminal Theme Integration Summary

**One-liner:** xterm.js terminals now use Fira Code font and app background/foreground colors derived from CSS custom properties at mount time.

## What Was Built

A shared `getTerminalTheme()` helper reads `--background`, `--foreground`, and `--accent` CSS variables via the browser's computed style API (invisible div trick). This resolves oklch color values to rgb strings that xterm.js accepts. Both live (`Terminal.tsx`) and replay (`DeadSessionTerminal.tsx`) terminal components spread the result into their `new Terminal()` options.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create terminalTheme helper | 8da6785 | src/utils/helpers/terminalTheme.ts |
| 2 | Apply theme to both terminal components | a42b809 | Terminal.tsx, DeadSessionTerminal.tsx |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — reads only the app's own CSS variables from its own document; no cross-origin or user-controlled input.

## Self-Check: PASSED

- `src/utils/helpers/terminalTheme.ts` exists and exports `getTerminalTheme`
- `Terminal.tsx` imports and calls `getTerminalTheme()`
- `DeadSessionTerminal.tsx` imports and calls `getTerminalTheme()`
- `pnpm tsc --noEmit` completed with 0 errors
- Commits 8da6785 and a42b809 present in git log
