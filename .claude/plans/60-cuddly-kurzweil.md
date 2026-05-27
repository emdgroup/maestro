# Phase 60: Task Card Redesign — Execution Plan

## Context

Phase 60 rewrites `TaskCard.tsx` with a new layout (title → metadata → footer), removes the context menu, wires card click to `setActiveTaskId`, and adds priority dots, ShieldAlert badge, worktree badge, and compact per-status action buttons. Phase 59 (Board View) is complete. All context decisions are locked in `60-CONTEXT.md`.

Both plans use `isolated_worktree: false` — sequential execution on main working tree.

## Phase Structure

| Wave | Plan | Tasks | What it builds |
|------|------|-------|----------------|
| 1 | 60-01 | 7 | TaskCard rewrite — layout, priority dot, badges, actions |
| 2 | 60-02 | 3 | Data threading worktreeTaskIds down KanbanView → TaskCard |

## Pre-execution Checks

- No `.continue-here.md` → no blocking antipatterns
- No existing SUMMARY.md files → both plans incomplete
- No `--wave`, `--gaps-only`, `--interactive` flags → full phase execution

## Execution Steps

### 1. Init
```bash
gsd-sdk query init.execute-phase 60
gsd-sdk query config-set workflow._auto_chain_active false
USE_WORKTREES=$(gsd-sdk query config-get workflow.use_worktrees || echo "true")
```
- Both plans have `isolated_worktree: false` → sequential agents on main tree

### 2. Validate Phase
```bash
gsd-sdk query state.begin-phase --phase 60 --name "task-card-redesign" --plans 2
```

### 3. Wave 1 — Plan 60-01 (TaskCard Rewrite)

Spawn `gsd-executor` **sequentially** (no worktree isolation):

**Executor reads:**
- `.planning/phases/60-task-card-redesign/60-01-PLAN.md`
- `.planning/PROJECT.md`, `.planning/STATE.md`
- `60-CONTEXT.md`, `60-RESEARCH.md` if present
- `CLAUDE.md`

**7 tasks in order:**
1. Remove context menu (⋮ button + `TaskContextMenu`) and remove `onArchiveClick` prop
2. Wire card click → `setActiveTaskId(task.id)` via `useNavigationActions()`
3. Add priority dot (7×7px circle, colors per CONTEXT D-05)
4. Restructure layout: title (2-line clamp) → metadata row (priority dot + labels) → footer
5. Add `ShieldAlert` badge (amber-500, h-3.5 w-3.5) for `auto_approve === true`
6. Add worktree badge (green dot + "worktree" text in left footer) driven by `worktreeTaskIds` prop
7. Inline action buttons in right footer: Execute / Interrupt / Review / Archive per status

After completion: SUMMARY.md created, commit per task.

### 4. Wave 1 → Wave 2 Gate

Post-merge gate: `pnpm build` + `pnpm test`. No worktrees to merge (sequential mode).

Update tracking:
```bash
gsd-sdk query roadmap.update-plan-progress 60 60-01 complete
gsd-sdk query commit "docs(phase-60): update tracking after wave 1" --files .planning/ROADMAP.md .planning/STATE.md
```

Pre-wave 2 dependency check: verify 60-01 SUMMARY.md + commits exist.

### 5. Wave 2 — Plan 60-02 (Data Threading + Cleanup)

Spawn `gsd-executor` sequentially:

**3 tasks in order:**
1. `KanbanColumn.tsx`: add `worktreeTaskIds: Set<number>` prop, remove `onSettingsClick`/`onArchiveClick`
2. `BoardView.tsx`: remove `TaskSettingsModal` import/state, thread `worktreeTaskIds` down to KanbanColumn
3. `KanbanView.tsx`: hoist `useWorktreesQuery`, derive `worktreeTaskIds = new Set(worktrees.filter(w => w.task_id).map(w => w.task_id))`, pass down

After completion: SUMMARY.md created, commit per task.

### 6. Post-execution Gates

- Post-merge build/test gate: `pnpm build` + `pnpm test`
- Code review: `Skill(skill="gsd-code-review", args="60")`
- Regression gate: run prior phase tests
- Schema drift gate (likely skip — no schema changes)
- Codebase drift gate

### 7. Verification

Spawn `gsd-verifier`:
- Check CARD-01 through CARD-06 in REQUIREMENTS.md satisfied
- Verify layout matches D-01 through D-11 decisions in 60-CONTEXT.md
- Verify no context menu remnants
- Verify card click → setActiveTaskId wired
- Create `60-VERIFICATION.md`

If `human_needed`: persist `60-HUMAN-UAT.md`, present for approval.

### 8. Completion

```bash
gsd-sdk query phase.complete 60
gsd-sdk query commit "docs(phase-60): complete phase execution" --files .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md .planning/phases/60-task-card-redesign/60-VERIFICATION.md
```

Update `PROJECT.md` with phase completion.

## Critical Files

| File | Role |
|------|------|
| `src/components/kanban/TaskCard.tsx` | Primary rewrite target (Plan 60-01) |
| `src/components/kanban/KanbanColumn.tsx` | Prop threading (Plan 60-02) |
| `src/components/views/BoardView.tsx` | Modal removal + prop threading (Plan 60-02) |
| `src/views/KanbanView.tsx` | useWorktreesQuery hoist (Plan 60-02) |
| `src/store/navigationStore.ts` | `setActiveTaskId` / `useNavigationActions` |
| `src/utils/hooks/useExecuteTask.ts` | Execute action hook |
| `src/services/task.service.ts` | `useInterruptTaskMutation` |
| `src/services/worktree.service.ts` | `useWorktreesQuery` |
| `.planning/phases/60-task-card-redesign/60-CONTEXT.md` | Locked decisions D-01..D-11 |

## Verification Approach

After execution:
1. `pnpm build` — TypeScript clean
2. `pnpm test` — unit tests pass
3. Human UAT: click task card → detail panel opens; priority dot shows; action button matches column status; worktree badge visible on tasks with active worktrees; no ⋮ menu
