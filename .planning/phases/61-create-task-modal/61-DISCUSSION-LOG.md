# Phase 61: Create Task Modal — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-26
**Phase:** 61-Create Task Modal
**Areas discussed:** Agent field, From Issue tab scope, Branch selector UX, Create another reset behavior

---

## Agent Field

| Option | Description | Selected |
|--------|-------------|----------|
| Per-task in DB | Add `agent_id: Option<String>` to Task model, schema V19, per-task storage | ✓ |
| Per-project only | Show project default, update project settings only, no task-level storage | |

**User's choice:** Per-task in DB
**Notes:** User framed this as an "assignee" field where the assignee is an AI agent. Schema V19 confirmed for Phase 61.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Dropdown (Select) | Same pattern as Priority field | ✓ |
| Combobox (searchable) | Popover + Command, better for many agents | |

**User's choice:** Dropdown

---

| Option | Description | Selected |
|--------|-------------|----------|
| Required | Must pick agent to submit | |
| Optional (null allowed) | Task can exist with no agent; required gate elsewhere | ✓ |

**User's choice:** Optional on create/edit
**Notes:** Required gate belongs at Backlog→Ready transition, to be enforced in Phase 62 action bar.

---

| Option | Description | Selected |
|--------|-------------|----------|
| V19 in Phase 61 | Schema bump here, agent lands with modal | ✓ |

**User's choice:** V19

---

## From Issue Tab Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Simple picker | Searchable list/combobox, click one → pre-fills title + description | ✓ |
| Full browser inside tab | Replicate 3-tab Available/Imported/Changed browser | |
| Hybrid | Available only, bulk select preserved | |

**User's choice:** Simple picker

---

| Option | Description | Selected |
|--------|-------------|----------|
| Drop entirely | No change detection, IMPT-* and CHNG-* superseded | ✓ |
| Keep as future phase | Note as deferred | |

**User's choice:** Drop it
**Notes:** IMPT-01 through IMPT-06 and CHNG-01/CHNG-02 from v1.6 requirements are superseded by the simpler UX.

---

A visual preview was generated at `.claude/plans/61-create-task-modal-preview.html` before this question.

| Option | Description | Selected |
|--------|-------------|----------|
| Option A — scrollable list | Search input above persistent issue list, click row selects + pre-fills | |
| Option B — combobox | Trigger opens popover with search + list, compact | ✓ |

**User's choice:** Option B (combobox)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Full form | Branch, priority, agent, toggles all appear after issue selection | ✓ |
| Minimal | Title + description only; other fields use project defaults silently | |

**User's choice:** Full form

---

| Option | Description | Selected |
|--------|-------------|----------|
| Tab hidden | No tabs when provider unconfigured; modal shows From Branch directly | ✓ |
| Tab shown with empty state | Tab always visible, shows "Connect a provider" prompt | |

**User's choice:** Tabs hidden entirely when no provider. Provider connected → both tabs shown.

---

## Branch Selector UX

| Option | Description | Selected |
|--------|-------------|----------|
| Combobox (Popover + Command) | Type to filter, popover-based | ✓ |
| Filtered Select | Input above SelectContent, simpler, no new component | |

**User's choice:** Combobox

---

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit refresh button | Icon button next to trigger, invalidates query | ✓ |
| Short staleTime (0) | Always re-fetch on open, no button | |

**User's choice:** Explicit refresh button

---

| Option | Description | Selected |
|--------|-------------|----------|
| List only | Must pick from existing branches | ✓ |
| Free-text allowed | Arbitrary branch name accepted | |

**User's choice:** List only

---

## Create Another Reset Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Reset title + description only | Branch, priority, agent, toggles persist | ✓ |
| Full reset | All fields reset to defaults | |

**User's choice:** Title + description reset only
**Notes:** Enables batch task creation for same context (same branch/agent, different work items).

---

| Option | Description | Selected |
|--------|-------------|----------|
| Off by default | User opts in | ✓ |
| Remembered | Persists in localStorage | |

**User's choice:** Off by default

---

## Claude's Discretion

None — user made explicit choices for all options.

## Deferred Ideas

- **Backlog→Ready agent gate** — Phase 62 enforces agent must be set before status transition
- **v1.6 import/change detection features** — IMPT-* and CHNG-* requirements dropped; not deferred to a future phase
