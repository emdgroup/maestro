# Research Summary: Maestro v1.3

**Project:** Maestro — Tauri 2 + React 19 desktop app for AI agent orchestration
**Domain:** Desktop agent monitoring + git worktree management views with backend overhaul
**Researched:** 2026-03-29
**Confidence:** HIGH

---

## Synthesis Headline

v1.3 is the **"Make It Real"** milestone. Two placeholder views get replaced with real data and real behavior. Three key themes:

1. **Replace pool with on-demand worktrees** — remove the pool allocation system entirely; create one worktree per task at execution time, delete it on completion
2. **Wire the Agents view** — real execution list from the DB, live xterm.js terminal attached via Tauri channel, graceful handling of dead PTY sessions
3. **Wire the Worktrees view** — real git worktree cards from `git worktree list`, right-panel diff view reusing existing `@git-diff-view/react`, zombie detection and cleanup

---

## Executive Summary

Maestro v1.3 has an unusually high reuse ratio. Nearly every component needed for the two new views already exists and works: `TerminalComponent`/`ExecutionTerminal` for the live terminal pane, `@git-diff-view/react` for the diff detail panel, `navigationStore` deep linking, TanStack Query service layer, and PTY attach/detach/resize IPC commands. The milestone is primarily about connecting existing pieces to real data — the blocker is a backend that currently serves fake data (hard-coded cards, static sidebar items) and a pool-based worktree model that must be replaced before either view can function correctly.

The backend overhaul is the critical path. Pool removal touches two dangerous spots in `execution_handlers.rs`: the `lease_worktree()` call at spawn time and the `return_worktree` finalization block at completion time. Both must be replaced atomically with on-demand create and delete logic, and the real `git worktree add` implementation (currently a TODO stub in `git/mod.rs`) must exist before either change is made. Only after the backend phase is complete and tested can the frontend phases safely proceed — the views depend on three new IPC commands that do not exist yet (`list_worktrees_with_status`, `list_executions_with_task_info`, `get_worktree_diff`).

The biggest technical risks are the blocking tokio issue (existing git subprocess calls use `std::process::Command` in async handlers — must be converted to `tokio::process::Command` for all new IPC) and the xterm.js lifecycle (Terminal.dispose() + FitAddon + ResizeObserver must all be wired or the Agents view leaks memory on every navigation). Both are well-understood and preventable if the build order is respected.

---

## Key Findings

### Stack Additions

The existing stack covers nearly everything. Minimal new packages needed.

**New Rust crates (required):**
- `git2 = { version = "0.20.4", features = ["vendored-libgit2"] }` — worktree listing, per-worktree diffs, status queries; mirrors how `rusqlite = { features = ["bundled"] }` works, no system dependency
- `notify = "8.2.0"` — cross-platform file watching (macOS FSEvents, Linux inotify, Windows ReadDirectoryChanges); use `spawn_blocking` for the sync channel loop

**New frontend packages (optional):**
- `@xterm/addon-web-links@^0.12.0` — clickable URLs in terminal output; same `@xterm/*` namespace, zero friction; add if time permits

**Do not add:** `tauri-plugin-fs-watch` (Tauri v1 only, no v2 version), `gix`/gitoxide (API still stabilizing), any second diff library (reuse `@git-diff-view/react`), `@xterm/addon-search` (deferred to v2 — `ExecutionHistory` already covers completed log search).

### Feature Decisions

**In for v1.3:**
- Agents view: real execution list via `list_executions_with_task_info` IPC, live xterm.js terminal, status indicators, elapsed time, task name per execution, dead session fallback to DB history, search/filter by status
- Worktrees view: real git worktree cards via `list_worktrees_with_status` IPC, right-panel diff via `get_worktree_diff` + `@git-diff-view/react`, zombie/prunable badge, delete with confirmation, task link per card, agent status badge per card
- Backend: on-demand worktree creation in spawn path, deletion on completion, schema v3, 5 pool IPC commands removed, 5 new commands added

**Anti-features — explicitly out for v1.3:**
- Multiple terminals side-by-side or tab strips (sidebar row IS the tab selector)
- Manual worktree creation from the Worktrees view (worktrees are agent-created per task)
- Git operations (merge/push/rebase) in the Worktrees view (review flow already owns this)
- Real-time git status polling on a background interval (expensive; refresh on view open + explicit button is sufficient)
- Agent scheduling or queuing from the Agents view (Kanban is the dispatcher)

**Deferred to v2:**
- `prune_worktrees` batch zombie cleanup IPC (manual delete per-card works for now)
- Uncommitted file count inline on worktree card (requires `git diff --stat` per worktree at list time — too expensive)
- `@xterm/addon-search` for live in-terminal search

### Architecture Approach

The architecture is strictly layered: Views own TanStack Query hooks and pass data as props to display components. This is the established codebase pattern and must not be broken. The two joined IPC commands (`list_worktrees_with_status`, `list_executions_with_task_info`) must be backend SQL joins — never derive them in the frontend by combining multiple IPC round trips.

**Component changes:**
- `AgentMonitor.tsx` — full rewrite from placeholder; sidebar from `ExecutionWithTask[]`, terminal pane reusing existing `ExecutionTerminal`
- `WorktreeManager.tsx` — full rewrite from placeholder; card grid from `WorktreeWithStatus[]`, right panel reusing `DiffViewer`
- `worktree_handlers.rs` — full rewrite in place; remove 5 pool commands, add 5 new commands
- `execution_handlers.rs` — extend with `list_executions_with_task_info`; modify spawn/resume to call on-demand create; finalization blocks delete not return
- `models/worktree.rs` — remove `WorktreeStatus` pool enum; add `task_id` FK, `WorktreeWithStatus`, `ExecutionWithTask` view models
- `db/schema.rs` — bump to schema v3; drop pool columns, add `task_id` FK and `git_status` column

**Data flow:** Execution sidebar uses 2-second TanStack Query polling (no Tauri event channel needed — status transitions are infrequent). Terminal pane uses existing Tauri Channel + `attach_terminal`/`detach_terminal` keyed by `task_id` (this key must not change — PTY sessions in `AppState` are keyed by `task_id` throughout).

### Critical Pitfalls

1. **Pool removal breaks `spawn_agent_execution` before `create_worktree_local` is implemented** — `lease_worktree()` is called at line 120 of `execution_handlers.rs`; removing it without a working `git worktree add` implementation causes PTY spawn to fail with "No such file or directory". Prevention: implement and verify real on-demand worktree creation as a standalone IPC command first; replace the `lease_worktree` call site only after that command is confirmed to produce a real directory on disk.

2. **Return-to-pool finalization block left in `execution_handlers.rs` after pool removal** — Both `spawn_agent_execution` and `resume_agent_execution` tokio closures contain a finalization block that writes `status = 'Available'` back to the DB. This must be replaced with delete logic in the same commit that removes `lease_worktree`. Leaving it produces ghost DB rows that pass the "looks done" check. Prevention: audit every write of `status = 'Available'` in both handler files before declaring pool removal complete.

3. **`std::process::Command` blocking the tokio runtime in async IPC handlers** — `list_branches_local` and `get_current_branch_local` already have this bug; any new git IPC that copies the pattern will queue all concurrent IPC during the subprocess. Prevention: use `tokio::process::Command` for all subprocess calls in async handlers; if using the `git2` crate (synchronous API), wrap in `tokio::task::spawn_blocking`.

4. **xterm.js Terminal not disposed on React unmount** — Every navigation away from the Agents view without calling `Terminal.dispose()` leaks a DOM canvas + event listeners + a background tokio streaming task (the PTY backend task keeps running until the channel is detected closed). Prevention: always structure the terminal `useEffect` with explicit `terminal.dispose()` + `observer.disconnect()` + channel close in the cleanup function.

5. **Dead PTY session causes blank terminal instead of showing history** — `pty_sessions` in `AppState` is in-memory only; it is empty after app restart and for all completed tasks. Calling `attach_terminal` for a non-running execution results in a silent empty channel. Prevention: check `ExecutionLog.status` before calling `attach_terminal`; for non-running executions, fetch `terminal_output` from the DB and write it directly to xterm.js — never call `attach_terminal` on a completed or failed execution.

---

## Implications for Roadmap

Phases continue from 24. The dependency graph is strict: backend first, then the two frontend views, then cleanup.

### Phase 25: Backend Overhaul — Pool Removal + On-Demand Worktrees + Schema v3

**Rationale:** Every other phase depends on this. The three new IPC commands don't exist yet. Pool removal must be complete and tested before any execution flow is touched in later phases. Frontend views still use placeholder data so there are no regressions during this phase.

**Delivers:**
- Schema v3 migration (drop pool columns, add `task_id` FK + `git_status`)
- `models/worktree.rs` overhauled (`WorktreeWithStatus`, `ExecutionWithTask` added; pool enum removed)
- `git/mod.rs` local stubs implemented: real `git worktree add/remove` via `tokio::process::Command`
- `worktree_handlers.rs` rewritten: 5 pool commands removed, 5 new commands added (`list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`, `cleanup_zombie_worktrees`)
- `execution_handlers.rs` modified: spawn/resume use on-demand create; finalization blocks delete not return
- `execution_handlers.rs` extended: `list_executions_with_task_info` added
- `lib.rs` command registration updated
- `pnpm tauri:gen` run to regenerate `bindings.ts`

**Pitfalls to avoid:** Pitfalls 1 and 2 (pool removal atomicity), Pitfall 3 (tokio blocking in all new git IPC)

**Research flag:** Standard patterns — all integration points confirmed via codebase inspection. No additional research needed.

---

### Phase 26: Agents View — Real Data

**Rationale:** Depends only on Phase 25. Can start immediately after backend is verified. `TerminalComponent` and `ExecutionTerminal` are fully functional — this phase is primarily wiring and state management, not new component work.

**Delivers:**
- `useExecutionsWithTaskInfoQuery(projectId)` hook added to `execution.service.ts` (2s refetch interval)
- `AgentMonitor.tsx` rewritten: real sidebar list, live terminal via existing `ExecutionTerminal`, status indicators, elapsed time, task name, search/filter by status
- `AgentsView.tsx` wired to new hook; data passed as props to `AgentMonitor`
- Dead session handling: `Running` executions attach to PTY via `attach_terminal`; all others render `terminal_output` from DB via `terminal.write(history)`
- Tauri channel lifecycle: detach old channel + attach new one on sidebar selection change (channel keyed by `task_id`)
- Deep link auto-select: `pendingAgentId` from `navigationStore` used for initial selection; fallback to most-recent-running execution

**Pitfalls to avoid:** Pitfall 4 (xterm.js dispose/FitAddon/ResizeObserver wiring), Pitfall 5 (dead PTY blank terminal), keep PTY session key as `task_id`

**Research flag:** Standard patterns. All components exist and work. No research needed.

---

### Phase 27: Worktrees View — Real Data

**Rationale:** Depends only on Phase 25. Can run in parallel with Phase 26 or immediately after. `DiffViewer` and `@git-diff-view/react` are already proven in the review flow — this phase reuses them unchanged.

**Delivers:**
- `worktree.service.ts` created with `useWorktreesQuery`, `useWorktreeDiffQuery`, `useDeleteWorktreeMutation`
- `WorktreeManager.tsx` rewritten: card grid from `WorktreeWithStatus[]`, right panel with diff via `@git-diff-view/react`
- Zombie/prunable badge surfaced from `is_zombie` field; manual "Clean up" action button (never auto-delete)
- Delete worktree with confirmation dialog using existing `delete_worktree` IPC
- Task link per card via `navigationStore.navigate()` deep link to Kanban
- Agent status badge per card (active/idle from `execution_status` field on `WorktreeWithStatus`)
- `WorktreesView.tsx` wired to hooks; data passed as props

**Pitfalls to avoid:** Zombie detection shown in UI only — never auto-delete. DB state is a hint; `git worktree list` is authoritative for existence.

**Research flag:** Standard patterns. All display components exist. No research needed.

---

### Phase 28: Zombie Cleanup on Project Open

**Rationale:** Depends on Phases 25 and 27. A cleanup pass on startup ensures the Worktrees view starts from a consistent state. Lower priority than the two view phases — app functions correctly without it, since Phase 27 surfaces zombies in the UI for manual cleanup.

**Delivers:**
- `cleanup_zombie_worktrees(project_id)` IPC command: finds worktrees where `task_id IS NULL` or task status is Done/Archived AND `git worktree list` confirms path exists, attempts `git worktree remove`, deletes DB rows
- Called from `App.tsx` `useEffect` on project open, replacing `recover_dirty_worktrees`
- Uses time threshold (e.g., leased_at > 10 minutes ago) to avoid false positives on actively starting agents

**Pitfalls to avoid:** Zombie detection race — never auto-delete based on DB state alone; always cross-check with `git worktree list` before removal.

**Research flag:** Standard patterns. No research needed.

---

### Phase Ordering Rationale

- Phase 25 must come first — it is a compile-time hard dependency. Without it, three IPC commands that the views depend on do not exist.
- Phases 26 and 27 are independent of each other and can run in parallel. Phase 26 is higher UX priority (agents view is more frequently navigated than worktrees view).
- Phase 28 is the only optional phase for the milestone. If time-constrained, the Worktrees view zombie badge + manual delete button from Phase 27 provides adequate coverage.
- Pool removal in Phase 25 is the riskiest moment in the milestone. The "looks done but isn't" checklist from PITFALLS.md should be run in full before Phase 25 is closed and before any execution flow is touched.

### Research Flags

Phases needing deeper research during planning:
- **None identified.** All integration points verified by direct codebase inspection. IPC signatures, component boundaries, and data flows are confirmed in source with specific file and line references.

Phases with standard patterns (skip research-phase):
- **Phase 25:** Full Rust backend work — model overhaul and IPC command surface are fully mapped. Build order is clear.
- **Phase 26:** Frontend wiring — `TerminalComponent` and all service hook patterns already exist in the codebase.
- **Phase 27:** Frontend wiring — `DiffViewer` and `@git-diff-view/react` usage already proven in the review flow.
- **Phase 28:** Startup cleanup — simple IPC + idempotent `git worktree remove` calls; no new patterns.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against npm registry and docs.rs as of 2026-03-29. Only 2 new packages needed (`git2`, `notify`). No version conflicts with existing stack. |
| Features | HIGH | Verified against official xterm.js docs, git-worktree man page, VS Code worktree UI docs, and direct codebase inspection. Feature boundaries are clear and justified. |
| Architecture | HIGH | Full codebase read. All integration points verified in source. IPC signatures confirmed in `lib.rs`. Reuse ratio is unusually high — most components exist and work today. |
| Pitfalls | HIGH | All 6 critical pitfalls derived from direct source inspection with specific file:line references (e.g., `execution_handlers.rs:120`, `execution_handlers.rs:350-365`). Not theoretical — confirmed code paths. |

**Overall confidence:** HIGH

### Open Questions for Requirements

1. **Worktree path convention on disk** — Where should on-demand worktrees be created? The old pool used `.worktree-pool/wt-{n}`. ARCHITECTURE.md recommends `.worktrees/agent-task-{id}` inside the repo root for consistency with existing git operations. This should be a named constant confirmed in REQUIREMENTS.md before Phase 25 begins.

2. **`git_status` computation timing in `list_worktrees_with_status`** — Computing `git_status` requires running `git status --porcelain` per worktree at query time. For v1.3 MVP, per-query is correct and simple. REQUIREMENTS.md should state this explicitly to prevent scope creep toward a background caching layer in Phase 25.

3. **Schema v3 migration strategy** — ARCHITECTURE.md notes "no production data" justifies drop-and-recreate for schema v3 (existing migration pattern). This assumption should be confirmed before Phase 25. If any tester has data they care about, a proper `ALTER TABLE` migration path is needed instead of drop-and-recreate.

---

## Sources

### Primary (HIGH confidence)
- npm registry — `@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-attach` (verified 2026-03-29)
- https://docs.rs/git2/latest/git2/ — `Repository::worktrees()`, diff, status APIs (git2 v0.20.4, released 2026-02-02)
- https://docs.rs/notify/latest/notify/ — cross-platform watcher API (notify v8.2.0, released 2025-08-03)
- https://git-scm.com/docs/git-worktree — porcelain format, `prunable` flag definition
- https://xtermjs.org/docs/ — Terminal lifecycle, addon API surface
- https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees — worktree UI pattern reference
- Codebase inspection — `execution_handlers.rs`, `worktree_handlers.rs`, `git/mod.rs`, `process/pty.rs`, `db/connection.rs`, `models/worktree.rs`, `Terminal.tsx`, `WorktreeManager.tsx`, `AgentMonitor.tsx`, `ExecutionHistory.tsx` (HIGH confidence — direct source read with line-level references)

### Secondary (MEDIUM confidence)
- https://github.com/tauri-apps/tauri-plugin-fs-watch — confirmed Tauri v1 only, no v2 version exists (repo inspection)

---

*Research completed: 2026-03-29*
*Synthesized by: Claude Code (GSD Research Synthesizer)*
*Ready for roadmap: yes*
