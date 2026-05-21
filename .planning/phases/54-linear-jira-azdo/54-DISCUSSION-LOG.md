# Phase 54: Linear/Jira/AzDO Auth + API Clients - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-21
**Phase:** 54-linear-jira-azdo
**Areas discussed:** Azure DevOps work item scope, Linear team scope, Jira ADF body handling

---

## Azure DevOps work item scope

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed type list | Fetch only Bug + Task + User Story | |
| All types | Fetch all work item types, user filters in Phase 56 | ✓ |
| Configurable WIQL | Store user-defined WIQL query in AzureDevOpsConfig | |

**User's choice:** All types — "why not all and let user filter them?"
**Notes:** Phase 56 import modal handles filtering. No WIQL configuration needed for v1.6.

---

## Linear team scope

| Option | Description | Selected |
|--------|-------------|----------|
| Required at connect | save_linear_credentials must include team_id | |
| Optional, configure in Settings | Connect without team, pick team in Phase 55 Settings UI | ✓ |
| Always fetch all | Ignore team_id entirely | |

**User's choice:** Configure in project settings (Phase 55)
**Notes:** User agreed with recommendation to add list_linear_teams IPC in Phase 54 for Phase 55 to consume. team_id = None fetches all workspace issues.

---

## Jira ADF body handling

| Option | Description | Selected |
|--------|-------------|----------|
| Plain text | Concatenate text leaf nodes only (~20 lines) | |
| Basic Markdown | Map ADF node types to Markdown (~60 lines) | ✓ |
| Skip body | body: None — title only | |
| Use a crate | Delegate to jc-adf Rust crate | ✓ (preferred) |

**User's choice:** Basic Markdown — "I would say basic markdown as well"
**Notes:** User asked to check for a crate first. `jc-adf` crate found on crates.io — bidirectional ADF ↔ Markdown converter, `to_markdown()` function. Use crate instead of hand-rolling. Fall back to None on parse/conversion failure.

---

## Claude's Discretion

- GraphQL client structure: inline `graphql!` macro (no .graphql schema file)
- Pagination: single-page fetch, no cursor pagination for v1.6
- Error message format: mirror Phase 53 prefix pattern
- URL normalization: reuse existing `normalize_instance_url()` for Jira Server + AzDO
- Jira/AzDO module file naming: separate files per provider variant

## Deferred Ideas

None.
