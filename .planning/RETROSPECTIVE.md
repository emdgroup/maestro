# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.2 — Deep Linking & Project Picker

**Shipped:** 2026-03-29
**Phases:** 2 | **Plans:** 4 | **Duration:** 1 day (2026-03-28)

### What Was Built
- Zustand `navigationStore` with discriminated union dispatch (`navigate({ taskId/agentId/worktreeId/view })`), slideDirection animation, and 8 selector hooks — TDD with 17 tests
- All navigation consumers rewired from local state to store; `usePageRouting` hook deleted entirely
- Three async Rust IPC commands (`git_init_project`, `clone_project`, `create_new_project`) with `connection_id` for SSH remote support
- 3-button project picker footer with CloneProjectDialog and CreateProjectDialog, both with FilePicker integration and auto-git-init on select

### What Worked
- TDD approach for navigationStore was clean — writing 17 failing tests first made the store implementation mechanical and confident
- Discriminated union dispatch pattern is ergonomic and TypeScript-safe; `'key' in target` narrowing avoided complex switch statements
- Inline DB logic in async Rust commands (instead of calling shared `create_project()`) resolved `State<'_>` lifetime issues cleanly — anticipated in RESEARCH.md
- Human-verify checkpoint caught the missing SSH connection threading before it became a production bug

### What Was Inefficient
- The v1.2 milestone started without a formal `/gsd:new-milestone` (phases were added ad-hoc to the v1.2 section), so there was no requirements doc or milestone audit
- Skills removal (quick task) happened during v1.2 closure — this was untracked work not reflected in the milestone plan

### Patterns Established
- **Pending entity ID pattern**: store holds `pendingTaskId`, component reads it, computes `effectiveId`, consumes in `useEffect`, clears after use
- **Dual-dialog visibility**: `open={open && !showDirPicker}` hides parent dialog without unmounting (preserves form state) when sub-dialog opens
- **Inline vs toast error split**: user-correctable errors (dir already exists) → inline `text-destructive`; server-side failures (git clone) → toast

### Key Lessons
1. Rust async IPC commands with `State<'_>` must not call other functions that re-lock the mutex after `.await` — inline the DB logic instead
2. Human-verify checkpoints reliably catch cross-cutting concerns (like SSH connection threading) that unit tests miss
3. Starting a milestone without `/gsd:new-milestone` means no requirements traceability — worth the 5 minutes even for small milestones

### Cost Observations
- Model: claude-sonnet-4-6 (balanced profile)
- Sessions: 1 focused session
- Notable: 4 plans executed in ~1 day, extremely efficient for the scope delivered

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Process Change |
|-----------|--------|-------|--------------------|
| v1.0 | 12 | 45 | Established GSD workflow, phase/plan structure |
| v1.1 | 11 | 36 | Adopted TanStack Query pattern, service layer, large refactors |
| v1.2 | 2 | 4 | TDD for store, discriminated union patterns, fast single-session execution |

### Cumulative Quality

| Milestone | Tests | Build |
|-----------|-------|-------|
| v1.0 | 27 Rust tests | ✓ |
| v1.1 | 110 Jest tests | ✓ |
| v1.2 | 110 Jest + 17 navigationStore | ✓ |

### Top Lessons (Verified Across Milestones)

1. **Human-verify checkpoints catch cross-cutting bugs** that unit tests miss (SSH threading, DB mutex issues)
2. **Service layer investment pays off** — TanStack Query hooks in v1.1 made v1.2 IPC additions trivial to wire
3. **TDD for store-layer code** is consistently efficient — 17 tests written in one RED commit, implementation in GREEN commit, no debugging cycles
