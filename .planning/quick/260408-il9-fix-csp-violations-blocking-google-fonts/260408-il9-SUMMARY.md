---
phase: quick-260408-il9
plan: 01
subsystem: config
tags: [csp, security, fonts, tauri, ipc]
dependency_graph:
  requires: []
  provides: [google-fonts-csp-allowance, tauri-ipc-csp-allowance]
  affects: [src-tauri/tauri.conf.json]
tech_stack:
  added: []
  patterns: [tauri-csp]
key_files:
  modified:
    - src-tauri/tauri.conf.json
decisions:
  - "Added ipc: and http://ipc.localhost to connect-src to allow Tauri's custom IPC protocol without postMessage fallback"
  - "Added fonts.googleapis.com to style-src and fonts.gstatic.com to font-src to permit Google Fonts Inter stylesheet and woff2 file downloads"
metrics:
  duration: 0.010h
  completed: "2026-04-08"
  tasks_completed: 1
  files_modified: 1
---

# Quick Task 260408-il9: Fix CSP Violations Blocking Google Fonts — Summary

**One-liner:** Extended Tauri CSP with Google Fonts stylesheet/font-file allowances and Tauri IPC custom protocol origins.

## What Was Done

Updated the `app.security.csp` string in `src-tauri/tauri.conf.json` with three targeted additions:

1. `style-src`: appended `https://fonts.googleapis.com` — unblocks the `@import url(...)` in `src/index.css` that fetches the Inter font stylesheet.
2. `connect-src`: inserted `ipc: http://ipc.localhost` — allows Tauri's IPC custom protocol so the webview can use the faster native path instead of falling back to postMessage.
3. `font-src`: appended `https://fonts.gstatic.com` — unblocks the `.woff2` font file downloads served by the Google Fonts CDN.

All existing directives (`https://api.github.com`, `https://*.atlassian.net`, `data:` URIs, `'unsafe-inline'`) are preserved unchanged.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | b10e8b9 | fix(quick-260408-il9-01): add Google Fonts and Tauri IPC allowances to CSP |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — all three additions are outbound-only allow-list expansions to established CDN domains and the Tauri internal IPC origin. No new network endpoints or trust boundaries introduced.

## Self-Check: PASSED

- [x] `src-tauri/tauri.conf.json` exists and is valid JSON
- [x] CSP contains `https://fonts.googleapis.com`
- [x] CSP contains `https://fonts.gstatic.com`
- [x] CSP contains `ipc:` and `http://ipc.localhost`
- [x] Commit b10e8b9 exists in git log
