# Kanban / Tasks Brainstorm
_Started: 2026-03-25 — Kanban/Tasks design complete as of 2026-03-26_

---

## Context

Brainstorm session covering the redesign of the Tasks/Kanban area of Maestro.
Goal: clarify the core purpose, information architecture, and UX of task management.

---

## Locked Decisions

### Mental Model
- Task state and agent state are **separate concerns**
- A task stays `InProgress` regardless of what its agent is doing
- Agent has its own sub-states: `running` | `waiting` | `failed` | `interrupted`
- `Failed` is **not a column** — it is an agent status shown on the InProgress card
- The Kanban is a **shared control plane** between human intent and agent execution

### Task States (columns)
```
Backlog → Ready → InProgress → Review → Done
                                      → Cancelled (terminal)
```
- `Merging` state removed — Review flow is synchronous (user explicitly triggers commit/push/merge)
- `Failed` column removed

### Execution Flow
1. Human grooms backlog, sets priority and origin branch, promotes tasks to Ready
2. Agent is assigned to a Ready task — either manually by user or automatically (Auto mode)
3. On start: task → InProgress, worktree created from origin branch, agent spawned with task content + config
4. Agent works, reports status on the card
5. Agent done → task moves to Review
6. User reviews diff, makes decision (see Review flow below)
7. Task moves to Done after commit/push/merge

### Execution Modes
- **Manual**: user explicitly starts individual Ready tasks via Start button on card
- **Auto**: system drains Ready queue automatically up to max concurrent agents limit
- Mode toggle lives in the **app header** (auto/manual label + pulsing indicator when Auto is active)
- Switching Auto → Manual does **not** stop in-flight agents; they complete naturally
- Max concurrent agents configured in the **Agents tab** action bar

### Columns are monitoring surfaces
- Users **do not drag tasks between columns** — all transitions happen via explicit actions on cards
- Board = read-only operational monitor; all state changes are intentional

### Ready Column
- Priority-ordered queue; order is set during backlog grooming (priority levels TBD)
- No drag-to-reorder on the Board — queue order reflects grooming priority
- **Blocked tasks cannot be promoted to Ready** — they never appear in this column
- Manual mode: each task has a **[Start]** button on the card
- Auto mode: system picks tasks from top of queue automatically

### InProgress Card Design
```
● Running — 4m ago
                               [Stop]

⚠ Waiting for input
             [→ Go to Agents tab]  [Stop]

✕ Interrupted by user
              [Cancel]       [Resolve →]

✕ Agent failed
              [Cancel]       [Resolve →]
```
- **Stop** → agent becomes `interrupted`, task stays InProgress
- **Waiting for input** → link navigates to the specific waiting agent in the Agents tab (no inline input)
- **Resolve →** opens the task detail panel in **read-only mode** for context (shows stop reason, agent output for failures / "interrupted by user" for stops, full task fields). A required instructions textarea at the bottom lets the user add new instructions — identical in behaviour to **Resume with instructions** in the Review panel. Agent is resumed in the same worktree with new instructions appended to session context, task stays InProgress.
- **Cancel** → worktree folder + branch deleted immediately, task moves to Cancelled (terminal)
- `Interrupted` and `Failed` share the same card treatment (`[Cancel] [Resolve →]`)
- Generic "Resolve →" label used for both states

### Review Flow
Review card has a single **[Review →]** button that opens the review panel.

**Review panel:**
- **[Open Diff ↗]** — opens system diff tool / editor (not inline)
- Accept section (default: Commit + Merge):
  - ● Commit + Merge → branch dropdown (default: task's origin branch; any available branch selectable)
  - ○ Commit + Push
  - ○ Commit only
- Reject section:
  - **Send to Backlog** — optional comment textarea explaining rejection
  - **Resume with instructions** — required textarea (added as a comment to the task) + optional file attachments; task returns to InProgress
  - **Cancel task** → Cancelled (worktree folder + branch deleted)

### Task Detail Panel Fields
| Field | Editable in | Notes |
|---|---|---|
| Name | Backlog, Ready | |
| Description | Backlog, Ready | Free text |
| Acceptance criteria | Backlog, Ready | Fed to agent as "done" definition |
| Priority | Backlog, Ready | Urgent / High / Medium (default) / Low |
| Origin branch | **Backlog only** | Locked once promoted to Ready |
| Relationships | Backlog, Ready | Blocked by / Blocks / Related to |
| Skills / config | Deferred | |

- **Instructions log**: separate read-only section below the Description field — chronological thread of agent context entries: first entry is stamped when the task first runs (snapshot of description + acceptance criteria at that moment), then each subsequent rejection comment and resume/resolve instruction, each timestamped. Full audit trail visible in the detail panel.
- Origin branch is **read-only** once the task is in Ready or beyond
- Ready column cards have a **[↩ Back to Backlog]** action to demote a task back to Backlog (worktree does not exist yet at this stage, so no cleanup needed)
- **Adding a relationship**: select type first (Blocked by / Blocks / Related to) → then search-as-you-type to pick the target task. Each relationship renders as a row: type badge + task name + remove button.

### Worktree Lifecycle
- **Send to Backlog** (from Review): worktree folder + branch deleted; agent starts fresh from origin branch on next execution; rejection comment stored on task and visible as context when re-run
- **Resume with instructions** (from Review): worktree preserved; agent session resumed in same worktree; new instructions appended to session context
- **Resolve →** (from InProgress Interrupted/Failed): same as Resume with instructions — worktree preserved, agent resumed with new instructions
- **Cancel** (from InProgress Interrupted/Failed, or "Cancel task" from Review): worktree folder + branch deleted; task moves to Cancelled

### Done Column
```
┌─────────────────────────────────────┐
│ Task name                           │
│ ↳ merged into main                  │
│   (or: branch feature/task-123)     │
│                                     │
│                      [Archive]      │
└─────────────────────────────────────┘
```
- Cards show task name + branch where code lives (target merge branch or worktree branch)
- **Archive** button: removes task from Done column + deletes associated worktree
- **Archiving mode** is configured in project settings:
  - **Manual** (default): user archives explicitly via the [Archive] button per card
  - **Auto**: tasks are archived automatically based on configurable thresholds:
    - **Count threshold**: archive oldest Done tasks when Done exceeds N cards (sane default provided)
    - **Time threshold**: archive Done tasks older than N days (sane default provided)
    - Both thresholds are independent; either can trigger archiving
- Done is a visual confirmation surface — Archive is the history surface

### Auto Mode
- Toggle in app header: **Auto** (pulsing indicator) / **Manual**
- Auto: drains Ready queue top-to-bottom, skips blocked tasks, respects max concurrent agents
- Manual: user starts each task explicitly; auto mode switch does not affect running agents
- Blocked/skipped tasks remain in Ready and are picked up automatically when dependency resolves

### Waiting Agent UX
- Visual indicator on the InProgress card (badge + "⚠ Waiting for input" label)
- Link on card navigates to the specific agent in Agents tab
- User provides input via Agents tab terminal/chat panel
- No inline input on the Kanban card
- Mirrored in the Agents tab dashboard

### Priority
- Levels: **Urgent | High | Medium | Low** (default: Medium)
- Ready queue is sorted by priority tier, then by promotion order within tier
- Promoting a Backlog task places it at the **last position within its priority tier** (e.g., a High task lands after existing High tasks but before any Medium tasks)

### Relationships
- Tasks support multiple relationships: **Blocked by** | **Blocks** | **Related to**
- "Blocked by" = hard dependency — task cannot be promoted to Ready while any "Blocked by" dependency is not Done
- "Blocks" = the inverse of "Blocked by" — enforced on the target task
- "Related to" = soft link — informational only, no execution impact
- Multiple relationships of the same type are allowed (e.g., blocked by Task A AND Task B)
- Relationships are set within the **task detail panel**
- **All relationship types are auto-mirrored**: adding any relationship on Task A automatically creates the corresponding relationship on the target task (e.g., "Task A Blocks Task B" → Task B automatically shows "Blocked by Task A"; "Task A Related to Task B" → Task B automatically shows "Related to Task A"). Removing either side removes both.
- Auto mode skips tasks with unresolved "Blocked by" dependencies, picks them up when all resolve

### Concurrency
- 1 agent per task, each on a distinct worktree
- Multiple tasks can be InProgress simultaneously
- Max number of concurrent agents configurable in the **Agents tab** action bar

---

## Information Architecture

### Three Views
| View | Purpose |
|---|---|
| **Backlog** | Groom the backlog — create, refine, prioritize, set origin branch, promote to Ready |
| **Board** | Operate the pipeline — Ready queue, InProgress monitoring, Review, Done |
| **Archive** | Historical record — Done + Cancelled, searchable |

Navigation between the three views is via a **sub-view switcher in the Board action bar**: `Backlog | Board | Archive`

### Backlog View (formerly "Tasks View")
- Flat list of Backlog tasks only (no queue visible here)
- Visible per task: **name, priority, blocked indicator**
- Actions per task: **promote** (disabled if blocked), **delete**
- Bulk action: **delete**
- Click card → opens task detail panel
- Action bar: **Add Task** + sub-view switcher

### Board View
- Columns: **Ready | InProgress | Review | Done**
- Action bar: sub-view switcher only (auto mode toggle moved to app header)
- Ready column = priority-ordered queue; no drag reorder; no blocked tasks
- Done column: minimal — shows completed tasks pending archive; archiving mode (manual/auto) configured in project settings; primary history is Archive

### Archive View
- Done + Cancelled tasks
- **Layout**: flat list — task name, priority, final status (Done / Cancelled), completion date, target branch
- **Filters**: free-text search on name, status (Done / Cancelled), date range
- **Git linkage**: commit hash displayed on Done tasks (copy to clipboard); no inline diff — user opens their own diff tool

---

## Still To Discuss

### Task Detail Panel
- [ ] Skills / MCPs / allowed tools config — details deferred

### Archive View
_(locked — see Locked Decisions)_

### Agent Tab
_(deferred — see `.planning/brainstorm-agent-tab.md`)_

---

## Open Questions

_(none remaining)_

---

## Ideas for Later (not core, deferred)

- **Task grouping / epics**: parent task with child tasks, progress derived from children. Useful for large features with multiple sub-tasks. Not needed until backlog grows large (50+ tasks).
- **Labels/tags**: visual categorization for navigating large backlogs. Alternative to epics for loose grouping.
- **List view alternative** in Board for users who prefer table over cards
- **Notifications**: system-level notifications when agent finishes, needs input, or fails
- **Task import**: already partially implemented (read-only imported tasks with lock badge) — full design TBD
- **Keyboard shortcuts**: quick promote, quick start, navigate between cards
- **Search/filter** in Backlog view for large backlogs
