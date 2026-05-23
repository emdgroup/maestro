---
phase: 55-settings-ui
plan: "03"
subsystem: frontend
tags:
  - cascade-check
  - integration
  - dialog
  - uat
dependency_graph:
  requires:
    - 55-01 (IntegrationStatus, ProjectTicketingConfig IPC types and handlers)
    - 55-02 (useListIntegrations, useProjectTicketingConfig, useSaveProjectTicketingConfig hooks)
  provides:
    - IntegrationMissingDialog blocking modal (D-19)
    - Cascade check wired into App.tsx project open flow
  affects:
    - src/App.tsx
    - src/components/project-picker/IntegrationMissingDialog.tsx
tech_stack:
  added: []
  patterns:
    - Blocking dialog (no onOpenChange) for gate-style UX
    - useEffect cascade check on project open with integrations + ticketing deps
key_files:
  created:
    - src/components/project-picker/IntegrationMissingDialog.tsx
  modified:
    - src/App.tsx
decisions:
  - "Cascade check placed in App.tsx (not a separate MainLayout) — project context already available there via currentProject from projectStore"
  - "showMissingDialog false until both integrations and ticketingConfig are loaded — guards against false positives during query loading"
  - "onFixIntegration calls clearSelectedProject (returns to project picker) — simpler than auto-navigating to Integrations tab; user is one click away"
fixes_during_uat:
  - "gh CLI badge not showing — badge was nested inside `connected && displayName` guard; gh CLI returns display_name: null; fixed by restructuring to `connected && (displayName || isGhCli)`"
  - "gh CLI display_name was null — added try_gh_cli_display_name() in github.rs using `gh api user --jq .login`; called after token probe in list_integrations"
  - "jira_server still in KNOWN_PROVIDERS in integration_handlers.rs — removed"
  - "Ticketing config not persisting — onSubmit in SettingsPage only saved agent/model; ticketing save was in useImperativeHandle.save() which was never called (no parent trigger); fixed by including ticketing save directly in onSubmit"
metrics:
  duration: "~2h (including UAT)"
  completed: "2026-05-23"
  tasks_completed: 2
  files_changed: 6
---

# Phase 55 Plan 03: Cascade Check and UAT Summary

D-19 cascade check implemented and UAT verified. Blocking modal appears when a project with ticketing configured detects its integration has been disconnected. Four bugs found and fixed during UAT.

## What Was Built

### Task 1: IntegrationMissingDialog + cascade check in App.tsx

Created `src/components/project-picker/IntegrationMissingDialog.tsx`:
- Blocking modal dialog (no `onOpenChange` — cannot be dismissed accidentally)
- Title: "Integration Unavailable", amber AlertTriangle icon
- Description: names the missing provider by display name
- Two action buttons: "Fix Integration" (returns to project picker) and "Remove Ticketing Config" (calls `useSaveProjectTicketingConfig(null)` then dismisses)
- `PROVIDER_NAMES` map: 6 entries (github, gitlab, forgejo, linear, jira_cloud, azuredevops)

Wired cascade check into `src/App.tsx`:
- `useListIntegrations` + `useProjectTicketingConfig(currentProject?.id ?? 0)` running at app level
- `useEffect` on `[currentProject, integrations, ticketingConfig, integrationsLoading, ticketingLoading]`
- Guards: early-return when loading or no project; skip when no ticketing config
- Shows `IntegrationMissingDialog` as overlay when integration is missing/disconnected

### Task 2 (UAT): Human verification checklist — 14/14 steps passed

All items verified on user's machine with Jira Cloud integration.

## Bugs Fixed During UAT

### 1. gh CLI badge not showing (`IntegrationsTab.tsx`)
Badge was inside `connected && displayName && (...)`. gh CLI connections have `display_name: null`. Fixed by checking `connected && (displayName || isGhCli)` and rendering badge independently of `displayName`.

### 2. gh CLI display_name always null (`github.rs`, `integration_handlers.rs`)
`try_gh_cli_token()` returned the token but no username. Added `try_gh_cli_display_name()` in `github.rs` using `gh api user --jq .login`. Called after successful token probe in `list_integrations` to populate `display_name`.

### 3. `jira_server` in `KNOWN_PROVIDERS` (`integration_handlers.rs`)
Was missed during the jira_server cleanup pass. Removed from the allowlist (6 providers now).

### 4. Ticketing config not persisting (`SettingsPage.tsx`)
Root cause: `onSubmit` (triggered by form Save button) only saved agent/model settings. Ticketing save was in `useImperativeHandle.save()` which was never called — the parent (`App.tsx`) holds the ref but never invokes `.save()`. Fixed by including the ticketing mutation directly in `onSubmit`.

## Deviations from Plan

None. All plan requirements met. Executor placed cascade check in `App.tsx` rather than `src/views/MainLayout.tsx` (which does not exist) — same effect.
