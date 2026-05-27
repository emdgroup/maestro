# Phase 60: Task Card Redesign — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-26
**Phase:** 60-task-card-redesign
**Areas discussed:** Card metadata layout, Agent/worktree data strategy, Inline action style, Priority visualization, Auto-approve indicator

---

## Card Metadata Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Option A — Compact header row | Priority pill + auto-approve icon row 1, title below, labels row, agent/worktree footer, action button | |
| Option B — Title first | Title prominent at top (2 lines), metadata row (priority + labels) below, agent/worktree footer, action button | ✓ |
| Current (reference) | Status dot + truncated 1-line title + labels + full-width action | |

**User's choice:** Option B — Title first
**Notes:** User viewed HTML comparison at `.claude/plans/60-card-layout-preview.html` before deciding.

---

## Auto-Approve Indicator

| Option | Description | Selected |
|--------|-------------|----------|
| Lightning bolt | ⚡ icon — conveyed "fast execution" | |
| `AUTO` text badge | Muted pill | |
| Bot icon | Robot outline | |
| Green checkmark-circle | Suggests approval | |
| `ShieldAlert` icon | Already used in PermissionPrompt for "all tools, full session" — exact semantic match | ✓ |
| Omit from card | Show only in detail screen | |

**User's choice:** `ShieldAlert` from lucide-react — reuse existing shield vocabulary
**Notes:** User clarified auto-approve means "agent runs without human approval prompts during implementation" (not merge approval). This made `ShieldAlert` (already meaning "all tools, full session" in PermissionPrompt) the obvious reuse.

---

## Agent/Worktree Data Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Overlay from ActiveSessionInfo | Poll active sessions, derive Map<task_id, session> in KanbanView | |
| Enrich task query | New IPC join — tasks with agent + worktree | |
| model_override as agent name | Show Claude model as proxy for agent | |
| Omit agent name | Skip until Phase 61 adds agent field to Task | ✓ (agent) |
| useWorktreesQuery for worktree badge | Already event-driven, has task_id, hoist to KanbanView | ✓ (worktree) |

**User's choice:** Agent name omitted from Phase 60. Worktree badge via `useWorktreesQuery`.
**Notes:** User noted they expected an "assignee" property on Task — confirmed it doesn't exist yet. Phase 61 adds agent selector to Create Task modal, establishing the field. Agent name deferred until then.

---

## Inline Action Style

| Option | Description | Selected |
|--------|-------------|----------|
| Full-width button (current) | Takes full card width at bottom | |
| Compact text button | Right-aligned, smaller | |
| Action in footer row | Action button right-side of footer row alongside metadata | ✓ |

**User's choice:** Footer row — action button shares row with worktree/agent metadata.

---

## Priority Visualization

| Option | Description | Selected |
|--------|-------------|----------|
| Text pill | "High", "Medium" etc as colored badge | |
| Colored dot | Small circle, color = priority level | ✓ |
| Icon + color | Arrows (↑↑ ↑ — ↓) | |
| Left border accent | Colored left border on card | |

**User's choice:** Colored dot — small circle before metadata row.

---

## Context Menu

| Option | Description | Selected |
|--------|-------------|----------|
| Keep ⋮ button | Retain context menu for settings/archive | |
| Remove ⋮ button | All actions via task detail screen | ✓ |

**User's choice:** Remove — `TaskContextMenu` removed from card. Detail screen handles all task actions.

---

## Claude's Discretion

- Footer row exact layout (left/right balance) — within Option B structure
- Priority dot exact sizing and spacing
- `ShieldAlert` icon color (amber per PermissionPrompt reference)
- Empty-state when no worktree (omit badge entirely, no placeholder)

## Deferred Ideas

- Agent name on card — deferred to Phase 61+ (Task type gains agent field then)
