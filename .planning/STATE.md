---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Agents & Worktrees view polish and bug fixes
status: completed
last_updated: "2026-04-02T11:05:42.124Z"
progress:
  total_phases: 1
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
---

# Project State: v1.3 — Agents & Worktrees (ARCHIVED 2026-03-30)

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-29)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control
**Current focus:** Phase 38 — git-commit-features-diff-view

## Current Position

Phase: 38 (git-commit-features-diff-view) — EXECUTING
Plan: 3 of 3

## Performance Metrics

**Velocity:**

- Total plans completed across all phases: 21
- Average duration: 0.118 hours
- Total execution time: 2.46 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 13 | 2 | 0.19h | 0.095h |
| 14 | 4 | 0.46h | 0.115h |
| 15 | 3 | 0.43h | 0.143h |
| 16 | 2 | 0.23h | 0.115h |
| 17 | 2 | 0.33h | 0.165h |
| 17.1 | 4 | 0.52h | 0.130h |
| 18 | 4 | 0.82h | 0.205h |
| 19 | 3+ | 0.16h | 0.053h |

**Recent Trend:**

- Phase 13-01: 0.1h (Bug fixes - clean build, mock code exclusion)
- Phase 13-02: 0.09h (Documentation - pattern reference and code comments)
- Phase 14-01: 0.05h (Tailwind CSS setup - foundation for component styling)
- Phase 14-02: 0.25h (Settings persistence - theme preference model + DB layer + TypeScript types)
- Phase 14-03: 0.07h (ThemeProvider - React context, preload hooks, flash prevention)
- Phase 14-04: 0.08h (Settings UI theme selector - user-facing control with persistence)
- Phase 15-01: 0.16h (shadcn/ui setup - 11 core components, CSS variables, TypeScript aliases)
- Phase 15-02: 0.19h (component migration - TaskSettingsModal, ReviewModal, ApprovalForm, TaskModal, TaskForm to shadcn/ui)
- Phase 15-03: 0.08h (design system - color tokens, typography scale, font loading, WCAG AA compliance)
- Phase 16-01: 0.08h (Kanban board redesign - modern grid layout, status dots, hover effects, Tailwind styling)
- Phase 16-02: 0.15h (Header and navigation - AppHeader tabs, AgentMonitor split-pane, WorktreeManager grid, Settings redesign)
- Phase 17-01: 0.15h (Production build validation - CSS coverage, dark mode persistence, responsive layouts, accent color, visual regression checks)
- Phase 17-02: 0.18h (Accessibility audit - WCAG AA compliance, color contrast fixing, prefers-reduced-motion implementation, keyboard navigation)
- Phase 17.1-01: 0.13h (Production-safe IPC logging - safeInvoke wrapper, ProjectPicker instrumentation, App.tsx logging)
- Phase 17.1-02: 0.12h (Modern header with project dropdown and tab navigation - AppHeader redesign, App.tsx integration, tab routing)
- Phase 17.1-03: 0.06h (System accent color integration - accent color loading in ThemeProvider, CSS variable injection, theme change handling)
- Phase 17.1-04: 0.13h (Playwright visual regression testing - E2E framework, 10 test cases, baseline screenshots, responsive verification)
- Phase 18-01: 0.47h (ProjectConfig and ProjectState models - JSON serialization, save/load methods, cross-platform Path handling)
- Phase 18-02: 0.12h (Project Storage File I/O layer - 6 utility functions, graceful defaults, module integration with db/mod.rs)
- Phase 18-03: 0.10h (Maestro rebranding - tauri.conf.json, Cargo.toml, CLAUDE.md, README.md updated with consistent branding)
- Phase 18-04: 0.13h (IPC Handler Integration - create_project handler initializes .maestro folder on project creation)
- Phase 19-01: 0.07h (Extract Page-Level Components to Views - views directory with 5 orchestrator components, App.tsx updated)
- Phase 19-02: 0.001h (Organize Domain-Grouped Services Layer - centralized IPC wrapper + 6 domain services: task, project, settings, execution, connection)
- Phase 19-03: 0.08h (Organize Reusable Components into Domain-Specific Folders - 5 domain folders, barrel exports, 33 files with updated imports)
- Phase 19-04: 0.16h (Replace Scattered invoke() Calls with Service Layer - 31 IPC calls migrated, 10 components/providers updated, 7 service methods added)
- Phase 19-05: 0.09h (Organize Utils Layer - Hooks and Helpers - src/utils/{hooks,helpers} structure, 4 complex hooks in folders, 3 helpers consolidated, 63 files updated with new imports)
- Phase 20-01: 0.067h (Add TanStack Query Hooks to Task and Project Services - 10 task hooks + 7 project hooks + 2 query key factories, 349 lines added, automatic caching and optimistic updates)
- Phase 20-02: 0.043h (Add TanStack Query Hooks to Execution and Settings Services - 7 execution mutations + 3 settings hooks + 2 query key factories, 205 lines added, Sonner error handling)
- Phase 20-03: 0.055h (Audit and Extend Connection Service with TanStack Query Hooks - 5 new hooks, 176 lines, connection service complete)
- Phase 20-04: 0.048h (Migrate Core Components to TanStack Query Hooks - 3 components (App, ApprovalForm, ReviewModal), 121 new mutation hooks in task.service, Wave 2 begun)
- Phase 20-05: 0.067h (Migrate Kanban Workflow Components to TanStack Query Hooks - 3 components (SyncButton, TaskCard, TaskModal), 2 sync mutations added, 60+ lines state mgmt removed)
- Phase 20-06: 0.042h (Migrate Final Components and Hooks to TanStack Query - 3 components (FilePicker, ImportSettings, useRecentProjects), Wave 2 complete, 9/9 components migrated)
- Phase 20-07: 0.010h (Wave 3 Verification: Verify 0 direct invoke() calls remain, audit hook consistency, validate build, generate completion report - 37 total hooks verified, 2 regressions auto-fixed)
- Phase 21-01: 0.083h (Refactor Components Using Commands Object - 4 new file browser hooks in connection.service, refactored 5 files (ProjectList, ConnectionHeader, FilePicker, SettingsPage, useSshConnectionManager) to service hooks, eliminated all 15 direct commands usages, grep verified 0 remaining)

*Updated after each plan completion*
| Phase 19 P04 | 0.16 | 2 tasks | 12 files |
| Phase 19-05 P05 | 0.09 | 2 tasks | 63 files |
| Phase 20-01 P01 | 0.067 | 2 tasks | 2 files |
| Phase 20-02 P02 | 0.043 | 2 tasks | 2 files |
| Phase 20-03 P03 | 0.055 | 1 task | 1 file |
| Phase 20-04 P04 | 0.048 | 3 tasks | 4 files |
| Phase 20-05 P05 | 0.067 | 3 tasks | 5 files |
| Phase 20-06 P06 | 0.042 | 3 tasks | 5 files |
| Phase 20-07 P07 | 0.010 | 4 tasks | 2 files |
| Phase 21-01 P01 | 0.083 | 8 tasks | 6 files |
| Phase 22-01 P01 | 0.099 | 5 tasks | 2 files |
| Phase 23 P01 | 0.021 | 1 tasks | 2 files |
| Phase 23 P02 | 0.067 | 3 tasks | 6 files |
| Phase 24 P01 | 0.226 | 2 tasks | 4 files |
| Phase 24 P02 | 0.05 | 4 tasks | 8 files |
| Phase 24 P02 | 0.42 | 5 tasks | 12 files |
| Phase 25 P01 | 0.087 | 2 tasks | 7 files |
| Phase 25 P02 | 0.030 | 1 tasks | 1 files |
| Phase 25 P03 | 0.035 | 2 tasks | 3 files |
| Phase 25 P04 | 0.086 | 2 tasks | 3 files |
| Phase 26-agents-view P01 | 0.031 | 2 tasks | 5 files |
| Phase 26-agents-view P02 | 0.033 | 2 tasks | 2 files |
| Phase 27-worktrees-view P01 | 0.036 | 2 tasks | 4 files |
| Phase 27-worktrees-view P02 | 0.019 | 2 tasks | 3 files |
| Phase 27-worktrees-view P03 | 0.044 | 2 tasks | 2 files |
| Phase 28-zombie-cleanup-on-project-open P01 | 0.05 | 2 tasks | 5 files |
| Phase 29 P01 | 0.05 | 2 tasks | 3 files |
| Phase 29 P02 | 0.03 | 2 tasks | 10 files |
| Phase 30 P01 | 0.133 | 2 tasks | 6 files |
| Phase 30 P02 | 0.313 | 2 tasks | 12 files |
| Phase 30 P03 | 0.061 | 2 tasks | 4 files |
| Phase 31 P01 | 0.032 | 2 tasks | 3 files |
| Phase 31 P02 | 0.074 | 2 tasks | 1 files |
| Phase 32 P01 | 0.03 | 2 tasks | 4 files |
| Phase 32 P02 | 0.033 | 2 tasks | 5 files |
| Phase 32 P03 | 0.1 | 2 tasks | 9 files |
| Phase 32 P04 | 0.04 | 2 tasks | 5 files |
| Phase 32 P05 | 0.025 | 2 tasks | 15 files |
| Phase 33 P01 | 0.07 | 2 tasks | 4 files |
| Phase 33 P02 | 0.05 | 2 tasks | 3 files |
| Phase 33 P03 | 0.167 | 2 tasks | 6 files |
| Phase 34-remove-node-sidecar-implement-squash-merge-in-rust P01 | 0.033 | 2 tasks | 2 files |
| Phase 34 P02 | 0.45 | 2 tasks | 9 files |
| Phase 35 P01 | 0.3 | 2 tasks | 9 files |
| Phase 35 P02 | 0.033 | 2 tasks | 2 files |
| Phase 36 P01 | 0.207 | 1 tasks | 3 files |
| Phase 36 P02 | 0.033 | 1 tasks | 2 files |
| Phase 36 P02 | 0.370 | 2 tasks | 3 files |
| Phase 37 P01 | 0.083 | 2 tasks | 5 files |
| Phase 37 P02 | 0.050 | 2 tasks | 4 files |
| Phase 37 P03 | 0.042 | 2 tasks | 3 files |
| Phase 38 P01 | 0.078 | 2 tasks | 6 files |
| Phase 38 P02 | 0.133 | 2 tasks | 3 files |
| Phase 38 P03 | 0.067 | 2 tasks | 2 files |

## Accumulated Context

### Decisions

From v1.1 planning:

- Phase 13 prioritized: Bug fixes must complete before UI work (clean foundation principle) ✓ COMPLETED
- Tailwind 4.1 + @tailwindcss/vite chosen: Official recommendation, 8kB bundle savings, native Vite integration ✓ IMPLEMENTED (14-01)
- shadcn/ui approach: Copy-paste workflow reduces coupling, theme-aware via CSS variables ✓ IMPLEMENTED (15-01)
- System-first theme: Follows OS theme preference (light/dark/auto), respects user's system settings ✓ VARIABLES READY (14-01)
- Design system via CSS variables: Dynamic accent color support (system theme integration) ✓ IMPLEMENTED (14-01)
- Theme preference persistence: AppSettings model + database layer ready for theme provider ✓ IMPLEMENTED (14-02)
- ThemeProvider architecture: React Context API with system theme detection + dual preload (frontend + Tauri) ✓ IMPLEMENTED (14-03)
- Settings UI theme control: ProjectSettingsModal integrated with theme selector, instant switching ✓ IMPLEMENTED (14-04)
- Component library via shadcn/ui: 11 core components installed (Button, Card, Input, Dialog, Badge, Select, Checkbox, Label, Textarea, Tabs, Popover) ✓ IMPLEMENTED (15-01)

Phase 15 Status:

- Phase 15-01: shadcn/ui foundation complete (components, CSS variables, TypeScript aliases) ✓ COMPLETE
- Phase 15-02: Component migration complete (TaskSettingsModal, ReviewModal, ApprovalForm, TaskModal, TaskForm to shadcn/ui) ✓ COMPLETE
- Phase 15-03: Design system complete (HSL color variables, typography scale, font loading, WCAG AA compliance) ✓ COMPLETE

Phase 16 Status:

- Phase 16-01: Kanban board redesign complete (grid layout, status dots, hover effects, animations) ✓ COMPLETE
- Phase 16-02: Header and navigation complete (multi-page routing, split-pane layouts) ✓ COMPLETE

Phase 17 Status:

- Phase 17-01: Production build validation complete (CSS coverage, dark mode, responsive layouts, visual regression analysis) ✓ COMPLETE
- Phase 17-02: Accessibility audit complete (WCAG AA compliance achieved, color contrast fixed, prefers-reduced-motion added) ✓ COMPLETE

Phase 18 Status:

- Phase 18-01: ProjectConfig and ProjectState models complete (JSON serialization with serde, save/load methods, defaults) ✓ COMPLETE
- Phase 18-02: Project Storage File I/O layer complete (6 utility functions, graceful defaults for new projects, cross-platform path handling) ✓ COMPLETE
- Phase 18-03: Maestro rebranding complete (tauri.conf.json, Cargo.toml, CLAUDE.md, README.md updated) ✓ COMPLETE
- Phase 18-04: IPC Handler Integration complete (create_project calls project_storage::create_project_maestro_folder) ✓ COMPLETE

Phase 18 Architecture Decisions:

- Use .maestro folder per-project for settings.json and state.json (instead of global database)
- Wrapper functions for clarity (export_config_to_settings, export_state_to_file) ✓ IMPLEMENTED (18-02)
- Graceful fallback pattern for new projects (return defaults if .maestro doesn't exist) ✓ IMPLEMENTED (18-02)
- Result<T, String> for all file I/O functions (Tauri IPC compatibility) ✓ IMPLEMENTED (18-02)
- [Phase 23]: navigate() discriminated union uses 'key' in target narrowing; same-tab setActiveTab guard prevents slideDirection clobbering
- [Phase 23]: App.tsx owns pendingTaskId consumption since TaskDetail is rendered there; pending entity ID pattern uses effectiveId override approach
- [Phase 24]: Inline DB logic in async IPC commands instead of calling create_project() to avoid State<'_> lifetime issues after .await points
- [Phase 24]: useCreateNewProject.onError does not toast (Create dialog shows inline errors); useCloneProject.onError does toast (git failures are server-side)
- [Phase 24]: Dual-dialog visibility pattern: main dialog hidden via open={open && !showDirPicker} while FilePicker sub-dialog is open, preserving form state
- [Phase 24]: Create dialog shows inline text-destructive errors; Clone dialog uses onError toast — split based on whether error is user-correctable
- [Phase 24]: Browse button uses active SSH connection from ConnectionContext (not hardcoded null) so remote projects browse via SSH
- [Phase 24]: git_init_project, clone_project, create_new_project IPC commands accept connection_id and dispatch to SSH session when remote
- [Phase 25]: Stub worktree_handlers.rs and spawn/resume execution functions with todo!() to keep cargo check green during schema/model migration — Plan 03/04 will rewrite
- [Phase 25]: WorktreeStatus and PoolStatus fully removed from codebase; get_pool_status return type changed to Vec<WorktreeWithStatus> to signal Plan 03 intent
- [Phase 25]: Use tokio::process::Command for all local git operations to avoid blocking the async runtime
- [Phase 25]: get_worktree_status_local does not fail on non-zero exit to handle edge cases like detached HEAD gracefully
- [Phase 25]: git2::Repository inside tokio::task::spawn_blocking for get_worktree_diff; orphan/zombie detection by cross-referencing disk vs DB state; auto-delete stale DB rows in list_worktrees_with_status
- [Phase 25]: spawn_agent_execution and resume_agent_execution call create_worktree_for_task on entry and delete_worktree_for_task in finalization; error paths delete DB row best-effort
- [Phase 25]: list_executions_with_task_info uses LEFT JOIN worktrees so executions with no active worktree still appear after completion cleanup
- [Phase 26-agents-view]: AgentsView owns TanStack Query call; AgentMonitor is a pure display component receiving props
- [Phase 26-agents-view]: detachTerminal .catch(() => {}) suppresses errors when PTY already ended on task completion
- [Phase 26-agents-view]: DeadSessionTerminal never calls attachTerminal/detachTerminal; uses write-only xterm.js with disableStdin:true and writes terminal_output from DB on mount
- [Phase 27-01]: useWorktreesQuery polls at 5s not 2s — worktree status changes less frequently than execution status; reduces git subprocess overhead
- [Phase 27-01]: diff_stat_map populated in same parallel tokio::spawn as status_map — single spawned closure runs git status and git diff --shortstat per worktree
- [Phase 27-02]: WorktreeManager accepts worktrees as props (pure display, matching AgentMonitor pattern)
- [Phase 27-02]: Filter logic: Active=agent_status running, Modified=non-empty git_status, Idle=not running and clean
- [Phase 27-03]: AlertDialogTrigger uses render prop (base-ui pattern) not asChild (Radix); projectId threaded as explicit prop to WorktreeManager; parseDiffString returns DiffFileWithName[] mapped to one DiffViewer per file
- [Phase 28-zombie-cleanup-on-project-open]: Scoped closure pattern for Rust SQLite query to satisfy borrow checker (conn + stmt lifetime)
- [Phase 28-zombie-cleanup-on-project-open]: Silent mutation: onError logs to console but no toast — zombie cleanup is background housekeeping
- [Phase 29]: DiffViewer uses useTheme() for component-level theme resolution; WorktreeManager checks diffLoading first to avoid empty state flash; append_terminal_output uses SQL subquery for UPDATE portability
- [Phase 30]: Filter state lifted to view (AgentsView/WorktreesView) — display components are pure, matching Phase 26 AgentMonitor pattern
- [Phase 30]: canonicalize() applied at IPC boundary in spawn/resume_agent_execution and create_worktree_for_task to fix git repo path bug
- [Phase 30]: Schema V4: execution_logs.task_id nullable (inline FK) to support task-free interactive PTY sessions; create_worktree IPC uses origin_branch + new_branch_name; AgentMonitor selects by execution.id (not task_id) to handle null task_id
- [Phase 30]: Select onValueChange null-coalesce: (v) => setState(v ?? '') because base-ui Select passes string | null
- [Phase 31]: Use project.connection_id (not project.id) as SSH session map key — connection_id is the FK to ssh_connections which is the actual key used on session insert
- [Phase 31]: Shell single-quote all path arguments in SSH commands to handle paths with spaces correctly
- [Phase 31]: parse_worktree_list made pub to allow reuse in remote::list_remote_worktrees without code duplication
- [Phase 31]: Use ? instead of unwrap_or_else for SSH connection in create/delete IPC — fail explicitly to avoid silently operating on wrong path for remote projects
- [Phase 31]: Gate create_dir_all on !is_remote in create_worktree IPC — SSH projects create parent dirs automatically via git worktree add
- [Phase 32]: Use task_id FK join for worktree lookup in review handlers (V5 schema, no status column)
- [Phase 32]: Replace .expect() with map_err+? in all three project insertion sites
- [Phase 32]: poll_remote_log extracted as shared function eliminating 80 lines of duplicated SSH log-polling code between stream_remote_output and attach_remote_stream_listener
- [Phase 32]: resume_agent_execution delegates to spawn_agent_execution with swapped parameter order (resume: task_id second, spawn: project_id second)
- [Phase 32]: get_project_with_git_conn uses ? for both DB lookup and SSH session resolution — call sites needing fallback keep two-step approach
- [Phase 32]: update_task uses Vec<Box<dyn ToSql>> for dynamic params; conn must be mut for transaction(); re-lock after commit to read back
- [Phase 32]: finalize_successful_merge DB writes stay intentionally split across lock acquisitions (async git cleanup between steps)
- [Phase 32]: shell_quote pub so project_handlers.rs can import from crate::git::remote; standardizes SSH path escaping
- [Phase 32]: Zeroizing<String> wraps SSH passwords in AppState and RemoteSshSession; caller API unchanged (pass plain String, wrap internally)
- [Phase 32]: Reconnection race fixed: hold state lock while setting Connecting, drop before async connect(); concurrent callers wait on Connecting state
- [Phase 32]: PTY take_writer() called once in spawn; write_input uses stored writer field — no OS fd clone per keystroke
- [Phase 32]: AppError removed: all IPC handlers return Result<T, String>; error.rs kept as empty comment-only module
- [Phase 32]: ProjectConfigRequest kept as separate struct (not aliased) — type aliases cannot carry #[derive(TS)] / #[specta(export)]
- [Phase 32]: upsert_imported_tasks extracted as private fn: both GitHub/Jira sync functions share identical DB upsert logic
- [Phase 32]: stop_remote_stream now calls kill_remote_process (was a no-op Ok(()) previously)
- [Phase 33]: INSERT OR REPLACE handles UNIQUE(task_id) constraint on task_reviews — CASCADE-deletes old review_comments automatically
- [Phase 33]: finalize_successful_merge resolves git_conn internally (no repo_path param) — cleaner separation of concerns
- [Phase 33]: Branch deletion stays as inline tokio::process::Command (non-fatal) since git dispatcher has no delete_branch
- [Phase 33]: register_project_in_db uses IS ? for nullable column comparison to fix SQLite NULL semantics bug
- [Phase 33]: finalize_ssh_connection early-return path keeps inline DB update; only fresh-auth path uses the helper
- [Phase 33]: get_worktree_diff uses JOIN projects p ON p.id = w.project_id — one DB round-trip instead of two sequential lock acquisitions
- [Phase 33]: error.rs deleted (comment-only stub); mod error removed from lib.rs — empty modules add noise with no benefit
- [Phase 33]: All Rust diagnostic output uses log::info!/warn!/debug! — zero println!/eprintln! remain in the backend
- [Phase 34-remove-node-sidecar-implement-squash-merge-in-rust]: squash_merge_to_main is pub but not dispatched through GitConnection — worktrees are always local even for remote projects, so squash merge always runs on local repo path
- [Phase 34-remove-node-sidecar-implement-squash-merge-in-rust]: Do not check output.status.success() after git merge --squash --no-commit — non-zero exit is expected on conflicts, handled by subsequent git status --porcelain
- [Phase 34-remove-node-sidecar-implement-squash-merge-in-rust]: MergeOutcome removed from review_handlers.rs — no longer needed after eliminating sidecar JSON parsing; type remains in models/merge_outcome.rs for deletion in Plan 02
- [Phase 34]: retry_execution and resume_agent_execution updated to reset execution log status rather than calling the deleted spawn_agent_execution IPC
- [Phase 34]: useSpawnExecutionMutation deprecated with informative throw; boardStore.executeTask throws informative error — preserves API surface for caller discovery
- [Phase 35]: run_git_in_dir dispatcher handles local TokioCommand and remote SSH execute_command — follows existing GitConnection pattern
- [Phase 35]: DiffTarget enum: Head=git diff HEAD (uncommitted), Branch(name)=git diff --unified=6 origin/{name}..HEAD (full branch diff)
- [Phase 35]: list_worktrees_with_status runs status+diff_stat for both local and remote worktrees (removed is_remote gate)
- [Phase 35]: Use onPressedChange (base-ui Toggle API) instead of onClick for ToggleGroupItem pressed state control
- [Phase 35]: diffBranch pre-populated from selectedWorktree.branch_name via useEffect; Branch mode always attempts diff even with clean working tree
- [Phase 36]: status field is optional on DiffFileWithName — parseDiffString always sets it, but type flexibility preserved for manual construction
- [Phase 36]: computeFileStats self-guards against +++ / --- lines — does not assume they are pre-stripped by the caller
- [Phase 36]: Always use DiffTarget::Head in WorktreeManager — diff target toggle removed; branch diff added unnecessary UI complexity without sufficient value
- [Phase 36]: Module-level DIFF_TARGET_HEAD constant outside component avoids query key object recreation on every render (stable reference)
- [Phase 36]: Split selection reset into two effects: worktreeId clears immediately; diffFiles auto-selects first only when nothing selected — prevents background refetch from bouncing user off chosen file
- [Phase 36]: useWorktreeDiffQuery gets refetchInterval:5000 to match worktree list polling so diff body stays live
- [Phase 36]: File list items use single flex row with inline stats (no second row for +/- stats)
- [Phase 37]: Schema V6: base_branch TEXT nullable column added via drop-and-recreate migration; AheadBehind uses named struct for specta TS compatibility; create_worktree_for_task stores NULL; rev-list failure yields None silently
- [Phase 37]: WorktreeCard accesses ahead_behind.ahead and .behind as named struct fields not tuple index
- [Phase 37]: parseDiffStat copied into WorktreeCard.tsx for self-contained card; STATUS_FILTERS/StatusFilter defined locally in WorktreesView
- [Phase 37]: Delete dialog uses pendingDeleteId separate from selectedWorktreeId to avoid coupling card selection and delete trigger
- [Phase 37]: Slide container pattern: outer overflow-hidden, inner w-[200%] flex row, each screen w-1/2, -translate-x-1/2 on selection
- [Phase 37]: WorktreeDiffPanel renders null when worktree===null (mounted for CSS slide animation, invisible until worktree selected)
- [Phase 37]: Unified/split toggle moved to action bar in WorktreeDiffPanel — single consistent control position, per-file header shows filename+status+stats only
- [Phase 38]: Write patch to temp file before git apply --cached — run_git_in_dir has no stdin support
- [Phase 38]: discard_worktree_changes: git reset HEAD then git checkout -- two-step required for staged files
- [Phase 38]: CheckboxPrimitive.Root used directly (not Checkbox wrapper) to access indeterminate prop for tri-state file checkboxes
- [Phase 38]: FileTree checkedFiles/onToggleFile props optional; checkboxes only render when both provided — backward compatible
- [Phase 38]: Use hunk summary strip (fallback) above DiffView — @git-diff-view/react has no dedicated hunk header render slot
- [Phase 38]: AlertDialogTrigger/PopoverTrigger use render= prop (base-ui pattern); hunk selection props skipped when whole file staged

### Pending Todos

1. **Fix get_worktree_diff and list_worktrees for remote projects** — `get_worktree_diff` uses git2 locally (broken for SSH projects); per-worktree status/diff-stat in `list_worktrees` is silently skipped for remote. Both need SSH dispatch. Files: `worktree_handlers.rs:103-137,225`, `git/remote.rs`

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260330-khs | move spawn agent button to top of list and rename to New Session | 2026-03-30 | b9ec20f | [260330-khs-move-spawn-agent-button-to-top-of-list-a](./quick/260330-khs-move-spawn-agent-button-to-top-of-list-a/) |
| 260330-tb8 | fix Worktrees and Agents view bugs (cleanup modal, stale branches, delete/reconnect, interactive PTY) | 2026-03-30 | 91c459b | [260330-tb8-fix-worktrees-and-agents-view-bugs](./quick/260330-tb8-fix-worktrees-and-agents-view-bugs/) |
| 260331-d7x | search in backend code usage of git commands and list them | 2026-03-31 | — | [260331-d7x-search-in-backend-code-usage-of-git-comm](./quick/260331-d7x-search-in-backend-code-usage-of-git-comm/) |
| 260401-csx | Revert Rust logging from log crate back to console prints | 2026-04-01 | 2b4776d | [260401-csx-revert-rust-logging-from-log-crate-back-](./quick/260401-csx-revert-rust-logging-from-log-crate-back-/) |
| 260401-is7 | Add unified/split view toggle in git diff pane | 2026-04-01 | aad4dfd | [260401-is7-add-unified-and-split-view-toggle-in-git](./quick/260401-is7-add-unified-and-split-view-toggle-in-git/) |
| 260401-tau | Fix 3 post-phase-37 UI issues: gate diff pane on dirty status, slide action bar, center branch name | 2026-04-01 | 7eb166b | [260401-tau-fix-3-post-phase-37-ui-issues-diff-pane-](./quick/260401-tau-fix-3-post-phase-37-ui-issues-diff-pane-/) |
| 260402-ctz | Add group/grid toggle to worktrees view action bar | 2026-04-02 | 72c638b | [260402-ctz-in-the-worktrees-view-add-a-group-toggle](./quick/260402-ctz-in-the-worktrees-view-add-a-group-toggle/) |
| 260402-d3x | add branch deletion checkbox to worktree removal modal | 2026-04-02 | db61a9b | [260402-d3x-add-branch-deletion-checkbox-to-worktree](./quick/260402-d3x-add-branch-deletion-checkbox-to-worktree/) |

### Blockers/Concerns

**COMPLETE - Phase 17.1 FULLY COMPLETE (2026-02-11):**

- ✓ Phase 17.1-01 COMPLETE: Production IPC logging infrastructure
  - safeInvoke wrapper created with [Tauri] console logging
  - ProjectPicker instrumented with [DEBUG] statements
  - App.tsx instrumented with [DEBUG] statements
- ✓ Phase 17.1-02 COMPLETE: Modern header with project dropdown and tab navigation
  - AppHeader redesigned with project dropdown (Select component)
  - 4-tab navigation for Tasks, Agents, Worktrees, Settings
  - Tab-based page routing in App.tsx (activePage state)
  - All icons from lucide-react, modern flex layout (h-12)
  - Inline project switching without full-screen modal
- ✓ Phase 17.1-03 COMPLETE: System accent color integration
  - Accent color loaded from system theme in ThemeProvider
  - CSS variables injected dynamically on mount
  - Theme changes update accent color in real-time
- ✓ Phase 17.1-04 COMPLETE: Playwright visual regression testing
  - E2E framework configured with dev server integration
  - 10 visual regression tests covering major UI elements
  - Baseline screenshots established for ProjectPicker, layouts, viewports
  - Automated CLS and DOM stability verification
  - Test infrastructure ready for regression detection (pnpm test:e2e)

**Phase 17.1 Impact Summary:**

- ✓ UI now has modern aesthetic matching exemple/ design patterns
- ✓ UX improved: Project switching from header dropdown instead of full-screen modal
- ✓ Navigation: Compact tab bar with icons and active state styling
- ✓ System accent color integration complete: Dynamic theme-aware accent color injection
- ✓ Visual regression testing infrastructure: Automated baseline capture and regression detection
- Phase 17.1 milestone complete; all 4 plans executed successfully

### Roadmap Evolution

- Phase 17.1 inserted after Phase 17: Critical UI Fixes (URGENT) - Fix production folder selection, implement slick UX patterns from exemple/ (not pixel-perfect copy), use system accent color, verify with Playwright screenshots
- Phase 18 added: Maestro Folder Architecture & Rebranding - Migrate from database-centric to project-local .maestro folder storage; rebrand from "GSD Orchestrator" to "Maestro"
- Phase 19 added: Frontend Architecture Refactoring - Reorganize src/ to follow standard project structure with views/, services/, and grouped components
- Phase 20 added: Refactor Frontend to use TanStack Query - Replace direct invoke() calls with TanStack Query hooks for data fetching, caching, and mutations
- Phase 21 added: Refactor Components Using Commands Object - Refactor any component using directly "commands" object from @src/types/bindings.ts to use service hooks instead
- Phase 22 added: Auto-remove Stale Projects - get_connection_projects made async, drops db lock before path validation, collect_stale_project_ids helper validates local (std::fs) and SSH (test -d) paths
- Phase 23 added: Add in-app routing for deep linking to specific screens
- Phase 24 added: Improve project picker screen — auto-detect and init git on select, Clone Project button (git URL + target path), Create Project button (name + target path + git init)
- Phase 25 added: Backend Overhaul — worktree/execution backend rewrite for v1.3 Agents & Worktrees milestone
- Phase 26 added: Agents View — AgentsView with xterm.js terminal, active + history list, split-pane layout
- Phase 27 added: Worktrees View — WorktreesView with git diff panel, status filtering, zombie detection
- Phase 28 added: Zombie Cleanup on Project Open — auto-cleanup orphaned worktrees on project load
- Phase 29 added: v1.3 Agents & Worktrees view polish and bug fixes
- Phase 31 added: Fix remote SSH worktree bugs: git ops, origin branch detection, and worktree path filtering
- Phase 30 added: v1.3 post-testing UI and worktree bug fixes
- Phase 32 added: Backend code quality: fix all findings from code review
- Phase 33 added: tauri backend code review and refactoring for maintainability DRY SOLID KISS
- Phase 34 added: Remove Node.js sidecar — implement squash merge in Rust (local + SSH)
- Phase 36 added: Redesign the diff pane in the worktrees view (uncommitted-only default, unified/split toggle, file selector)
- Phase 37 added: Redesign the worktrees view with card grid and slide-in diff panel
- Phase 38 added: Add git commit features to the diff view — file selection with tri-state checkboxes, revert/shelve/commit actions, block-level staging from diff pane

## Session Continuity

Current session: 2026-03-16 (Phase 22-01 executed)
Completed: Phase 22-01 - Validate Project Paths in get_connection_projects (Local + SSH) (COMPLETE)
Status: Phase 22 complete; 22/23 phases complete
Session timestamp: 2026-03-16T15:29:00Z

---

**v1.1 MILESTONE STATUS: IN PROGRESS**
**Phase 19 STATUS: IN PROGRESS (5/6 plans complete)**

v1.1 UI/UX Polish milestone - 18 of 19 phases complete + Phase 19 architecture refactoring underway.
Phase 19-05 (Organize Utils Layer - Hooks and Helpers) COMPLETE 2026-02-26.

**Phase 19 Plan Status:**

- 19-01: COMPLETE - Extract Page-Level Components to Views
- 19-02: COMPLETE - Organize Domain-Grouped Services Layer
- 19-03: COMPLETE - Organize Reusable Components into Domain-Specific Folders
- 19-04: COMPLETE - Replace Scattered invoke() Calls with Service Layer
- 19-05: COMPLETE - Organize Utils Layer (Hooks and Helpers)
- 19-06: PENDING - Implement Feature Modules

Phase 18 (Maestro Folder Architecture & Rebranding) complete:

- ✓ 18-01: ProjectConfig and ProjectState models with JSON serialization (COMPLETE)
  - Rust models with load/save methods for .maestro/settings.json and .maestro/state.json
  - TypeScript bindings generated and available at src/types/bindings.ts
  - Cross-platform path handling using std::path::Path
  - Backward compatibility with #[serde(default)] for schema versioning
- ✓ 18-02: Project Storage File I/O layer (COMPLETE)
  - 6 utility functions for file I/O operations
  - Graceful defaults for new projects
  - Module integration with db/mod.rs
- ✓ 18-03: Maestro rebranding (COMPLETE)
  - tauri.conf.json: productName, identifier, window title updated to Maestro
  - Cargo.toml description updated with Maestro branding
  - CLAUDE.md and README.md updated with new application branding
  - Technical identifiers (maestro, .planning/) maintained for backwards compatibility
- ✓ 18-04: IPC Handler Integration (COMPLETE)
  - create_project IPC handler now calls project_storage::create_project_maestro_folder()
  - .maestro folder initialized on project creation with error handling
  - Integration tested with cargo check

**Phase 18 VERIFIED:** All 4 success criteria met (verified 2026-02-23). Architecture shift complete: project-local storage established, rebranding complete, all integration points wired.

**Phase 19 Status - IN PROGRESS:**

- Phase 19-01 COMPLETE (2026-02-26): Extract Page-Level Components to Views
  - Views directory created with 5 orchestrator components
  - KanbanView, AgentsView, SettingsView, ProjectPickerView, WorktreesView
  - Barrel export src/views/index.ts working
  - App.tsx updated to import from @/views
  - TypeScript compilation: 0 errors, build successful
  - All routing and navigation working correctly

- Phase 19-02 COMPLETE (2026-02-26): Organize Domain-Grouped Services Layer
  - Centralized IPC wrapper created (src/services/ipc.ts)
  - 6 domain-specific services created: task, project, settings, execution, connection
  - All services follow consistent pattern with typed methods
  - Barrel export (src/services/index.ts) enables single import for all services
  - Production build passed: 3286 modules transformed, CSS coverage verified
  - Ready for integration with components and stores

- Phase 19-03 COMPLETE (2026-02-26): Organize Reusable Components into Domain-Specific Folders
  - 5 domain folders verified: kanban, project, task, execution, common
  - Barrel exports (index.ts) configured for each domain
  - 33 files updated with new domain-based import paths
  - All imports refactored: App.tsx, views, components, stores
  - Cross-folder imports fixed with proper relative/absolute paths
  - TypeScript compilation: 0 errors
  - Production build verified: CSS coverage verified, no mock code
  - Component organization complete: clear separation of concerns established

*State initialized: 2026-02-09*
*Updated: 2026-02-26 — Phase 19-03 complete (Component organization refactoring); 3/6 plans complete (50%)*

- Phase 19-04 COMPLETE (2026-02-26): Replace Scattered invoke() Calls with Service Layer
  - 31 IPC calls migrated from components/providers to service layer
  - 10 components and providers updated with service layer imports
  - 7 service methods added/enhanced in src/services
  - Centralized error handling and logging through services
  - Type-safe IPC integration via service abstraction
  - All components using consistent service-layer patterns

- Phase 19-05 COMPLETE (2026-02-26): Organize Utils Layer (Hooks and Helpers)
  - src/utils/{hooks,helpers} folder structure created
  - 4 complex hooks organized in individual folders: useProjectPickerNavigation, useRecentProjects, useSshConnectionManager, useSshConnectionsQuery
  - 1 simple hook kept as single file: use-mobile.ts
  - 3 helpers consolidated: path-utils.ts, diff-utils.ts, ui-utils.ts
  - Barrel exports created for hooks/, helpers/, and root utils/
  - 63 files updated with new @/utils/hooks and @/utils/helpers import paths
  - Old src/hooks/ and src/lib/ directories removed
  - TypeScript compilation: 0 errors
  - All imports verified: 0 old @/hooks or @/lib imports remaining

*Updated: 2026-02-26 — Phase 19-05 complete (Utils layer organization); 5/6 plans complete (83%)*

**Phase 20 Status - IN PROGRESS:**

- Phase 20-01 COMPLETE (2026-02-26): Add TanStack Query Hooks to Task and Project Services
  - 10 TanStack Query hooks added to task.service.ts (useTasksQuery, useExecutionLogsQuery, useTaskSettingsQuery, useDiffForReviewQuery, useCreateTaskMutation, useUpdateTaskMutation, useUpdateTaskStatusMutation, useRetryExecutionMutation, useCancelExecutionMutation, useUpdateTaskSettingsMutation)
  - 7 TanStack Query hooks added to project.service.ts (useProjectsQuery, useProjectQuery, useProjectSettingsQuery, useCreateProjectMutation, useRemoveProjectMutation, useUpdateProjectSettingsMutation, useSaveImportConfigMutation)
  - taskQueryKeys and projectQueryKeys factories for consistent cache invalidation
  - All hooks with proper enabled conditions for dependent queries
  - useUpdateTaskStatusMutation implements optimistic updates with rollback
  - All mutations use queryClient.invalidateQueries() for cache consistency
  - Sonner integration for error/success feedback
  - Build verified: 0 TypeScript errors, production bundle passed
  - 349 lines added to 2 files, 2 tasks complete

- Phase 20-02 COMPLETE (2026-02-26): Add TanStack Query Hooks to Execution and Settings Services
  - 7 TanStack Query mutation hooks added to execution.service.ts (useSpawnExecutionMutation, usePauseExecutionMutation, useResumeExecutionMutation, useAttachTerminalMutation, useDetachTerminalMutation, useSendTerminalInputMutation, useResizeTerminalMutation)
  - 3 TanStack Query hooks added to settings.service.ts (useSettingsQuery with 10-min staleTime, useSystemAccentColorQuery with Infinity staleTime, useSaveSettingsMutation)
  - executionQueryKeys and settingsQueryKeys factories for consistency
  - All execution mutations are fire-and-forget RPC side-effects with onError toast handling
  - Settings queries tuned for data volatility (10min for app settings, Infinity for OS accent color)
  - useSaveSettingsMutation invalidates cache and shows success/error toast
  - Build verified: 0 TypeScript errors, production bundle passed
  - 205 lines added to 2 files, 2 tasks complete
  - Wave 1 infrastructure: 21 total hooks created (task 10 + project 7 + execution 7 + settings 3)

- Phase 20-03 COMPLETE (2026-02-27): Audit and Extend Connection Service with TanStack Query Hooks
  - Audited connection.service.ts and identified missing TanStack Query hooks
  - Added connectionQueryKeys factory (nested query key structure)
  - Added useSshConnectionsQuery() for fetching all SSH connections (30s staleTime)
  - Added useCreateSshConnectionMutation() for creating SSH connections
  - Added useUpdateSshConnectionMutation() with optimistic updates for renaming
  - Added useDeleteSshConnectionMutation() for deleting connections
  - Added useForgetSavedPasswordMutation() for forgetting saved passwords
  - All mutations have Sonner toast error/success feedback
  - Verified exemplar pattern (useSshConnectionsQuery.ts) as working reference
  - Build verified: 0 TypeScript errors, production bundle passed
  - 176 lines added to 1 file, 1 task complete
  - Wave 1 infrastructure complete: 32 total hooks across 5 services

*Updated: 2026-02-27 00:07 — Phase 20-03 complete (Connection Service TanStack Query hooks); 3/7 plans complete (43%)*

- Phase 20-04 COMPLETE (2026-02-27): Migrate Core Components to TanStack Query Hooks (Wave 2)
  - Migrated App.tsx from direct invoke() to useSettingsQuery hook
  - Removed manual useState for settings, loading/error states managed by TanStack Query
  - Migrated ApprovalForm.tsx to use 3 new mutation hooks: useSaveTaskReviewMutation, useApproveTaskAndMergeMutation, useRequestChangesMutation (Rule 2 deviation)
  - Migrated ReviewModal.tsx from direct invoke() to useDiffForReviewQuery hook
  - All components now delegate loading/error state management to TanStack Query
  - Sonner toast integration for all error/success feedback
  - Build verified: 0 TypeScript errors, production bundle passed
  - 121 lines added to task.service.ts for mutation hooks
  - 3 core foundation components migrated, 3 new mutation hooks added
  - Wave 2 component migrations begun: 3/7 components complete

*Updated: 2026-02-27 00:11 — Phase 20-04 complete (Core Component migrations); 4/7 plans complete (57%)*

- Phase 20-05 COMPLETE (2026-02-27): Migrate Kanban Workflow Components to TanStack Query Hooks (Wave 2)
  - Migrated SyncButton.tsx from direct invoke() to useSyncGithubIssuesMutation and useSyncJiraIssuesMutation hooks
  - Added 2 sync mutation hooks to project.service.ts with automatic error/success toast handling
  - Migrated TaskCard.tsx from manual useEffect + invoke() to useExecutionLogsQuery hook
  - Removed 15 lines of state management from TaskCard for execution logs
  - Migrated TaskModal.tsx from direct invoke() to useCreateTaskMutation hook
  - Replaced showErrorToast/showSuccessToast with direct sonner toast calls throughout
  - All 3 components now use TanStack Query for state and loading management
  - Build verified: 0 TypeScript errors, production bundle passed
  - 78 lines added to project.service.ts for sync mutations
  - 60+ lines of manual state management code removed
  - Wave 2 component migrations: 6/7 components complete
  - Rule 1 deviation: Fixed SyncButton import_provider type mismatch by accepting provider as prop

*Updated: 2026-02-27 00:30 — Phase 20-05 complete (Kanban Component migrations); 5/7 plans complete (71%)*

- Phase 20-06 COMPLETE (2026-02-27): Migrate Final Components and Hooks to TanStack Query (Wave 2)
  - Migrated FilePicker.tsx from direct invoke() to useMutation hooks (file operations)
  - Migrated ImportSettings.tsx to project.service mutation hooks (sync and config save)
  - Refactored useRecentProjects.ts from useState to useQuery hook pattern
  - All 9 Wave 2 components now complete (3+3+3 migrations)
  - Connection service, Project service, Settings service all fully integrated
  - Build verified: 0 TypeScript errors, production bundle passed
  - 3 commits, 5 files modified, 0.042h duration
  - Wave 2 infrastructure complete: All component direct invoke() calls replaced with TanStack Query hooks

*Updated: 2026-02-27 00:46 — Phase 20-06 complete (Final component migrations); 6/7 plans complete (86%)*

- Phase 20-07 COMPLETE (2026-02-27): Wave 3 Verification and Sign-Off
  - Task 1: Verify no direct invoke() calls remain in UI layer
    - Found 2 hook regressions with direct Tauri invoke() calls
    - Auto-fixed both hooks (useSshConnectionsQuery, useSshConnectionManager)
    - Result: 0 direct invoke() in components, 0 direct invoke() in hooks
  - Task 2: Verify TanStack Query hook consistency
    - ✓ 5/5 query key factories present across services
    - ✓ 6 dependent queries using enabled conditions
    - ✓ 17 cache invalidation calls across mutations
    - ✓ 2 optimistic update mutations (status + SSH connection rename)
  - Task 3: Verify application builds and runs
    - ✓ Build succeeded in 17.03s
    - ✓ TypeScript: 0 errors
    - ✓ Production bundle verified (CSS coverage OK, no mock code)
  - Task 4: Generate Phase 20 completion report
    - Created 20-COMPLETION-REPORT.md with full metrics and recommendations
    - Documented all 3 waves, 37 hooks, 9 components migrated
    - Sign-off: Phase ready for Phase 21 or production
  - Commits: 3 (fix regression + completion report + summary)
  - Duration: 0.010h (6 minutes)
  - Wave 3 complete: All verification tasks passed, Phase 20 ready for sign-off

*Updated: 2026-02-27 00:55 — Phase 20-07 COMPLETE (Wave 3 verification); 7/7 plans complete (100%)*

**PHASE 20 COMPLETE** ✓

- Wave 1 (Infrastructure): 21 hooks created across 5 services (3 plans)
- Wave 2 (Component Migration): 9 UI components migrated (3 plans)
- Wave 3 (Verification): 0 regressions, production validated (1 plan)
- Total: 37 TanStack Query hooks, 0 direct invoke() calls, ready for Phase 21

**PHASE 21 COMPLETE** ✓ (2026-02-28)

- Task 1: Extended connection.service.ts with 4 new file browser hooks
- Task 2: Verified project.service.ts has all required hooks
- Task 3: Refactored ProjectList.tsx to use service hooks
- Task 4: Refactored ConnectionHeader.tsx to use service hooks
- Task 5: Refactored FilePicker.tsx to use service hooks
- Task 6: Refactored SettingsPage.tsx to use service hooks
- Task 7: Refactored useSshConnectionManager.ts to use service hooks
- Task 8: Comprehensive verification - 0 direct commands usage, TypeScript clean, build passes
- Total: 5 components refactored, 15 command usages eliminated, service layer complete
- Metrics: 0.083h duration, 8 commits, 6 files modified, 0 deviations
