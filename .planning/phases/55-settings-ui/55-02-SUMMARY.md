---
phase: 55-settings-ui
plan: "02"
subsystem: frontend
tags:
  - ticketing
  - integration
  - react
  - tanstack-query
  - project-picker
  - settings
dependency_graph:
  requires:
    - 55-01 (IntegrationStatus, ProjectTicketingConfig IPC types and handlers)
  provides:
    - integration.service.ts with 5 TanStack Query hooks
    - IntegrationsTab component (2-column provider grid)
    - IntegrationConnectDialog component (per-provider credential entry)
    - ProjectPicker with tabbed Connections/Integrations view
    - SettingsPage Ticketing card with inline picker and project-specific fields
  affects:
    - src/services/
    - src/components/project-picker/
    - src/components/common/SettingsPage.tsx
tech_stack:
  added: []
  patterns:
    - TanStack Query hooks for integration CRUD (useQuery + useMutation)
    - "@base-ui/react/tabs Tabs component (not radix)"
    - Three-state Ticketing card (no integrations / picker / configured)
    - useImperativeHandle save() extended with ticketing mutation
key_files:
  created:
    - src/services/integration.service.ts
    - src/components/project-picker/IntegrationsTab.tsx
    - src/components/project-picker/IntegrationConnectDialog.tsx
  modified:
    - src/components/project-picker/ProjectPicker.tsx
    - src/components/common/SettingsPage.tsx
decisions:
  - "PROVIDER_NAMES map defined locally in both IntegrationsTab and SettingsPage rather than shared constant — avoids creating extra shared file; both are short and stable"
  - "ticketingEditing flag added to SettingsPage to support Change button transitioning back to picker state from configured state — not in plan spec but required for correct UX flow"
  - "getTicketingFields defined as function inside render scope of SettingsPage component — avoids module-level export pollution while keeping logic close to usage"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-23"
  tasks_completed: 2
  files_changed: 5
---

# Phase 55 Plan 02: Integration UI and Project Ticketing Settings Summary

Frontend for global integration management and project ticketing configuration — 2-column provider grid on connection screen, per-provider credential dialog, and inline ticketing picker in project settings with 7 provider support.

## What Was Built

### Task 1: Integration service + IntegrationsTab + IntegrationConnectDialog + tabbed ProjectPicker

Created `src/services/integration.service.ts` with 5 TanStack Query hooks:
- `useListIntegrations` — queries all 7 provider statuses (30s stale)
- `useSaveIntegration` — mutates and invalidates list cache
- `useDeleteIntegration` — mutates and invalidates list cache
- `useProjectTicketingConfig` — project-scoped ticketing config (staleTime: Infinity)
- `useSaveProjectTicketingConfig` — mutates and invalidates project ticketing cache

Created `src/components/project-picker/IntegrationsTab.tsx`:
- 2-column grid (`grid grid-cols-2 gap-2`) of all 7 provider cards
- Connected state: emerald dot, display_name, X disconnect button (disabled + titled for gh CLI sources)
- Disconnected state: muted dot, Plus connect button
- gh CLI badge: `<span>gh cli</span>` shown next to display_name when `source === "gh_cli"`
- Integrates with `IntegrationConnectDialog` via `connectProvider` state

Created `src/components/project-picker/IntegrationConnectDialog.tsx`:
- Per-provider field sets: GitHub/Forgejo (token only), GitLab/Forgejo (instance URL + token), Jira Cloud (site URL + email + API token), Jira Server (base URL + API token), Azure DevOps (org URL + PAT), Linear (API key only)
- Token field always `type="password"` (T-55-07 mitigation)
- On success: closes dialog, cache invalidated. On error: inline error state
- Submit disabled when `isPending || !token.trim()`

Modified `src/components/project-picker/ProjectPicker.tsx`:
- Wrapped ConnectionList in `@base-ui/react/tabs` Tabs with "Connections" and "Integrations" tabs
- Slide transition mechanism (`-translate-x-full` / `translate-x-0` / `translate-x-full`) unchanged
- IntegrationsTab rendered in `TabsContent value="integrations"`

### Task 2: Ticketing card in SettingsPage

Modified `src/components/common/SettingsPage.tsx`:
- Added `useListIntegrations`, `useProjectTicketingConfig`, `useSaveProjectTicketingConfig` hooks
- `useEffect` initializes local ticketing state from loaded config on mount/change
- Ticketing card with three states:
  - **State A (no connected integrations)**: "No integrations connected" message
  - **State B (picker)**: Connected providers as clickable cards; selecting a card expands provider-specific fields below; supports returning from configured state via "Change" button
  - **State C (configured)**: Selected provider card highlighted, project fields shown read-only; "Change" button (returns to State B) and "Remove" button (calls `saveProjectTicketingConfig(null)`)
- `useImperativeHandle` `save()` extended: after agent/model save, also saves ticketing config if `selectedProvider` is set
- Provider-specific fields wired for all 7 providers (owner/repo, project_path, team_id, project_key, project_name)

## Deviations from Plan

### Auto-added Missing Functionality

**1. [Rule 2 - Missing] Added `ticketingEditing` state for Change button UX**
- **Found during:** Task 2 implementation
- **Issue:** Plan spec State B/C transitions required a way to return from configured state to picker state. Without `ticketingEditing`, clicking "Change" had no mechanism to show the picker again since `ticketingConfigured` would still be true.
- **Fix:** Added `ticketingEditing: boolean` state. "Change" sets it to `true`, showing State B. Successful remove resets it to `false`.
- **Files modified:** `src/components/common/SettingsPage.tsx`
- **Commit:** 952b00f

## Threat Surface Scan

All threat flags from the plan's threat register are addressed:

| Flag | File | Mitigation |
|------|------|------------|
| T-55-06 Tampering | IntegrationConnectDialog.tsx | Frontend sends raw input to Rust; no frontend validation; all validation in `validate_credentials` handler |
| T-55-07 Information Disclosure | IntegrationConnectDialog.tsx | Token field uses `type="password"`; token never stored in React state beyond dialog lifecycle (reset on close) |
| T-55-08 Information Disclosure | integration.service.ts | Only `IntegrationStatus` (display_name + connected bool) cached in React Query; no tokens in frontend memory |

No new threat surface introduced beyond the plan's threat register.

## Known Stubs

None — all 7 providers fully implemented in both IntegrationsTab and SettingsPage. All field mappings are wired to real IPC calls.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src/services/integration.service.ts` | FOUND |
| `src/components/project-picker/IntegrationsTab.tsx` | FOUND |
| `src/components/project-picker/IntegrationConnectDialog.tsx` | FOUND |
| `src/components/project-picker/ProjectPicker.tsx` (modified) | FOUND |
| `src/components/common/SettingsPage.tsx` (modified) | FOUND |
| Task 1 commit `98d8c7c` | FOUND |
| Task 2 commit `952b00f` | FOUND |
| `pnpm test --run` | 148 passed (17 test files) |
| `pnpm lint` (targeted files) | ok |
